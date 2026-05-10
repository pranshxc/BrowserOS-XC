/**
 * XC Phase 10 — Graph Tools (LLM-Callable)
 *
 * These are the tools the AI agent calls to build and query the knowledge graph.
 * Each tool is a thin wrapper around the graph singleton from graph-store.ts.
 *
 * Tool inventory (10 tools)
 * ──────────────────────
 *   graph_init_session   — start a new mapping session for a target URL
 *   graph_add_page       — record a discovered page node
 *   graph_add_feature    — record a user-facing feature
 *   graph_add_api        — record an API endpoint
 *   graph_add_workflow   — record a multi-step workflow
 *   graph_add_edge       — add a directed relationship between any two nodes
 *   graph_query          — keyword search over all stored nodes
 *   graph_export         — export to json | jsonld | graphml | mermaid | summary
 *   graph_summary        — human-readable summary of what has been mapped
 *   graph_stats          — raw statistics object
 */

import { tool } from 'ai'
import { z } from 'zod'
import { graph, nodeId } from './graph-store'
import type {
  ActionStep,
  APIEndpointNode,
  EdgeType,
  FeatureNode,
  InteractiveElement,
  MappingConfig,
  PageNode,
  Provenance,
  WorkflowNode,
} from './schema'

// ── Shared sub-schemas ───────────────────────────────────────────────────────────

const ProvenanceSchema = z.object({
  phase: z.enum([
    'phase-1-navigation', 'phase-2-refs', 'phase-3-storage',
    'phase-4-frames', 'phase-5-visual', 'phase-6-framework',
    'phase-7-network', 'phase-8-performance', 'phase-9-eval',
    'phase-10-graph', 'manual',
  ]).describe('XC phase that discovered this node'),
  tool: z.string().describe('Tool name that produced this data'),
  sourceUrl: z.string().describe('Page URL being analyzed when discovered'),
  evidence: z.array(z.string()).describe('Raw evidence: selectors, API log lines, JS snippets'),
})

const InteractiveElementSchema = z.object({
  selector: z.string(),
  elementType: z.enum(['button', 'input', 'form', 'link', 'select', 'textarea', 'other']),
  label: z.string(),
  action: z.string().optional(),
  requiresAuth: z.boolean().optional(),
})

const ActionStepSchema = z.object({
  stepNumber: z.number().int().min(1),
  description: z.string().describe('Human description of this step'),
  pageUrl: z.string(),
  toolCall: z.string().optional().describe('Tool call that executes this step'),
  triggeredApis: z.array(z.string()),
  storageOps: z.array(z.string()),
  resultState: z.string().optional(),
})

const EdgeTypeSchema = z.enum([
  'navigates_to', 'requires', 'triggers', 'calls_api',
  'renders', 'reads_storage', 'writes_storage', 'uses_worker',
  'part_of', 'guarded_by',
])

function makeProvenance(p: z.infer<typeof ProvenanceSchema>): Provenance {
  const now = new Date().toISOString()
  return { ...p, discoveredAt: now, updatedAt: now }
}

// ── graph_init_session ──────────────────────────────────────────────────────────

export const graph_init_session = tool({
  description:
    'Start a new website intelligence mapping session. Call this once before any graph_add_* tools. ' +
    'Sets the target URL, BFS configuration, and optional output directory for auto-saving exports.',
  parameters: z.object({
    targetUrl: z.string().describe('Root URL of the website to map, e.g. https://news.ycombinator.com'),
    label: z.string().optional().describe('Human label for this session, e.g. "HN mapping run 1"'),
    outputDir: z.string().optional().describe('Filesystem path for auto-saving graph.json / graph.md etc.'),
    config: z.object({
      maxPages: z.number().int().min(1).max(500).default(50),
      maxDepth: z.number().int().min(1).max(20).default(5),
      sameOriginOnly: z.boolean().default(true),
      skipPatterns: z.array(z.string()).default([]),
      captureNetwork: z.boolean().default(true),
      runEvalPresets: z.boolean().default(true),
    }).optional(),
  }),
  execute: async ({ targetUrl, label, outputDir, config }) => {
    const session = graph.initSession(targetUrl, config as Partial<MappingConfig>, outputDir)
    session.label = label
    session.status = 'mapping'
    return {
      sessionId: session.id,
      targetUrl,
      config: session.config,
      message: `Session initialized. Frontier: [${targetUrl}]. Call graph_add_page for each discovered page.`,
    }
  },
})

