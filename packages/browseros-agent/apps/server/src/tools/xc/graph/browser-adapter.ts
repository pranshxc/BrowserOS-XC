/**
 * browser-adapter.ts — Adapts browseros Browser to BrowserInterface.
 *
 * BrowserInterface uses CSS selectors for fill/click, but Browser uses
 * numeric element IDs. This adapter resolves selectors to element IDs
 * and normalizes return types.
 *
 * The adapter also implements waitForNavigation (not on Browser) via
 * CDP event polling.
 */

import type { Browser } from '../../../browser/browser'
import type { BrowserInterface } from './extraction-engine'
import type {
  NewPageOptions,
  GetDomOptions,
  SearchDomOptions,
  SearchDomResult,
  WaitForNavigationOptions,
  EvaluateResult,
  PageLink,
} from './browser-context'

export class BrowserAdapter implements BrowserInterface {
  constructor(private browser: Browser) {}

  async newPage(url: string, opts?: NewPageOptions): Promise<number> {
    return this.browser.newPage(url, opts)
  }

  async goto(page: number, url: string): Promise<void> {
    return this.browser.goto(page, url)
  }

  async evaluate(page: number, script: string): Promise<EvaluateResult> {
    const result = await this.browser.evaluate(page, script)
    if (result.error) {
      throw new Error(result.error)
    }
    return { value: result.value }
  }

  async snapshot(page: number): Promise<string | undefined> {
    const tree = await this.browser.snapshot(page)
    return tree || undefined
  }

  async enhancedSnapshot(page: number): Promise<string | undefined> {
    const tree = await this.browser.enhancedSnapshot(page)
    return tree || undefined
  }

  async getDom(page: number, opts: GetDomOptions): Promise<string | null> {
    const html = await this.browser.getDom(page, opts)
    return html || null
  }

  async searchDom(page: number, selector: string, opts?: SearchDomOptions): Promise<SearchDomResult> {
    const result = await this.browser.searchDom(page, selector, opts)
    return {
      results: result.results.map(r => ({
        tag: r.tag,
        nodeId: r.nodeId,
        backendNodeId: r.backendNodeId,
        attributes: r.attributes,
      })),
      totalCount: result.totalCount,
    }
  }

  async getPageLinks(page: number): Promise<PageLink[]> {
    const links = await this.browser.getPageLinks(page)
    return links.map(l => ({ href: l.href }))
  }

  async fill(page: number, selector: string, value: string): Promise<void> {
    // Resolve CSS selector to element ID via searchDom
    const search = await this.browser.searchDom(page, selector, { limit: 1 })
    if (search.results.length === 0) {
      throw new Error(`Element not found for selector: ${selector}`)
    }
    const elementId = search.results[0].backendNodeId
    await this.browser.fill(page, elementId, value, true)
  }

  async click(page: number, selector: string): Promise<void> {
    // Resolve CSS selector to element ID via searchDom
    const search = await this.browser.searchDom(page, selector, { limit: 1 })
    if (search.results.length === 0) {
      throw new Error(`Element not found for selector: ${selector}`)
    }
    const elementId = search.results[0].backendNodeId
    await this.browser.click(page, elementId)
  }

  async waitForNavigation(page: number, opts?: WaitForNavigationOptions): Promise<void> {
    // Browser doesn't have waitForNavigation — implement via polling
    const timeout = opts?.timeout ?? 30000
    const deadline = Date.now() + timeout

    // Wait for document.readyState === 'complete'
    while (Date.now() < deadline) {
      try {
        const result = await this.browser.evaluate(page, 'document.readyState')
        if (result.value === 'complete') return
      } catch {
        // Context may be torn down during navigation — expected
      }
      await new Promise(r => setTimeout(r, 150))
    }

    throw new Error(`Navigation timeout after ${timeout}ms`)
  }

  async closePage(page: number): Promise<void> {
    return this.browser.closePage(page)
  }
}

/**
 * Convenience factory — use this in xc_bootstrap, xc_step, etc.
 */
export function adaptBrowser(browser: Browser): BrowserInterface {
  return new BrowserAdapter(browser)
}