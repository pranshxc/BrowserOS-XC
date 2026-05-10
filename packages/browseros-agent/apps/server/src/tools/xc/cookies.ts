/**
 * XC Phase 3 — Cookie Inspector
 *
 * Full read/write access to browser cookies via CDP Network domain.
 * All operations go through the per-page CDP session so they respect
 * the page's origin context.
 *
 * Tools exported:
 *   get_cookies             — list cookies, optionally filtered by domain/URL
 *   set_cookie              — create or overwrite a single cookie
 *   delete_cookie           — remove a cookie by name + domain
 *   clear_all_cookies       — nuclear option: wipe all cookies visible to a page
 *   import_cookies_from_curl — parse a raw curl -b / Cookie: header string into cookies
 */

import { homedir } from 'node:os'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')
const defineXcInputTool = defineToolWithCategory('input')

// ── Shared cookie shape ──────────────────────────────────────────────────────

const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional().describe('Unix timestamp, -1 = session'),
  size: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  session: z.boolean().optional(),
  sameSite: z.string().optional(),
})

type Cookie = z.infer<typeof CookieSchema>

// ── get_cookies ──────────────────────────────────────────────────────────────

export const get_cookies = defineXcTool({
  name: 'get_cookies',
  description:
    'List cookies accessible to a page. Optionally filter by domain or URL. ' +
    'Returns name, value, domain, path, httpOnly, secure, sameSite, and expiry.',
  input: z.object({
    page: pageParam,
    url: z
      .string()
      .optional()
      .describe('Filter to cookies matching this URL (e.g. https://example.com)'),
  }),
  output: z.object({
    cookies: z.array(CookieSchema),
    count: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}. Navigate to a page first.`)
      return
    }

    await session.Network.enable({})

    const result = args.url
      ? await session.Network.getCookies({ urls: [args.url] })
      : await session.Network.getCookies({})

    const cookies = (result.cookies ?? []) as Cookie[]

    if (cookies.length === 0) {
      response.text('No cookies found.')
      response.data({ cookies: [], count: 0 })
      return
    }

    const lines = cookies.map(
      (c) =>
        `${c.name}=${c.value.slice(0, 80)}${c.value.length > 80 ? '…' : ''} [domain=${c.domain ?? ''} path=${c.path ?? '/'} httpOnly=${c.httpOnly ?? false} secure=${c.secure ?? false}]`,
    )
    response.text(`${cookies.length} cookie(s):\n${lines.join('\n')}`)
    response.data({ cookies, count: cookies.length })
  },
})

// ── set_cookie ───────────────────────────────────────────────────────────────

export const set_cookie = defineXcInputTool({
  name: 'set_cookie',
  description:
    'Create or overwrite a single cookie. Useful for injecting auth tokens, ' +
    'session IDs, or feature flags without going through a login flow.',
  input: z.object({
    page: pageParam,
    name: z.string().describe('Cookie name'),
    value: z.string().describe('Cookie value'),
    domain: z.string().optional().describe('Cookie domain (e.g. .example.com)'),
    path: z.string().default('/').describe('Cookie path'),
    secure: z.boolean().default(false).describe('Secure flag'),
    httpOnly: z.boolean().default(false).describe('HttpOnly flag'),
    sameSite: z
      .enum(['Strict', 'Lax', 'None'])
      .optional()
      .describe('SameSite policy'),
    expiresUnix: z
      .number()
      .optional()
      .describe('Expiry as Unix timestamp. Omit for session cookie.'),
  }),
  output: z.object({
    success: z.boolean(),
    name: z.string(),
    domain: z.string().optional(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Network.enable({})

    const params: Record<string, unknown> = {
      name: args.name,
      value: args.value,
      path: args.path,
      secure: args.secure,
      httpOnly: args.httpOnly,
    }
    if (args.domain) params.domain = args.domain
    if (args.sameSite) params.sameSite = args.sameSite
    if (args.expiresUnix !== undefined) params.expires = args.expiresUnix

    // If no domain, use the current page URL as the source URL
    if (!args.domain) {
      const info = ctx.browser.getPageInfo(args.page)
      if (info?.url) params.url = info.url
    }

    await session.Network.setCookie(params as Parameters<typeof session.Network.setCookie>[0])

    response.text(`Cookie "${args.name}" set${args.domain ? ` on ${args.domain}` : ''}.`)
    response.data({ success: true, name: args.name, domain: args.domain })
  },
})

// ── delete_cookie ────────────────────────────────────────────────────────────

export const delete_cookie = defineXcInputTool({
  name: 'delete_cookie',
  description: 'Delete a specific cookie by name. Provide domain to be precise.',
  input: z.object({
    page: pageParam,
    name: z.string().describe('Cookie name to delete'),
    domain: z.string().optional().describe('Cookie domain'),
    path: z.string().default('/').describe('Cookie path'),
  }),
  output: z.object({ deleted: z.boolean(), name: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Network.enable({})

    const params: Record<string, unknown> = { name: args.name, path: args.path }
    if (args.domain) params.domain = args.domain

    await session.Network.deleteCookies(params as Parameters<typeof session.Network.deleteCookies>[0])

    response.text(`Deleted cookie "${args.name}"${args.domain ? ` from ${args.domain}` : ''}.`)
    response.data({ deleted: true, name: args.name })
  },
})

// ── clear_all_cookies ────────────────────────────────────────────────────────

export const clear_all_cookies = defineXcInputTool({
  name: 'clear_all_cookies',
  description:
    'Delete ALL cookies visible to a page. Use before load_auth_state to ensure ' +
    'a clean slate, or to simulate a logged-out state.',
  input: z.object({ page: pageParam }),
  output: z.object({ cleared: z.number() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Network.enable({})

    const before = await session.Network.getCookies({})
    const count = (before.cookies ?? []).length

    await session.Network.clearBrowserCookies()

    response.text(`Cleared ${count} cookie(s).`)
    response.data({ cleared: count })
  },
})

// ── import_cookies_from_curl ─────────────────────────────────────────────────

/**
 * Parse a raw curl Cookie header string or a `-b 'name=val; name2=val2'` snippet.
 * Handles both formats:
 *   Cookie: session=abc; csrf=xyz
 *   -b 'session=abc; csrf=xyz'
 *   session=abc; csrf=xyz
 */
function parseCurlCookieString(raw: string): Array<{ name: string; value: string }> {
  let cleaned = raw.trim()

  // Strip "Cookie:" prefix
  if (/^cookie:/i.test(cleaned)) {
    cleaned = cleaned.replace(/^cookie:/i, '').trim()
  }

  // Strip curl -b '...' or -b "..."
  const curlMatch = /^-b\s+['"]?(.+?)['"]?$/.exec(cleaned)
  if (curlMatch) cleaned = curlMatch[1]

  return cleaned
    .split(';')
    .map((part) => {
      const eqIdx = part.indexOf('=')
      if (eqIdx === -1) return null
      return {
        name: part.slice(0, eqIdx).trim(),
        value: part.slice(eqIdx + 1).trim(),
      }
    })
    .filter((c): c is { name: string; value: string } => c !== null && c.name.length > 0)
}

export const import_cookies_from_curl = defineXcInputTool({
  name: 'import_cookies_from_curl',
  description:
    'Parse a raw Cookie header or curl -b string and set all cookies on the page. ' +
    'Paste the Cookie: line from browser DevTools or a curl command directly. ' +
    'Example input: "Cookie: session=abc; csrf=xyz" or "-b \'session=abc; csrf=xyz\'"',
  input: z.object({
    page: pageParam,
    raw: z
      .string()
      .describe('Raw Cookie header value or curl -b string to parse'),
    domain: z
      .string()
      .optional()
      .describe(
        'Domain to set cookies on (e.g. .example.com). Defaults to current page domain.',
      ),
  }),
  output: z.object({
    imported: z.number(),
    cookies: z.array(z.object({ name: z.string(), value: z.string() })),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Network.enable({})

    const parsed = parseCurlCookieString(args.raw)
    if (parsed.length === 0) {
      response.error('Could not parse any cookies from the provided string.')
      return
    }

    const info = ctx.browser.getPageInfo(args.page)
    const urlFallback = info?.url

    for (const cookie of parsed) {
      const params: Record<string, unknown> = {
        name: cookie.name,
        value: cookie.value,
        path: '/',
      }
      if (args.domain) {
        params.domain = args.domain
      } else if (urlFallback) {
        params.url = urlFallback
      }
      await session.Network.setCookie(params as Parameters<typeof session.Network.setCookie>[0])
    }

    const names = parsed.map((c) => c.name).join(', ')
    response.text(`Imported ${parsed.length} cookie(s): ${names}`)
    response.data({ imported: parsed.length, cookies: parsed })
  },
})
