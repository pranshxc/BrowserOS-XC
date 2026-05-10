/**
 * BrowserOS-XC Phase 10 — LLM-Callable Graph Tools
 *
 * 8 tools the AI agent uses to build and query the knowledge graph:
 *   graph_add_feature   — add/merge a FeatureNode
 *   graph_add_page      — add/merge a PageNode
 *   graph_add_api       — add/merge an APIEndpointNode
 *   graph_add_workflow  — add/merge a WorkflowNode
 *   graph_add_edge      — add/merge a DependencyEdge
 *   graph_query         — keyword search over all nodes
 *   graph_export        — export in json-ld | graphml | mermaid | all
 *   graph_summary       — human-readable progress report
 */

import { tool } from 'ai'
import { z } from 'zod'
import {
  buildSummary,
  exportGraphML,
  exportJSONLD,
  exportMermaid,
  getGraph,
  initGraph,
  persistAll,
  searchNodes,
  upsertAPI,
  upsertEdge,
  upsertFeature,
  upsertPage,
  upsertWorkflow,
} from './graph-store'
import { apiId, featureId, pageId, workflowId, type EdgeType } from './schema'

// ── graph_add_feature ─────────────────────────────────────────────────────────

export const graph_add_feature = tool({
  description:
    'Add or update a Feature node in the knowledge graph. A Feature is a discrete capability '
    + 'the website exposes (e.g. "Submit Story", "Upvote", "Login", "Comment Thread"). '
    + 'Existing nodes are merged — supply only the fields you know; blanks are never overwritten.',
  parameters: z.object({
    name: z.string().describe('Short human-readable feature name'),
    description: z.string().describe('What this feature does for the user'),
    pageUrl: z.string().describe('URL of the page where this feature was found'),
    reactComponent: z.string().optional().describe('Component name if detected'),
    featureFlag: z.string().optional().describe('Feature flag key gating this feature'),
    authRequired: z.boolean().optional().describe('Is authentication required?'),
    confidence: z.number().min(0).max(1).optional().describe('LLM confidence 0–1'),
    rawEvidence: z.array(z.string()).optional().describe('CSS selectors or text snippets'),
    tags: z.array(z.string()).optional().describe('Taxonomy tags'),
  }),
  execute: async (args) => {
    initGraph()
    const id = featureId(args.name)
    const node = upsertFeature({
      '@type': 'Feature',
      id,
      ...args,
      pageId: pageId(args.pageUrl),
    })
    return { ok: true, id: node.id, version: getGraph().version }
  },
})

// ── graph_add_page ────────────────────────────────────────────────────────────

export const graph_add_page = tool({
  description:
    'Add or update a Page node in the knowledge graph. '
    + 'Call this each time the crawler visits a new URL.',
  parameters: z.object({
    url: z.string().describe('Full page URL'),
    title: z.string().optional(),
    statusCode: z.number().optional(),
    framework: z.string().optional(),
    loadTimeMs: z.number().optional(),
    hasAuth: z.boolean().optional(),
    interactiveElementCount: z.number().optional(),
  }),
  execute: async (args) => {
    initGraph()
    const id = pageId(args.url)
    const node = upsertPage({ '@type': 'Page', id, ...args })
    return { ok: true, id: node.id, version: getGraph().version }
  },
})

// ── graph_add_api ─────────────────────────────────────────────────────────────

export const graph_add_api = tool({
  description:
    'Add or update an API Endpoint node. '
    + 'Call this for every unique HTTP request (or WS/SSE stream) you observe. '
    + 'Parametrize URL patterns: /api/item/12345 → /api/item/:id',
  parameters: z.object({
    method: z.string().describe('HTTP method: GET POST PUT PATCH DELETE WS SSE'),
    urlPattern: z.string().describe('URL with :param placeholders'),
    rawUrls: z.array(z.string()).optional(),
    requestSchema: z.record(z.unknown()).optional(),
    responseSchema: z.record(z.unknown()).optional(),
    sampleRequest: z.string().optional(),
    sampleResponse: z.string().optional(),
    statusCodes: z.array(z.number()).optional(),
    authRequired: z.boolean().optional(),
  }),
  execute: async (args) => {
    initGraph()
    const id = apiId(args.method, args.urlPattern)
    const node = upsertAPI({ '@type': 'APIEndpoint', id, ...args })
    return { ok: true, id: node.id, version: getGraph().version }
  },
})