// ── graph_add_page ───────────────────────────────────────────────────────────────

export const graph_add_page = tool({
  description:
    'Record a page (URL/route) as a graph node. Call after visiting each page during BFS. ' +
    'Automatically deduplicates by path — safe to call multiple times for the same URL.',
  parameters: z.object({
    url: z.string().describe('Full URL of the page'),
    title: z.string().describe('Page title'),
    requiresAuth: z.boolean().default(false),
    isDynamic: z.boolean().default(false).describe('Is this a dynamic route like /user/:id?'),
    pathParams: z.array(z.string()).default([]),
    queryParams: z.array(z.string()).default([]),
    outboundLinks: z.array(z.string()).default([]).describe('All links found on this page (normalized paths)'),
    interactiveElements: z.array(InteractiveElementSchema).default([]),
    httpStatus: z.number().int().optional(),
    framework: z.string().optional(),
    loadTimeMs: z.number().optional(),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.8),
    provenance: ProvenanceSchema,
    notes: z.string().optional(),
  }),
  execute: async (p) => {
    let parsedUrl: URL
    try { parsedUrl = new URL(p.url) } catch { return { error: `Invalid URL: ${p.url}` } }

    const node: Omit<PageNode, 'id'> = {
      type: 'page',
      url: p.url,
      path: parsedUrl.pathname,
      title: p.title,
      requiresAuth: p.requiresAuth,
      isDynamic: p.isDynamic,
      pathParams: p.pathParams,
      queryParams: p.queryParams,
      outboundLinks: p.outboundLinks,
      interactiveElements: p.interactiveElements as InteractiveElement[],
      httpStatus: p.httpStatus,
      framework: p.framework,
      loadTimeMs: p.loadTimeMs,
      tags: p.tags,
      confidence: p.confidence,
      provenance: makeProvenance(p.provenance),
      notes: p.notes,
      summary: `${p.title} at ${parsedUrl.pathname}${
        p.requiresAuth ? ' [AUTH REQUIRED]' : ''
      } — ${p.interactiveElements.length} interactive elements`,
    }

    const { node: saved, wasNew } = graph.upsertNode(node)
    graph.markVisited(p.url)
    graph.addToFrontier(p.outboundLinks)

    return {
      nodeId: saved.id,
      wasNew,
      path: parsedUrl.pathname,
      frontierSize: graph.getSession()?.frontier.length ?? 0,
      message: wasNew
        ? `Page ${parsedUrl.pathname} added. ${p.outboundLinks.length} outbound links queued.`
        : `Page ${parsedUrl.pathname} merged with existing node.`,
    }
  },
})

// ── graph_add_feature ───────────────────────────────────────────────────────────

export const graph_add_feature = tool({
  description:
    'Record a user-facing feature inferred from page analysis. ' +
    'Examples: "User Login", "Submit Story", "Vote on Comment", "Search". ' +
    'Automatically deduplicates by name — safe to call for the same feature multiple times.',
  parameters: z.object({
    name: z.string().describe('Feature name, e.g. "Submit Story"'),
    description: z.string().describe('What this feature does for the user'),
    pageUrls: z.array(z.string()).describe('Pages where this feature appears'),
    reactComponent: z.string().optional(),
    featureFlagKey: z.string().optional(),
    featureFlagEnabled: z.boolean().optional(),
    isHidden: z.boolean().default(false).describe('Built but not visible in UI'),
    category: z.string().default('core').describe('auth | payment | social | admin | analytics | core | navigation'),
    requiredRoles: z.array(z.string()).default([]),
    entryPoints: z.array(z.string()).default([]).describe('CSS selectors or descriptions of UI entry points'),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.6),
    provenance: ProvenanceSchema,
    notes: z.string().optional(),
  }),
  execute: async (p) => {
    const node: Omit<FeatureNode, 'id'> = {
      type: 'feature',
      name: p.name,
      description: p.description,
      pageUrls: p.pageUrls,
      reactComponent: p.reactComponent,
      featureFlagKey: p.featureFlagKey,
      featureFlagEnabled: p.featureFlagEnabled,
      isHidden: p.isHidden,
      category: p.category,
      requiredRoles: p.requiredRoles,
      entryPoints: p.entryPoints,
      tags: p.tags,
      confidence: p.confidence,
      provenance: makeProvenance(p.provenance),
      notes: p.notes,
      summary: `Feature: ${p.name}${p.isHidden ? ' [HIDDEN]' : ''} — ${p.description.slice(0, 120)}`,
    }

    const { node: saved, wasNew } = graph.upsertNode(node)

    // Auto-link to pages
    for (const url of p.pageUrls) {
      try {
        const pageNode = graph.getAllNodes().find(
          n => n.type === 'page' && (n as PageNode).url === url
        )
        if (pageNode) {
          graph.upsertEdge(pageNode.id, saved.id, 'renders', `${pageNode.type} renders feature ${p.name}`, 0.8, 'graph_add_feature')
        }
      } catch { /* skip */ }
    }

    return {
      nodeId: saved.id,
      wasNew,
      name: p.name,
      isHidden: p.isHidden,
      message: wasNew ? `Feature "${p.name}" added.` : `Feature "${p.name}" merged.`,
    }
  },
})

