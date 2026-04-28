/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AcpxRuntime } from '../../../lib/agents/acpx-runtime'
import type { AgentDefinition } from '../../../lib/agents/agent-types'
import {
  type CreateAgentInput,
  FileAgentStore,
} from '../../../lib/agents/file-agent-store'
import { FileTranscriptStore } from '../../../lib/agents/file-transcript-store'
import type {
  AgentHistoryPage,
  AgentRuntime,
  AgentStreamEvent,
} from '../../../lib/agents/types'

export class AgentHarnessService {
  private readonly agentStore: FileAgentStore
  private readonly transcriptStore: FileTranscriptStore
  private readonly runtime: AgentRuntime

  constructor(
    deps: {
      agentStore?: FileAgentStore
      transcriptStore?: FileTranscriptStore
      runtime?: AgentRuntime
      browserosServerPort?: number
    } = {},
  ) {
    this.agentStore = deps.agentStore ?? new FileAgentStore()
    this.transcriptStore = deps.transcriptStore ?? new FileTranscriptStore()
    this.runtime =
      deps.runtime ??
      new AcpxRuntime({ browserosServerPort: deps.browserosServerPort })
  }

  listAgents(): Promise<AgentDefinition[]> {
    return this.agentStore.list()
  }

  createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    return this.agentStore.create(input)
  }

  deleteAgent(agentId: string): Promise<boolean> {
    return this.agentStore.delete(agentId)
  }

  getAgent(agentId: string): Promise<AgentDefinition | null> {
    return this.agentStore.get(agentId)
  }

  async getHistory(agentId: string): Promise<AgentHistoryPage> {
    const agent = await this.requireAgent(agentId)
    return {
      agentId: agent.id,
      sessionId: 'main',
      items: await this.transcriptStore.list({
        agentId: agent.id,
        sessionId: 'main',
      }),
    }
  }

  async send(input: {
    agentId: string
    message: string
    signal?: AbortSignal
  }): Promise<ReadableStream<AgentStreamEvent>> {
    const agent = await this.requireAgent(input.agentId)
    await this.transcriptStore.append({
      agentId: agent.id,
      sessionId: 'main',
      role: 'user',
      text: input.message,
    })
    const runtimeStream = await this.runtime.send({
      agent,
      sessionId: 'main',
      sessionKey: agent.sessionKey,
      message: input.message,
      permissionMode: agent.permissionMode,
      signal: input.signal,
    })
    return this.persistAssistantTranscript(agent, runtimeStream)
  }

  private async requireAgent(agentId: string): Promise<AgentDefinition> {
    const agent = await this.agentStore.get(agentId)
    if (!agent) {
      throw new UnknownAgentError(agentId)
    }
    return agent
  }

  private persistAssistantTranscript(
    agent: AgentDefinition,
    stream: ReadableStream<AgentStreamEvent>,
  ): ReadableStream<AgentStreamEvent> {
    let reader: ReadableStreamDefaultReader<AgentStreamEvent> | null = null
    let assistantText = ''
    let transcriptFlushed = false

    const flushAssistantTranscript = async () => {
      if (transcriptFlushed || !assistantText.trim()) return
      transcriptFlushed = true
      await this.transcriptStore.append({
        agentId: agent.id,
        sessionId: 'main',
        role: 'assistant',
        text: assistantText,
      })
    }

    return new ReadableStream<AgentStreamEvent>({
      start: async (controller) => {
        reader = stream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value.type === 'text_delta' && value.stream === 'output') {
              assistantText += value.text
            } else if (value.type === 'done' && !assistantText && value.text) {
              assistantText = value.text
            }
            controller.enqueue(value)
          }
          await flushAssistantTranscript()
          controller.close()
        } catch (err) {
          controller.error(err)
        } finally {
          reader?.releaseLock()
        }
      },
      cancel: async () => {
        await flushAssistantTranscript()
        await reader?.cancel('BrowserOS stream cancelled')
      },
    })
  }
}

export class UnknownAgentError extends Error {
  constructor(readonly agentId: string) {
    super(`Unknown agent: ${agentId}`)
    this.name = 'UnknownAgentError'
  }
}
