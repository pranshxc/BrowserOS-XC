/**
 * XC Phase 10 — MapSite Autonomous Skill
 *
 * This is the top-level orchestrator that chains every XC phase tool into a
 * single BFS crawl that produces a complete knowledge graph.
 *
 * It is implemented as a single AI SDK tool (map_site) that the agent calls
 * with a target URL and configuration, then runs the full sweep internally.
 *
 * What map_site does
 * ──────────────────
 * This tool does NOT execute tool calls directly — it returns a structured
 * EXECUTION PLAN that the AI agent follows step-by-step, calling each tool
 * in sequence. This design allows the agent to observe intermediate results,
 * decide to go deeper or skip, and write graph nodes incrementally.
 *
 * Why a plan, not a loop?
 * ──────────────────────
 * LLM agents do not have long-running loops inside tool calls. The agent IS
 * the loop — it reads the plan, calls tool[0], observes the result, updates
 * the plan (calls get_next_step), calls tool[1], etc. This is the standard
 * ReAct pattern applied to multi-page crawling.
 *
 * The plan for each page
 * ──────────────────────
 *   Step 1: navigate_page(url)
 *   Step 2: start_request_capture()
 *   Step 3: snapshot_with_refs()  → extract all links + interactive elements
 *   Step 4: detect_framework()
 *   Step 5: eval_extract_routes()  (if framework detected)
 *   Step 6: eval_extract_flags()   (always)
 *   Step 7: stop_request_capture() → extract API endpoints
 *   Step 8: [LLM] infer features from snapshot + network log
 *   Step 9: graph_add_page()
 *   Step 10: graph_add_feature() for each inferred feature
 *   Step 11: graph_add_api() for each captured endpoint
 *   Step 12: graph_add_edge() for feature → api relationships
 *   Step 13: pop next URL from frontier, repeat
 *   Step 14 (final): graph_export('mermaid') + graph_export('summary')
 */

import { tool } from 'ai'
import { z } from 'zod'
import { graph } from './graph-store'

// Per-page step plan returned to the agent
interface PagePlan {
  url: string
  depth: number
  stepPlan: Array<{
    stepNumber: number
    toolName: string
    toolArgs: Record<string, unknown>
    description: string
    isOptional: boolean
    condition?: string
  }>
}