// ── graph_add_api ────────────────────────────────────────────────────────────────

export const graph_add_api = tool({
  description:
    'Record an API endpoint observed in network traffic. ' +
    'Feed this from start_request_capture / list_captured_requests output. ' +
    'Deduplicates by method + URL pattern.',
  parameters: z.object({
    method: z.string().describe('HTTP method: GET POST PUT PATCH DELETE or special: WS SSE GraphQL'),
    urlPattern: z.string().describe('URL with params replaced: /api/users/:id not /api/users/42'),
    exampleUrl: z.string().describe('Actual URL observed, e.g. /api/users/42'),
    apiType: z.enum(['rest', 'graphql', 'websocket', 'sse', 'grpc', 'unknown']).default('rest'),
    graphqlOperation: z.string().optional(),
    graphqlType: z.enum(['query', 'mutation', 'subscription']).optional(),
    requestContentType: z.string().optional(),
    requestSchema: z.record(z.string()).optional().describe('Field names and types observed in request body'),
    responseSchema: z.record(z.string()).optional().describe('Field names and types observed in response'),
    observedStatusCodes: z.array(z.number().int()).default([]),
    requiresAuth: z.boolean().default(false),
    avgResponseTimeMs: z.number().optional(),
    calledBy: z.array(z.string()).default([]).describe('Page paths or feature names that call this endpoint'),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.9),
    provenance: ProvenanceSchema,
    notes: z.string().optional(),
  }),
  execute: async (p) => {
    const node: Omit<APIEndpointNode, 'id'> = {
      type: 'api_endpoint',
      method: p.method.toUpperCase(),
      urlPattern: p.urlPattern,
      exampleUrl: p.exampleUrl,
      apiType: p.apiType,
      graphqlOperation: p.graphqlOperation,
      graphqlType: p.graphqlType,
      requestContentType: p.requestContentType,
      requestSchema: p.requestSchema,
      responseSchema: p.responseSchema,
      observedStatusCodes: p.observedStatusCodes,
      requiresAuth: p.requiresAuth,
      avgResponseTimeMs: p.avgResponseTimeMs,
      calledBy: p.calledBy,
      tags: p.tags,
      confidence: p.confidence,
      provenance: makeProvenance(p.provenance),
      notes: p.notes,
      summary: `${p.method.toUpperCase()} ${p.urlPattern} [${p.apiType}]${p.requiresAuth ? ' 🔒' : ''}${p.graphqlOperation ? ` op=${p.graphqlOperation}` : ''}`,
    }

    const { node: saved, wasNew } = graph.upsertNode(node)
    return {
      nodeId: saved.id,
      wasNew,
      endpoint: `${p.method.toUpperCase()} ${p.urlPattern}`,
      message: wasNew ? `API endpoint added.` : `API endpoint merged.`,
    }
  },
})

// ── graph_add_workflow ──────────────────────────────────────────────────────────

