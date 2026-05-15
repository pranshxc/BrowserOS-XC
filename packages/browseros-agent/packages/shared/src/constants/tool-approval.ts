export const TOOL_APPROVAL_CATEGORY_IDS = [
  'input',
  'navigation',
  'observation',
  'screenshots',
  'scripts',
  'data-modification',
  'assistant',
  'read',
  'filesystem_write',
  'workers',
  'performance',
  'network',
  'js-engine',
] as const

export type ToolApprovalCategoryId = (typeof TOOL_APPROVAL_CATEGORY_IDS)[number]

export interface ToolApprovalCategory {
  id: ToolApprovalCategoryId
  name: string
  description: string
}

export interface ToolApprovalConfig {
  categories: Partial<Record<ToolApprovalCategoryId, boolean>>
}

export const TOOL_APPROVAL_CATEGORIES: readonly ToolApprovalCategory[] = [
  {
    id: 'input',
    name: 'Input Actions',
    description:
      'Click, type, fill, upload, scroll, and interact with page elements.',
  },
  {
    id: 'navigation',
    name: 'Navigation',
    description: 'Open, close, move, and navigate pages and tabs.',
  },
  {
    id: 'observation',
    name: 'Observation',
    description:
      'Inspect pages, snapshots, DOM state, content, and console output.',
  },
  {
    id: 'screenshots',
    name: 'Screenshots & Capture',
    description: 'Take screenshots, save PDFs, and download files.',
  },
  {
    id: 'scripts',
    name: 'Script Execution',
    description: 'Run JavaScript in the page context.',
  },
  {
    id: 'data-modification',
    name: 'Browser Management',
    description: 'Manage windows, bookmarks, history, and tab groups.',
  },
  {
    id: 'assistant',
    name: 'Assistant Actions',
    description: 'BrowserOS helper and suggestion tools.',
  },
  {
    id: 'read',
    name: 'Read Operations',
    description: 'Read files, graphs, and session data from disk.',
  },
  {
    id: 'filesystem_write',
    name: 'Filesystem Write',
    description: 'Write and export files, graphs, and session data to disk.',
  },
  {
    id: 'workers',
    name: 'Worker Inspection',
    description: 'Inspect service workers and web workers.',
  },
  {
    id: 'performance',
    name: 'Performance Tracing',
    description: 'Collect and analyze performance metrics.',
  },
  {
    id: 'network',
    name: 'Network Interception',
    description: 'Intercept, mock, and replay network requests.',
  },
  {
    id: 'js-engine',
    name: 'JavaScript Engine',
    description: 'Runtime and script engine management.',
  },
] as const
