/**
 * XC Phase 4 — Dialog Handling
 *
 * Provides visibility and control over JavaScript dialogs (alert, confirm,
 * prompt, beforeunload) which are otherwise invisible to the agent.
 *
 * Architecture
 * ────────────
 * DialogMonitor is a per-page singleton that:
 *   1. Attaches a CDP Page.javascriptDialogOpening listener on first use
 *   2. Stores the last dialog state in memory
 *   3. Optionally auto-accepts alerts / beforeunload dialogs based on
 *      BROWSEROS_XC_AUTO_DIALOG env var (comma-separated: "alert,beforeunload")
 *
 * Tools exported:
 *   get_dialog_status     — returns { isOpen, type, message, url }
 *   dialog_accept         — accepts the open dialog (optionally with prompt text)
 *   dialog_dismiss        — dismisses (cancels) the open dialog
 *   configure_auto_dialog — update auto-accept policy at runtime
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')
const defineXcInputTool = defineToolWithCategory('input')

// ── DialogMonitor ─────────────────────────────────────────────────────────────

interface DialogState {
  isOpen: boolean
  type: string
  message: string
  url: string
  defaultPrompt: string
}

const EMPTY_STATE: DialogState = {
  isOpen: false,
  type: '',
  message: '',
  url: '',
  defaultPrompt: '',
}

/**
 * Auto-accept types parsed from BROWSEROS_XC_AUTO_DIALOG env.
 * e.g. BROWSEROS_XC_AUTO_DIALOG=alert,beforeunload
 */