export const graph_add_workflow = tool({
  description:
    'Record a multi-step user workflow. Examples: "User Registration", "Submit Story", ' +
    '"Upvote Post", "View Comment Thread". Each step should map to a tool call.',
  parameters: z.object({
    name: z.string().describe('Workflow name, e.g. "Submit Story"'),
    goal: z.string().describe('What the user achieves, e.g. "Post a new link to the front page"'),
    steps: z.array(ActionStepSchema).min(1),
    entryPageUrl: z.string(),
    exitPageUrl: z.string().optional(),
    requiresAuth: z.boolean().default(false),
    complexity: z.enum(['trivial', 'simple', 'moderate', 'complex']).default('simple'),
    isComplete: z.boolean().default(false).describe('Set true only when all steps are fully traced'),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
    provenance: ProvenanceSchema,
    notes: z.string().optional(),
  }),
  execute: async (p) => {
    const allApis = [...new Set(p.steps.flatMap(s => s.triggeredApis))]
    const node: Omit<WorkflowNode, 'id'> = {
      type: 'workflow',
      name: p.name,
      goal: p.goal,
      steps: p.steps as ActionStep[],
      triggeredAPIs: allApis,
      entryPageUrl: p.entryPageUrl,
      exitPageUrl: p.exitPageUrl,
      requiresAuth: p.requiresAuth,
      complexity: p.complexity,
      isComplete: p.isComplete,
      tags: p.tags,
      confidence: p.confidence,
      provenance: makeProvenance(p.provenance),
      notes: p.notes,
      summary: `Workflow: ${p.name} (${p.steps.length} steps, ${p.complexity}) — ${p.goal.slice(0, 100)}`,
    }

    const { node: saved, wasNew } = graph.upsertNode(node)

    // Auto-link: workflow requires entry page
    const entryPage = graph.getAllNodes().find(
      n => n.type === 'page' && (n as PageNode).url === p.entryPageUrl
    )
    if (entryPage) {
      graph.upsertEdge(saved.id, entryPage.id, 'requires', `${p.name} starts at this page`, 0.9, 'graph_add_workflow')
    }

    return {
      nodeId: saved.id,
      wasNew,
      name: p.name,
      steps: p.steps.length,
      allApis,
      message: wasNew ? `Workflow "${p.name}" added.` : `Workflow "${p.name}" merged.`,
    }
  },
})

// ── graph_add_edge ─────────────────────────────────────────────────────────────

export const graph_add_edge = tool({
  description:
    'Add a directed relationship between any two nodes already in the graph. ' +
    'Use node IDs returned by graph_add_* tools, or found via graph_query.',
  parameters: z.object({
    from: z.string().describe('Source node ID'),
    to: z.string().describe('Target node ID'),
    type: EdgeTypeSchema.describe(
      'navigates_to | requires | triggers | calls_api | renders | ' +
      'reads_storage | writes_storage | uses_worker | part_of | guarded_by'
    ),
    label: z.string().describe('Human description of the relationship'),
    confidence: z.number().min(0).max(1).default(0.7),
    tool: z.string().default('manual').describe('Tool that produced this edge'),
    properties: z.record(z.unknown()).optional(),
  }),
  execute: async (p) => {
    if (!graph.getNode(p.from)) return { error: `Source node ${p.from} not found in graph` }
    if (!graph.getNode(p.to)) return { error: `Target node ${p.to} not found in graph` }

    const { edge, wasNew } = graph.upsertEdge(
      p.from, p.to, p.type as EdgeType, p.label, p.confidence, p.tool, p.properties
    )

    return {
      edgeId: edge.id,
      wasNew,
      from: p.from,
      to: p.to,
      type: p.type,
      message: wasNew ? `Edge ${p.type} added.` : `Edge ${p.type} confidence updated to ${edge.confidence}.`,
    }
  },
})

// ── graph_query ───────────────────────────────────────────────────────────────────

export const graph_query = tool({
  description:
    'Keyword search over all nodes in the knowledge graph. ' +
    'Returns ranked results with the node summary and ID. ' +
    'Use this to find a node ID before calling graph_add_edge.',
  parameters: z.object({
    query: z.string().describe('Search terms, e.g. "login auth", "payment api", "submit story"'),
    limit: z.number().int().min(1).max(50).default(10),
    filterType: z.enum(['page', 'feature', 'workflow', 'api_endpoint', 'ui_component', 'storage', 'worker', 'all']).default('all'),
  }),
  execute: async ({ query, limit, filterType }) => {
    let results = graph.search(query, limit * 3)
    if (filterType !== 'all') {
      results = results.filter(r => r.node.type === filterType)
    }
    results = results.slice(0, limit)

    if (results.length === 0) {
      return { results: [], message: `No nodes found for query: "${query}"` }
    }

    return {
      query,
      totalFound: results.length,
      results: results.map(r => ({
        id: r.node.id,
        type: r.node.type,
        summary: r.node.summary,
        confidence: r.node.confidence,
        score: r.score,
        matchedFields: r.matchedFields,
      })),
    }
  },
})

