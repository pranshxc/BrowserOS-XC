/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AGENT_HARNESS_LIMITS } from '@browseros/shared/constants/limits'
import { type Context, Hono } from 'hono'
import { stream } from 'hono/streaming'
import {
  AGENT_ADAPTER_CATALOG,
  isAgentAdapter,
  isSupportedAgentModel,
  isSupportedReasoningEffort,
} from '../../lib/agents/agent-catalog'
import type {
  AgentAdapter,
  AgentDefinition,
} from '../../lib/agents/agent-types'
import type { AgentHistoryPage, AgentStreamEvent } from '../../lib/agents/types'
import {
  AgentHarnessService,
  UnknownAgentError,
} from '../services/agents/agent-harness-service'
import type { Env } from '../types'

type AgentRouteService = {
  listAgents(): Promise<AgentDefinition[]>
  createAgent(input: {
    name: string
    adapter: AgentAdapter
    modelId?: string
    reasoningEffort?: string
  }): Promise<AgentDefinition>
  getAgent(agentId: string): Promise<AgentDefinition | null>
  deleteAgent(agentId: string): Promise<boolean>
  getHistory(agentId: string): Promise<AgentHistoryPage>
  send(input: {
    agentId: string
    message: string
    signal?: AbortSignal
  }): Promise<ReadableStream<AgentStreamEvent>>
}

type AgentRouteDeps = {
  service?: AgentRouteService
  browserosServerPort?: number
}

export function createAgentRoutes(deps: AgentRouteDeps = {}) {
  const service =
    deps.service ??
    new AgentHarnessService({ browserosServerPort: deps.browserosServerPort })

  return new Hono<Env>()
    .get('/adapters', (c) => c.json({ adapters: AGENT_ADAPTER_CATALOG }))
    .get('/', async (c) => c.json({ agents: await service.listAgents() }))
    .post('/', async (c) => {
      const parsed = await parseCreateAgentBody(c)
      if ('error' in parsed) return c.json({ error: parsed.error }, 400)
      try {
        return c.json({ agent: await service.createAgent(parsed) })
      } catch (err) {
        return handleAgentRouteError(c, err)
      }
    })
    .get('/:agentId', async (c) => {
      try {
        const agent = await service.getAgent(c.req.param('agentId'))
        if (!agent) return c.json({ error: 'Unknown agent' }, 404)
        return c.json({ agent })
      } catch (err) {
        return handleAgentRouteError(c, err)
      }
    })
    .delete('/:agentId', async (c) => {
      try {
        return c.json({
          success: await service.deleteAgent(c.req.param('agentId')),
        })
      } catch (err) {
        return handleAgentRouteError(c, err)
      }
    })
    .get('/:agentId/sessions/main/history', async (c) => {
      try {
        return c.json(await service.getHistory(c.req.param('agentId')))
      } catch (err) {
        return handleAgentRouteError(c, err)
      }
    })
    .post('/:agentId/chat', async (c) => {
      const agentId = c.req.param('agentId')
      const parsed = await parseChatBody(c)
      if ('error' in parsed) return c.json({ error: parsed.error }, 400)

      let eventStream: ReadableStream<AgentStreamEvent>
      try {
        eventStream = await service.send({
          agentId,
          message: parsed.message,
          signal: c.req.raw.signal,
        })
      } catch (err) {
        return handleAgentRouteError(c, err)
      }

      c.header('Content-Type', 'text/event-stream')
      c.header('Cache-Control', 'no-cache')
      c.header('X-Session-Id', 'main')

      return stream(c, async (s) => {
        const reader = eventStream.getReader()
        const encoder = new TextEncoder()
        let completed = false
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            await s.write(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
          }
          await s.write(encoder.encode('data: [DONE]\n\n'))
          completed = true
        } finally {
          if (completed) {
            reader.releaseLock()
          } else {
            await reader.cancel('BrowserOS HTTP stream ended').catch(() => {})
          }
        }
      })
    })
}

async function parseCreateAgentBody(c: Context<Env>): Promise<
  | {
      name: string
      adapter: AgentAdapter
      modelId?: string
      reasoningEffort?: string
    }
  | { error: string }
> {
  const body = await readJsonBody(c)
  if ('error' in body) return body
  const record = body.value
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) return { error: 'Name is required' }
  if (name.length > AGENT_HARNESS_LIMITS.AGENT_NAME_MAX_CHARS) {
    return {
      error: `Name must be ${AGENT_HARNESS_LIMITS.AGENT_NAME_MAX_CHARS} characters or fewer`,
    }
  }
  if (!isAgentAdapter(record.adapter)) {
    return { error: 'Invalid adapter' }
  }

  const modelId =
    typeof record.modelId === 'string' && record.modelId.trim()
      ? record.modelId.trim()
      : undefined
  const reasoningEffort =
    typeof record.reasoningEffort === 'string' && record.reasoningEffort.trim()
      ? record.reasoningEffort.trim()
      : undefined

  if (!isSupportedAgentModel(record.adapter, modelId)) {
    return { error: 'Invalid modelId' }
  }
  if (!isSupportedReasoningEffort(record.adapter, reasoningEffort)) {
    return { error: 'Invalid reasoningEffort' }
  }

  return {
    name,
    adapter: record.adapter,
    modelId,
    reasoningEffort,
  }
}

async function parseChatBody(
  c: Context<Env>,
): Promise<{ message: string } | { error: string }> {
  const body = await readJsonBody(c)
  if ('error' in body) return body
  const message =
    typeof body.value.message === 'string' ? body.value.message.trim() : ''
  return message ? { message } : { error: 'Message is required' }
}

async function readJsonBody(
  c: Context<Env>,
): Promise<{ value: Record<string, unknown> } | { error: string }> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { error: 'Invalid JSON body' }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'JSON object body is required' }
  }
  return { value: body as Record<string, unknown> }
}

function handleAgentRouteError(c: Context<Env>, err: unknown) {
  if (err instanceof UnknownAgentError) {
    return c.json({ error: err.message }, 404)
  }
  const message = err instanceof Error ? err.message : String(err)
  return c.json({ error: message }, 500)
}
