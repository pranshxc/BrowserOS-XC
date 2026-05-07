/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir } from 'node:fs/promises'

import { HERMES_CONTAINER_HARNESS_DIR } from '@browseros/shared/constants/hermes'
import {
  getHermesAgentHomeHostDir,
  getHermesHarnessHostDir,
} from '../../../api/services/hermes/hermes-paths'
import type {
  PrepareAcpxAgentContextInput,
  PreparedAcpxAgentContext,
} from '../acpx-agent-adapter'
import {
  finishBrowserosManagedContext,
  prepareBrowserosManagedContext,
} from '../acpx-agent-common'

/**
 * Translate a host-side hermes home path to its in-container equivalent.
 * The container bind-mounts `<browserosDir>/vm/hermes/harness` (host)
 * onto `/data/agents/harness` (container), so paths under the host
 * harness root map cleanly to `/data/agents/harness/...` inside.
 *
 * Returns the original host path when it doesn't sit under the harness
 * root — used as a defensive escape hatch (tests that inject a custom
 * dir, or future host-process fallback that still goes through this
 * prepare step).
 */
function translateHermesHomeToContainerPath(
  hostHome: string,
  browserosDir: string,
): string {
  const harnessHostRoot = getHermesHarnessHostDir(browserosDir)
  if (hostHome === harnessHostRoot) return HERMES_CONTAINER_HARNESS_DIR
  if (hostHome.startsWith(`${harnessHostRoot}/`)) {
    return `${HERMES_CONTAINER_HARNESS_DIR}${hostHome.slice(harnessHostRoot.length)}`
  }
  return hostHome
}

/**
 * Prepares Hermes with a per-agent HERMES_HOME under
 * `<browserosDir>/vm/hermes/harness/<id>/home`. The provider config
 * (config.yaml + .env) was written into this directory at agent-create
 * time by AgentHarnessService.writeHermesPerAgentProvider. There is no
 * fallback to a global `~/.hermes/` install — Hermes agents always
 * carry their own provider config.
 *
 * HERMES_HOME inside the container is the container-side path
 * (`/data/agents/harness/<id>/home`) so Hermes resolves it correctly
 * when the runtime spawns `hermes acp` via `nerdctl exec`.
 */
export async function prepareHermesContext(
  input: PrepareAcpxAgentContextInput,
): Promise<PreparedAcpxAgentContext> {
  const common = await prepareBrowserosManagedContext(input)

  // Hermes-specific home lives under vm/ so it's reachable inside the
  // Lima VM; the shared `common.paths.agentHome` (under agents/harness)
  // is OUTSIDE the VM mount and would not be visible to nerdctl.
  const hermesAgentHome = getHermesAgentHomeHostDir({
    browserosDir: input.browserosDir,
    agentId: input.agent.id,
  })
  await mkdir(hermesAgentHome, { recursive: true })

  const hermesAgentHomeInContainer = translateHermesHomeToContainerPath(
    hermesAgentHome,
    input.browserosDir,
  )

  return finishBrowserosManagedContext({
    ...common,
    commandEnv: {
      HERMES_HOME: hermesAgentHomeInContainer,
    },
    // Hermes runs inside a Lima container; the BrowserOS HTTP MCP server
    // lives on the host. `host.containers.internal` resolves to the VM
    // gateway (via --add-host on the hermes-agent container) so hermes can
    // reach the MCP endpoint that the harness injects via newSession.
    browserosMcpHost: 'host.containers.internal',
  })
}