function getAutoAcceptTypes(): Set<string> {
  const raw = process.env.BROWSEROS_XC_AUTO_DIALOG ?? ''
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

class DialogMonitor {
  private static instances = new Map<number, DialogMonitor>()

  private state: DialogState = { ...EMPTY_STATE }
  private autoAcceptTypes: Set<string> = getAutoAcceptTypes()
  private attached = false

  static for(pageId: number): DialogMonitor {
    let m = DialogMonitor.instances.get(pageId)
    if (!m) {
      m = new DialogMonitor()
      DialogMonitor.instances.set(pageId, m)
    }
    return m
  }

  static remove(pageId: number): void {
    DialogMonitor.instances.delete(pageId)
  }

  getState(): Readonly<DialogState> {
    return this.state
  }

  setAutoAccept(types: string[]): void {
    this.autoAcceptTypes = new Set(types.map((t) => t.toLowerCase()))
  }

  getAutoAcceptTypes(): string[] {
    return [...this.autoAcceptTypes]
  }

  /**
   * Attach the CDP listener. Safe to call multiple times — only attaches once.
   */
  async attach(
    session: {
      Page: {
        enable: () => Promise<unknown>
        on: (event: string, cb: (params: Record<string, unknown>) => void) => void
        handleJavaScriptDialog: (params: { accept: boolean; promptText?: string }) => Promise<unknown>
      }
    },
  ): Promise<void> {
    if (this.attached) return
    this.attached = true

    await session.Page.enable()

    session.Page.on('javascriptDialogOpening', (params) => {
      this.state = {
        isOpen: true,
        type: (params.type as string) ?? '',
        message: (params.message as string) ?? '',
        url: (params.url as string) ?? '',
        defaultPrompt: (params.defaultPrompt as string) ?? '',
      }

      // Auto-handle if configured
      const t = this.state.type.toLowerCase()
      if (this.autoAcceptTypes.has(t) || this.autoAcceptTypes.has('all')) {
        session.Page.handleJavaScriptDialog({ accept: true }).catch(() => {})
        this.state = { ...EMPTY_STATE }
      }
    })

    // Track when dialog is closed externally
    session.Page.on('javascriptDialogClosed', () => {
      this.state = { ...EMPTY_STATE }
    })
  }
}

// ── get_dialog_status ──────────────────────────────────────────────────────────

export const get_dialog_status = defineXcTool({
  name: 'get_dialog_status',
  description:
    'Check if a JavaScript dialog (alert, confirm, prompt, beforeunload) is ' +
    'currently open on the page. Returns type, message, and open status. ' +
    'Call this after any action that might trigger a dialog.',
  input: z.object({ page: pageParam }),
  output: z.object({
    isOpen: z.boolean(),
    type: z.string(),
    message: z.string(),
    url: z.string(),
    defaultPrompt: z.string(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    const monitor = DialogMonitor.for(args.page)
    // Ensure listener is attached (idempotent)
    await monitor.attach(session as Parameters<typeof monitor.attach>[0])

    const state = monitor.getState()

    if (!state.isOpen) {
      response.text('No dialog is currently open.')
    } else {
      response.text(
        `Dialog open: [${state.type}] "${state.message}"` +
          (state.defaultPrompt ? ` (default: "${state.defaultPrompt}")` : ''),
      )
    }
    response.data(state)
  },
})

// ── dialog_accept ──────────────────────────────────────────────────────────────

export const dialog_accept = defineXcInputTool({
  name: 'dialog_accept',
  description:
    'Accept (OK / Yes) the currently open dialog. For prompt dialogs, ' +
    'provide promptText to fill in the input before accepting.',
  input: z.object({
    page: pageParam,
    promptText: z
      .string()
      .optional()
      .describe('Text to enter for prompt dialogs. Ignored for alert/confirm.'),
  }),
  output: z.object({ accepted: z.boolean(), type: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    const monitor = DialogMonitor.for(args.page)
    const state = monitor.getState()

    if (!state.isOpen) {
      response.error('No dialog is currently open. Use get_dialog_status to check.')
      return
    }

    const params: { accept: boolean; promptText?: string } = { accept: true }
    if (args.promptText !== undefined) params.promptText = args.promptText

    await session.Page.handleJavaScriptDialog(params)

    response.text(`Accepted [${state.type}] dialog: "${state.message}"`)
    response.data({ accepted: true, type: state.type })
  },
})

// ── dialog_dismiss ─────────────────────────────────────────────────────────────

export const dialog_dismiss = defineXcInputTool({
  name: 'dialog_dismiss',
  description:
    'Dismiss (Cancel / No) the currently open dialog. Works for confirm, ' +
    'prompt, and beforeunload dialogs. alert dialogs have no cancel — use dialog_accept instead.',
  input: z.object({ page: pageParam }),
  output: z.object({ dismissed: z.boolean(), type: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    const monitor = DialogMonitor.for(args.page)
    const state = monitor.getState()

    if (!state.isOpen) {
      response.error('No dialog is currently open.')
      return
    }

    await session.Page.handleJavaScriptDialog({ accept: false })

    response.text(`Dismissed [${state.type}] dialog.`)
    response.data({ dismissed: true, type: state.type })
  },
})

// ── configure_auto_dialog ──────────────────────────────────────────────────────

export const configure_auto_dialog = defineXcInputTool({
  name: 'configure_auto_dialog',
  description:
    'Configure which dialog types are automatically accepted without agent intervention. ' +
    'Useful when a site fires alerts on every navigation. ' +
    'Pass an empty array to disable auto-handling entirely. ' +
    'Valid types: alert, confirm, prompt, beforeunload, all.',
  input: z.object({
    page: pageParam,
    autoAcceptTypes: z
      .array(z.enum(['alert', 'confirm', 'prompt', 'beforeunload', 'all']))
      .describe('Dialog types to auto-accept. Pass [] to disable.'),
  }),
  output: z.object({ autoAcceptTypes: z.array(z.string()) }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    const monitor = DialogMonitor.for(args.page)
    await monitor.attach(session as Parameters<typeof monitor.attach>[0])
    monitor.setAutoAccept(args.autoAcceptTypes)

    const types = monitor.getAutoAcceptTypes()
    response.text(
      types.length === 0
        ? 'Auto-dialog handling disabled.'
        : `Auto-accepting dialog types: ${types.join(', ')}`,
    )
    response.data({ autoAcceptTypes: types })
  },
})