function buildPagePlan(url: string, depth: number, config: {
  captureNetwork: boolean
  runEvalPresets: boolean
  runFrameworkDetect: boolean
}): PagePlan {
  const steps: PagePlan['stepPlan'] = [
    {
      stepNumber: 1,
      toolName: 'navigate_page',
      toolArgs: { url },
      description: `Navigate to ${url}`,
      isOptional: false,
    },
  ]

  if (config.captureNetwork) {
    steps.push({
      stepNumber: steps.length + 1,
      toolName: 'start_request_capture',
      toolArgs: { captureRequestBody: true, captureResponseBody: false },
      description: 'Start network capture to record all API calls made on this page',
      isOptional: false,
    })
  }

  steps.push({
    stepNumber: steps.length + 1,
    toolName: 'snapshot_with_refs',
    toolArgs: {},
    description: 'Take interactive snapshot — extract all links, buttons, forms, and their ref IDs',
    isOptional: false,
  })

  steps.push({
    stepNumber: steps.length + 1,
    toolName: 'get_page_links',
    toolArgs: {},
    description: 'Get all outbound links for BFS frontier expansion',
    isOptional: false,
  })

  if (config.runFrameworkDetect) {
    steps.push({
      stepNumber: steps.length + 1,
      toolName: 'detect_framework',
      toolArgs: {},
      description: 'Detect JS framework (React/Vue/Angular/Next.js etc.)',
      isOptional: true,
    })
  }

  if (config.runEvalPresets) {
    steps.push({
      stepNumber: steps.length + 1,
      toolName: 'eval_extract_routes',
      toolArgs: {},
      description: 'Extract client-side route table (React Router, Next.js, Vue Router)',
      isOptional: true,
      condition: 'only if detect_framework found a SPA framework',
    })
    steps.push({
      stepNumber: steps.length + 1,
      toolName: 'eval_extract_flags',
      toolArgs: {},
      description: 'Extract feature flags (LaunchDarkly, Statsig, Unleash, custom window.flags)',
      isOptional: true,
    })
    steps.push({
      stepNumber: steps.length + 1,
      toolName: 'eval_extract_redux',
      toolArgs: {},
      description: 'Dump Redux/Zustand/MobX store to understand the app data model',
      isOptional: true,
    })
  }

  // Wait for page interactions to settle (give network time to fire)
  steps.push({
    stepNumber: steps.length + 1,
    toolName: 'evaluate_js',
    toolArgs: { code: 'new Promise(r => setTimeout(r, 800))' },
    description: 'Wait 800ms for any deferred/lazy network requests to fire',
    isOptional: true,
  })

  if (config.captureNetwork) {
    steps.push({
      stepNumber: steps.length + 1,
      toolName: 'stop_request_capture',
      toolArgs: {},
      description: 'Stop network capture and collect all API endpoints for graph_add_api',
      isOptional: false,
    })
    steps.push({
      stepNumber: steps.length + 1,
      toolName: 'list_captured_requests',
      toolArgs: { limit: 100 },
      description: 'Retrieve captured requests to add as API endpoint nodes',
      isOptional: false,
    })
  }

  // AI inference step (no tool call — the agent does this itself)
  steps.push({
    stepNumber: steps.length + 1,
    toolName: '__AI_INFER__',
    toolArgs: {},
    description:
      '[AGENT THINKING STEP] Based on snapshot_with_refs output, infer the user-facing features ' +
      'on this page. For each feature: determine its name, description, category, whether it ' +
      'requires auth, and its entry point selectors. Prepare graph_add_feature calls.',
    isOptional: false,
  })

  steps.push({
    stepNumber: steps.length + 1,
    toolName: 'graph_add_page',
    toolArgs: { url, title: '__from_snapshot__', provenance: {
      phase: 'phase-1-navigation', tool: 'navigate_page', sourceUrl: url, evidence: [],
    }},
    description: 'Record this page in the knowledge graph',
    isOptional: false,
  })

  steps.push({
    stepNumber: steps.length + 1,
    toolName: 'graph_add_feature',
    toolArgs: { __repeat__: true },
    description: 'Call graph_add_feature for EACH feature inferred in the __AI_INFER__ step',
    isOptional: false,
  })

  steps.push({
    stepNumber: steps.length + 1,
    toolName: 'graph_add_api',
    toolArgs: { __repeat__: true },
    description: 'Call graph_add_api for EACH endpoint from list_captured_requests',
    isOptional: false,
  })

  steps.push({
    stepNumber: steps.length + 1,
    toolName: 'graph_add_edge',
    toolArgs: { __repeat__: true },
    description: 'Call graph_add_edge to link features to their API endpoints and to each other',
    isOptional: true,
  })

  return { url, depth, stepPlan: steps }
}

// ── map_site tool ────────────────────────────────────────────────────────────────