// ── graph_add_workflow ────────────────────────────────────────────────────────

export const graph_add_workflow = tool({
  description:
    'Add or update a Workflow node — a multi-step user journey you completed '
    + '(e.g. "Upvote Story": navigate → observe → click vote → POST /vote). '
    + 'Document each distinct end-to-end flow as a separate workflow.',
  parameters: z.object({
    name: z.string(),
    description: z.string(),
    startPageId: z.string(),
    steps: z.array(z.object({
      order: z.number(),
      action: z.enum(['navigate', 'click', 'fill', 'submit', 'observe', 'eval']),
      description: z.string(),
      selector: z.string().optional(),
      value: z.string().optional(),
      resultPageUrl: z.string().optional(),
      apiCallsTriggered: z.array(z.string()).optional(),
    })),
    triggeredAPIs: z.array(z.string()),
    requiredFeatures: z.array(z.string()).optional(),
    authRequired: z.boolean().optional(),
  }),
  execute: async (args) => {
    initGraph()
    const id = workflowId(args.name)
    const node = upsertWorkflow({ '@type': 'Workflow', id, ...args })
    return { ok: true, id: node.id, version: getGraph().version }
  },
})

// ── graph_add_edge ────────────────────────────────────────────────────────────

export const graph_add_edge = tool({
  description:
    'Connect two existing graph nodes with a typed directed edge. '
    + 'Types: requires | triggers | navigates_to | calls_api | renders_on | part_of | guarded_by | depends_on.',
  parameters: z.object({
    from: z.string().describe('Source node ID'),
    to: z.string().describe('Target node ID'),
    type: z.enum([
      'requires', 'triggers', 'navigates_to', 'calls_api',
      'renders_on', 'part_of', 'guarded_by', 'depends_on',
    ] as [EdgeType, ...EdgeType[]]),
    label: z.string().optional(),
    weight: z.number().min(0).max(1).optional(),
  }),
  execute: async (args) => {
    initGraph()
    const edge = upsertEdge({
      id: `edge:${args.from}→${args.to}:${args.type}`,
      ...args,
    })
    return { ok: true, id: edge.id, version: getGraph().version }
  },
})

// ── graph_query ───────────────────────────────────────────────────────────────

export const graph_query = tool({
  description:
    'Keyword search across all graph nodes. '
    + 'Use before adding a node to avoid duplicates. '
    + 'Also answers questions like "what features require auth?".',
  parameters: z.object({
    question: z.string().describe('Search query or natural-language question'),
  }),
  execute: async ({ question }) => {
    initGraph()
    const results = searchNodes(question)
    return {
      count: results.length,
      results: results.slice(0, 20),
      hint: results.length > 20 ? `${results.length - 20} more — refine query` : undefined,
    }
  },
})

// ── graph_export ──────────────────────────────────────────────────────────────

export const graph_export = tool({
  description:
    'Export the full knowledge graph. '
    + 'json-ld — canonical JSON-LD. '
    + 'graphml — for Gephi/Cytoscape. '
    + 'mermaid — Mermaid flowchart (best for AI reading). '
    + 'all — writes all three to disk and returns paths.',
  parameters: z.object({
    format: z.enum(['json-ld', 'graphml', 'mermaid', 'all']),
  }),
  execute: async ({ format }) => {
    initGraph()
    if (format === 'json-ld') return { format, content: exportJSONLD() }
    if (format === 'graphml') return { format, content: exportGraphML() }
    if (format === 'mermaid') return { format, content: exportMermaid() }
    const paths = persistAll()
    return { format: 'all', files: paths, mermaidPreview: exportMermaid() }
  },
})

// ── graph_summary ─────────────────────────────────────────────────────────────

export const graph_summary = tool({
  description:
    'Returns a concise Markdown summary of the knowledge graph: '
    + 'node/edge counts, all features (with auth/flag markers), '
    + 'all workflows, and all API endpoints. '
    + 'Call at the end of a MapSite run or to report progress.',
  parameters: z.object({}),
  execute: async () => {
    initGraph()
    return { summary: buildSummary(), stats: getGraph().stats }
  },
})
