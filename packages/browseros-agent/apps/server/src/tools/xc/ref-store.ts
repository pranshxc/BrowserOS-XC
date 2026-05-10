/**
 * XC Phase 2 — RefStore
 *
 * Maintains a per-page map of stable @e1..@eN aliases → backendDOMNodeId.
 * The store is populated by snapshot-with-refs.ts after every snapshot call.
 * It is invalidated (cleared) when a navigation event occurs so stale refs
 * are never silently resolved to wrong elements.
 *
 * Design constraints
 * ─────────────────
 * • One singleton export (`refStore`) used by all XC tools — no DI needed.
 * • Thread-safe for the single-threaded Node.js event loop.
 * • No CDP dependency — pure in-memory bookkeeping.
 */

export interface RefEntry {
  /** The @eN label, e.g. "e3" */
  ref: string
  /** CDP backendDOMNodeId — passed directly to browser.click / browser.fill */
  backendNodeId: number
  /** Human-readable label extracted from the snapshot line (role + name) */
  label: string
  /** Unix ms when this entry was created */
  createdAt: number
}

export class RefStore {
  /**
   * pageId → (refKey → RefEntry)
   * refKey is the number part of the ref, e.g. for @e3 it is "3"
   */
  private pages = new Map<number, Map<string, RefEntry>>()

  // ── Population ──────────────────────────────────────────────────────────────

  /**
   * Rebuild the ref map for a page from a raw snapshot string.
   *
   * Each line of the snapshot emitted by browser.snapshot() looks like:
   *   [47] button "Submit"
   *   [123] textbox "Email" value="user@example.com"
   *
   * We assign sequential @e1, @e2, … IDs in the order lines appear so the
   * agent can use them deterministically within a single snapshot context.
   *
   * Returns the annotated snapshot string with [ref=eN] markers appended.
   */
  populate(pageId: number, rawSnapshot: string): string {
    const map = new Map<string, RefEntry>()
    const now = Date.now()

    // Line pattern:  [<backendNodeId>] <role> <rest…>
    const LINE_RE = /^\[(\d+)\]\s+(\S+)(.*)$/

    const lines = rawSnapshot.split('\n')
    const annotated: string[] = []
    let counter = 1

    for (const line of lines) {
      const m = LINE_RE.exec(line)
      if (!m) {
        annotated.push(line)
        continue
      }

      const backendNodeId = Number(m[1])
      const role = m[2]
      const rest = m[3]?.trim() ?? ''

      // Build a human label: role + first quoted name (if any)
      const nameMatch = /^"([^"]+)"/.exec(rest)
      const name = nameMatch ? nameMatch[1] : ''
      const label = name ? `${role} "${name}"` : role

      const refKey = String(counter)
      const refId = `e${counter}`
      counter++

      map.set(refKey, {
        ref: refId,
        backendNodeId,
        label,
        createdAt: now,
      })

      // Annotate the line: [47] button "Submit" [ref=e1]
      annotated.push(`${line} [ref=${refId}]`)
    }

    this.pages.set(pageId, map)
    return annotated.join('\n')
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  /**
   * Resolve a ref string like "@e3" or "e3" to its RefEntry.
   * Returns undefined if the ref is unknown or the store has been invalidated.
   */
  resolve(pageId: number, ref: string): RefEntry | undefined {
    const map = this.pages.get(pageId)
    if (!map) return undefined

    // Accept both "@e3" and "e3"
    const key = ref.replace(/^@?e/, '')
    return map.get(key)
  }

  // ── Invalidation ────────────────────────────────────────────────────────────

  /**
   * Clear all refs for a page — call this after any navigation so stale
   * @eN aliases cannot be accidentally reused.
   */
  invalidate(pageId: number): void {
    this.pages.delete(pageId)
  }

  /** Clear refs for all pages (e.g. on browser restart). */
  invalidateAll(): void {
    this.pages.clear()
  }

  // ── Introspection ───────────────────────────────────────────────────────────

  /** List all active refs for a page (useful for debugging / XC tooling). */
  listRefs(pageId: number): RefEntry[] {
    const map = this.pages.get(pageId)
    if (!map) return []
    return [...map.values()]
  }

  /** Returns true if a page has any active refs. */
  hasRefs(pageId: number): boolean {
    return (this.pages.get(pageId)?.size ?? 0) > 0
  }
}

/**
 * Singleton instance shared across all XC tools.
 * Import this rather than constructing your own RefStore.
 */
export const refStore = new RefStore()