// ── graph_export ──────────────────────────────────────────────────────────────────

export const graph_export = tool({
  description:
    'Export the knowledge graph in a specified format. ' +
    'Use "mermaid" to get a diagram the AI can read back. ' +
    'Use "summary" for a plain-text overview. ' +
    'Use "json" or "jsonld" for machine consumption. ' +
    'Use "graphml" for Gephi/Cytoscape visualization. ' +
    'If outputDir was set in graph_init_session, also writes files to disk.',
  parameters: z.object({
    format: z.enum(['json', 'jsonld', 'graphml', 'mermaid', 'summary'])
      .describe('Output format'),
    saveToDir: z.string().optional()
      .describe('Override output directory (saves all 4 formats)'),
    returnContent: z.boolean().default(true)
      .describe('Return the content inline (may be large for json/graphml)'),
    maxInlineChars: z.number().int().default(8000)
      .describe('Truncate inline content to this length to avoid context overflow'),
  }),
  execute: async ({ format, saveToDir, returnContent, maxInlineChars }) => {
    const stats = graph.getStats()

    let savedPaths: Record<string, string> | null = null
    if (saveToDir) {
      try { savedPaths = graph.saveAll(saveToDir) } catch (e) {
        return { error: `Failed to save: ${e}` }
      }
    }

    let content: string | null = null
    let truncated = false
    if (returnContent) {
      switch (format) {
        case 'json': content = graph.exportJson(); break
        case 'jsonld': content = graph.exportJsonLd(); break
        case 'graphml': content = graph.exportGraphML(); break
        case 'mermaid': content = graph.exportMermaid(); break
        case 'summary': content = graph.exportSummary(); break
      }
      if (content && content.length > maxInlineChars) {
        content = content.slice(0, maxInlineChars) + `\n\n... [TRUNCATED: full content is ${content.length} chars. Use saveToDir to write to disk.]`
        truncated = true
      }
    }

    return {
      format,
      stats: { nodes: stats.totalNodes, edges: stats.totalEdges, coverage: stats.coverageScore },
      savedPaths,
      content,
      truncated,
    }
  },
})

// ── graph_summary ─────────────────────────────────────────────────────────────────

export const graph_summary = tool({
  description:
    'Get a concise human-readable summary of everything mapped so far. ' +
    'Returns stats, page list, feature list, API endpoints, and workflow list. ' +
    'Ideal for checkpointing: paste this into your context to know where you are.',
  parameters: z.object({
    includeEvidence: z.boolean().default(false)
      .describe('Include raw evidence snippets in the summary'),
  }),
  execute: async ({ includeEvidence }) => {
    const summary = graph.exportSummary()
    const stats = graph.getStats()
    const session = graph.getSession()

    let evidenceSection = ''
    if (includeEvidence) {
      const samples = graph.getAllNodes()
        .filter(n => n.provenance.evidence.length > 0)
        .slice(0, 10)
        .map(n => `### ${n.summary.slice(0, 60)}\n${n.provenance.evidence.slice(0, 3).join('\n')}`)
        .join('\n\n')
      if (samples) evidenceSection = `\n\n## Evidence Samples\n${samples}`
    }

    return {
      summary: summary + evidenceSection,
      stats,
      sessionStatus: session?.status,
      frontier: session?.frontier.slice(0, 10),
      message: `Coverage: ${stats.coverageScore}/100. ${stats.pagesRemaining} pages remaining in frontier.`,
    }
  },
})

// ── graph_stats ───────────────────────────────────────────────────────────────────

export const graph_stats = tool({
  description: 'Get raw statistics about the knowledge graph: node/edge counts by type, coverage score, top connected nodes.',
  parameters: z.object({}),
  execute: async () => graph.getStats(),
})
