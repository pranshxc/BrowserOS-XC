/**
 * XC Phase 2 — resolveRef
 *
 * Given a ref string that starts with '@' (e.g. "@e3") and a pageId,
 * returns the corresponding backendDOMNodeId so it can be passed directly
 * to ctx.browser.click() / ctx.browser.fill() / etc.
 *
 * Usage:
 *   const nodeId = resolveRef(pageId, '@e3')   // → 47
 *   await ctx.browser.click(pageId, nodeId, …)
 *
 * Throws a descriptive Error (surfaced to the AI agent as a tool error) if:
 *   • The ref does not match the @eN pattern
 *   • No snapshot has been taken for this page yet
 *   • The ref is out of range for the last snapshot
 *   • The page was navigated away and refs were invalidated
 */

import { refStore } from './ref-store'

/** Returns true when the string looks like an XC ref (@e1, @e42, etc.). */
export function isRef(value: string): boolean {
  return /^@e\d+$/.test(value)
}

/**
 * Resolve an @eN ref to a backendDOMNodeId.
 *
 * @throws {Error} with a user-friendly message if resolution fails.
 */
export function resolveRef(pageId: number, ref: string): number {
  if (!isRef(ref)) {
    throw new Error(
      `"${ref}" is not a valid XC ref. Refs must be in the format @e1, @e2, … ` +
        `Run snapshot_with_refs to get valid refs for page ${pageId}.`,
    )
  }

  const entry = refStore.resolve(pageId, ref)

  if (!entry) {
    if (!refStore.hasRefs(pageId)) {
      throw new Error(
        `No active refs for page ${pageId}. ` +
          `Call snapshot_with_refs first, then use the @eN refs from its output.`,
      )
    }
    throw new Error(
      `Ref "${ref}" not found in the current snapshot for page ${pageId}. ` +
          `The snapshot may have changed — call snapshot_with_refs again to get fresh refs.`,
    )
  }

  return entry.backendNodeId
}

/**
 * Same as resolveRef but returns null instead of throwing.
 * Useful when you want to fall back to numeric element IDs gracefully.
 */
export function tryResolveRef(pageId: number, ref: string): number | null {
  try {
    return resolveRef(pageId, ref)
  } catch {
    return null
  }
}