export const map_site = tool({
  description:
    'START HERE for any website intelligence mapping mission. ' +
    'Initializes the knowledge graph session and returns a structured execution plan ' +
    'for the first page. After executing the plan, call map_site_next_page to get ' +
    'the plan for the next URL in the BFS frontier. Repeat until the frontier is empty ' +
    'or maxPages is reached. Finish with graph_export to get the final diagram.',
  parameters: z.object({
    targetUrl: z.string().describe('Root URL to start mapping from'),
    label: z.string().optional().describe('Human label for this run'),
    outputDir: z.string().optional().describe('Directory to save graph files'),
    maxPages: z.number().int().min(1).max(200).default(20)
      .describe('Max pages to visit (default 20 for safety)'),
    maxDepth: z.number().int().min(1).max(10).default(4),
    skipPatterns: z.array(z.string()).default([])
      .describe('URL patterns to skip, e.g. ["logout", ".pdf", "mailto:"]'),
    captureNetwork: z.boolean().default(true),
    runEvalPresets: z.boolean().default(true),
  }),
  execute: async (p) => {
    const session = graph.initSession(
      p.targetUrl,
      {
        maxPages: p.maxPages,
        maxDepth: p.maxDepth,
        sameOriginOnly: true,
        skipPatterns: [...p.skipPatterns, 'logout', 'signout', 'mailto:', 'tel:', '.pdf', '.zip'],
        captureNetwork: p.captureNetwork,
        runEvalPresets: p.runEvalPresets,
        outputDir: p.outputDir,
      },
      p.outputDir,
    )
    session.label = p.label
    session.status = 'mapping'

    const firstPlan = buildPagePlan(p.targetUrl, 0, {
      captureNetwork: p.captureNetwork,
      runEvalPresets: p.runEvalPresets,
      runFrameworkDetect: true,
    })

    return {
      sessionId: session.id,
      message:
        'MapSite session initialized. Execute the stepPlan below for the first page. ' +
        'After completing all steps, call map_site_next_page to get the next URL. ' +
        'After all pages are done, call graph_export({ format: "mermaid" }) and graph_summary().',
      firstPage: p.targetUrl,
      config: session.config,
      stepPlan: firstPlan.stepPlan,
      instructions: [
        'Execute each step in order.',
        'Steps marked __AI_INFER__ require YOU (the agent) to analyze the snapshot and infer features.',
        'Steps marked __repeat__ should be called once per discovered item (once per feature, once per API endpoint).',
        'Optional steps can be skipped if not applicable (e.g., eval_extract_routes on a non-SPA site).',
        'After all steps, call map_site_next_page to continue BFS.',
        'After frontier is empty, call graph_export({ format: "mermaid", saveToDir: outputDir }) to finalize.',
      ],
    }
  },
})

// ── map_site_next_page ──────────────────────────────────────────────────────────

export const map_site_next_page = tool({
  description:
    'Get the execution plan for the next page in the BFS frontier. ' +
    'Call this after completing the step plan for the previous page. ' +
    'Returns null when the frontier is empty (mapping complete).',
  parameters: z.object({
    completedUrl: z.string().describe('URL of the page you just finished mapping'),
    pagesVisited: z.number().int().describe('How many pages have been visited so far'),
  }),
  execute: async ({ completedUrl, pagesVisited }) => {
    graph.markVisited(completedUrl)
    const session = graph.getSession()
    if (!session) return { error: 'No active session. Call map_site first.' }

    if (pagesVisited >= session.config.maxPages) {
      session.status = 'complete'
      const stats = graph.getStats()
      return {
        done: true,
        reason: `maxPages limit (${session.config.maxPages}) reached`,
        stats,
        message: 'Mapping complete. Call graph_export({ format: "mermaid" }) and graph_summary() to finalize.',
      }
    }

    const frontier = session.frontier
    if (frontier.length === 0) {
      session.status = 'complete'
      const stats = graph.getStats()
      return {
        done: true,
        reason: 'Frontier exhausted — all reachable pages visited',
        stats,
        message: 'Mapping complete. Call graph_export({ format: "mermaid" }) and graph_summary() to finalize.',
      }
    }

    const nextUrl = frontier[0]
    const depth = 1 // simplified; full depth tracking requires a depth map
    const plan = buildPagePlan(nextUrl, depth, {
      captureNetwork: session.config.captureNetwork,
      runEvalPresets: session.config.runEvalPresets,
      runFrameworkDetect: false, // only detect once at root
    })

    const stats = graph.getStats()
    return {
      done: false,
      nextUrl,
      depth,
      pagesRemaining: frontier.length,
      pagesVisited: session.visited.size,
      currentStats: {
        nodes: stats.totalNodes,
        edges: stats.totalEdges,
        coverage: stats.coverageScore,
      },
      stepPlan: plan.stepPlan,
    }
  },
})
