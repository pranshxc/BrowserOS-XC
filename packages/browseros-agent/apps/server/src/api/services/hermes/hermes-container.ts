/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Lifecycle service for the Hermes ACPX adapter container. Hermes runs
 * in the same Lima VM as OpenClaw — image is pulled into containerd, an
 * idle container is kept up so the harness can `nerdctl exec hermes acp`
 * per turn. Much smaller than OpenClawService: no gateway, no token, no
 * agent CRUD via container — the harness owns all of that.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HERMES_CONTAINER_HARNESS_DIR,
  HERMES_CONTAINER_NAME,
  HERMES_IMAGE,
} from '@browseros/shared/constants/hermes'
import { getBrowserosDir } from '../../../lib/browseros-dir'
import {
  ContainerCli,
  type ContainerSpec,
  ImageLoader,
} from '../../../lib/container'
import { logger } from '../../../lib/logger'
import { withProcessLock } from '../../../lib/process-lock'
import {
  GUEST_VM_STATE,
  getLimaHomeDir,
  resolveBundledLimactl,
  resolveBundledLimaTemplate,
  VM_NAME,
  VmRuntime,
} from '../../../lib/vm'
import { ContainerNameInUseError } from '../../../lib/vm/errors'
import { getHermesHarnessHostDir, getHermesHostStateDir } from './hermes-paths'

const CREATE_CONTAINER_MAX_ATTEMPTS = 3
const NAME_RELEASE_WAIT_MS = 10_000

const UNSUPPORTED_PLATFORM_MESSAGE =
  'browseros-vm currently supports macOS only; see the Linux/Windows tracking issue'

export interface HermesContainerServiceConfig {
  resourcesDir?: string
  browserosDir?: string
}

export interface HermesAccessor {
  getContainerName(): string
  getLimaHomeDir(): string
  getLimactlPath(): string
  getVmName(): string
}

export class HermesContainerService {
  private vm: VmRuntime | null = null
  private shell: ContainerCli | null = null
  private loader: ImageLoader | null = null
  private limactlPath: string
  private limaHome: string
  private resourcesDir: string | null
  private browserosDir: string
  private readonly hermesStateDir: string
  private readonly platform: NodeJS.Platform
  private lifecycleLock: Promise<void> = Promise.resolve()

  constructor(config: HermesContainerServiceConfig = {}) {
    this.resourcesDir = config.resourcesDir ?? null
    this.browserosDir = config.browserosDir ?? getBrowserosDir()
    this.hermesStateDir = getHermesHostStateDir(this.browserosDir)
    this.platform = process.platform
    this.limactlPath = this.resolveLimactlPath()
    this.limaHome = getLimaHomeDir(this.browserosDir)
    this.initRuntimes()
  }

  configure(config: HermesContainerServiceConfig): void {
    let runtimeChanged = false
    if (
      config.resourcesDir !== undefined &&
      config.resourcesDir !== this.resourcesDir
    ) {
      this.resourcesDir = config.resourcesDir
      runtimeChanged = true
    }
    if (
      config.browserosDir !== undefined &&
      config.browserosDir !== this.browserosDir
    ) {
      this.browserosDir = config.browserosDir
      runtimeChanged = true
    }
    if (runtimeChanged) {
      this.limactlPath = this.resolveLimactlPath()
      this.limaHome = getLimaHomeDir(this.browserosDir)
      this.initRuntimes()
    }
  }

  /** Warm the VM and Hermes image so first-use spawns avoid registry work. */
  async prewarm(onLog?: (msg: string) => void): Promise<void> {
    if (!this.isSupportedPlatform()) {
      logger.warn('Hermes prewarm skipped: unsupported platform', {
        platform: this.platform,
      })
      return
    }
    return this.withLifecycleLock('prewarm', async () => {
      const logProgress = (message: string) => {
        logger.info(message)
        onLog?.(message)
      }
      logProgress('Hermes prewarm: ensuring BrowserOS VM is ready')
      await this.requireVm().ensureReady()
      logProgress(`Hermes prewarm: ensuring image ${HERMES_IMAGE} is available`)
      await this.requireLoader().ensureImageLoaded(HERMES_IMAGE)
      logProgress('Hermes prewarm: ready')
    })
  }

  /**
   * Start a long-running idle container with the harness dir bind-
   * mounted. The container's default ENTRYPOINT (`hermes acp`) is
   * overridden with `tini -- sleep infinity` so the container stays
   * up; the AcpxRuntime spawns `hermes acp` per turn via `nerdctl
   * exec` and pipes its stdio back through limactl/SSH.
   */
  async start(onLog?: (msg: string) => void): Promise<void> {
    if (!this.isSupportedPlatform()) {
      logger.warn('Hermes start skipped: unsupported platform', {
        platform: this.platform,
      })
      return
    }
    return this.withLifecycleLock('start', async () => {
      const logProgress = (msg: string) => {
        logger.info(msg)
        onLog?.(msg)
      }
      await this.requireVm().ensureReady(logProgress)
      await this.requireLoader().ensureImageLoaded(HERMES_IMAGE, logProgress)

      // Make sure the host-side harness root exists so the bind-mount
      // doesn't error on a missing source path. Per-agent home dirs
      // get created lazily by prepareHermesContext.
      await mkdir(getHermesHarnessHostDir(this.browserosDir), {
        recursive: true,
      })

      logProgress('Hermes: starting idle container...')
      const container = await this.buildContainerSpec()
      await this.createContainerWithNameReconcile(container, logProgress)
      await this.requireShell().startContainer(container.name, logProgress)
      logProgress(
        `Hermes container running: ${HERMES_CONTAINER_NAME} (image ${HERMES_IMAGE})`,
      )
    })
  }

  async stop(): Promise<void> {
    if (!this.isSupportedPlatform()) return
    return this.withLifecycleLock('stop', async () => {
      logger.info('Stopping Hermes container', {
        container: HERMES_CONTAINER_NAME,
      })
      await this.requireShell().removeContainer(
        HERMES_CONTAINER_NAME,
        { force: true },
        undefined,
      )
    })
  }

  async restart(onLog?: (msg: string) => void): Promise<void> {
    await this.stop()
    await this.start(onLog)
  }

  async shutdown(): Promise<void> {
    if (!this.isSupportedPlatform()) return
    try {
      await this.requireShell().removeContainer(
        HERMES_CONTAINER_NAME,
        { force: true },
        undefined,
      )
    } catch {
      // best effort
    }
  }

  /**
   * Live-getters used by AcpxRuntime to spawn `hermes acp` inside the
   * container. Returned shape matches `HermesGatewayAccessor` in
   * acpx-runtime — kept structural here so the type wiring works without
   * a circular import.
   */
  getAccessor(): HermesAccessor {
    return {
      getContainerName: () => HERMES_CONTAINER_NAME,
      getLimaHomeDir: () => this.limaHome,
      getLimactlPath: () => this.limactlPath,
      getVmName: () => VM_NAME,
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private isSupportedPlatform(): boolean {
    return this.platform === 'darwin'
  }

  private resolveLimactlPath(): string {
    if (!this.isSupportedPlatform()) return 'limactl'
    return this.resourcesDir
      ? resolveBundledLimactl(this.resourcesDir)
      : 'limactl'
  }

  private initRuntimes(): void {
    if (!this.isSupportedPlatform()) {
      this.vm = null
      this.shell = null
      this.loader = null
      return
    }
    this.vm = new VmRuntime({
      limactlPath: this.limactlPath,
      limaHome: this.limaHome,
      templatePath: this.resourcesDir
        ? resolveBundledLimaTemplate(this.resourcesDir)
        : undefined,
      browserosRoot: this.browserosDir,
    })
    this.shell = new ContainerCli({
      limactlPath: this.limactlPath,
      limaHome: this.limaHome,
      vmName: VM_NAME,
    })
    this.loader = new ImageLoader(this.shell)
  }

  private requireVm(): VmRuntime {
    if (!this.vm) throw unsupportedPlatformError()
    return this.vm
  }

  private requireShell(): ContainerCli {
    if (!this.shell) throw unsupportedPlatformError()
    return this.shell
  }

  private requireLoader(): ImageLoader {
    if (!this.loader) throw unsupportedPlatformError()
    return this.loader
  }

  private async buildContainerSpec(): Promise<ContainerSpec> {
    const guestHarnessDir = `${GUEST_VM_STATE}/hermes/harness`
    const gateway = await this.requireVm().getDefaultGateway()
    return {
      name: HERMES_CONTAINER_NAME,
      image: HERMES_IMAGE,
      restart: 'unless-stopped',
      env: {
        PYTHONUNBUFFERED: '1',
      },
      // Make `host.containers.internal` resolve to the VM's gateway so
      // hermes inside the container can reach the BrowserOS HTTP server
      // running on the host (where the BrowserOS MCP /mcp lives). Mirrors
      // OpenClaw's container-runtime.ts gatewayContainer setup.
      addHosts: [`host.containers.internal:${gateway}`],
      mounts: [
        // Host harness root lives under <browserosDir>/vm/hermes/harness
        // so it's reachable inside the Lima VM via the existing vm/
        // mount; container sees it at /data/agents/harness.
        { source: guestHarnessDir, target: HERMES_CONTAINER_HARNESS_DIR },
      ],
      // Override the upstream image's `hermes acp` ENTRYPOINT — we want
      // a long-lived container that we `nerdctl exec` into per turn,
      // not one that tries to speak ACP at startup.
      // Bypass tini and use /bin/sh directly: tini 0.19.0 in the upstream
      // image getopt-parses any `-x` token (even after the PROGRAM), so
      // `tini /bin/sh -c "..."` errors with `invalid option -- 'c'`. We
      // don't need tini reaping zombies for an idle sleeper anyway.
      entrypoint: '/bin/sh',
      command: ['-c', 'exec sleep infinity'],
    }
  }

  /**
   * Create the fixed-name Hermes container, reconciling stale nerdctl
   * name ownership. Mirrors the OpenClaw service's reconcile loop.
   */
  private async createContainerWithNameReconcile(
    container: ContainerSpec,
    onLog?: (msg: string) => void,
  ): Promise<void> {
    let attempt = 1
    const shell = this.requireShell()
    while (true) {
      await this.removeContainerAndWait(container.name)
      try {
        await shell.createContainer(container, onLog)
        return
      } catch (err) {
        if (
          !(err instanceof ContainerNameInUseError) ||
          attempt >= CREATE_CONTAINER_MAX_ATTEMPTS
        ) {
          throw err
        }
        logger.warn('Hermes container name still in use; retrying create', {
          containerName: container.name,
          attempt,
          maxAttempts: CREATE_CONTAINER_MAX_ATTEMPTS,
        })
        attempt++
      }
    }
  }

  private async removeContainerAndWait(containerName: string): Promise<void> {
    const shell = this.requireShell()
    await shell.removeContainer(containerName, { force: true }, undefined)
    await shell.waitForContainerNameRelease(containerName, {
      timeoutMs: NAME_RELEASE_WAIT_MS,
      intervalMs: 100,
    })
  }

  private async withLifecycleLock<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleLock
    let release!: () => void
    this.lifecycleLock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => undefined)
    try {
      return await withProcessLock(
        'hermes-lifecycle',
        { lockDir: join(this.hermesStateDir, '.locks') },
        async () => {
          logger.debug('Hermes lifecycle operation started', { operation })
          return await fn()
        },
      )
    } finally {
      release()
    }
  }
}

function unsupportedPlatformError(): Error {
  return new Error(UNSUPPORTED_PLATFORM_MESSAGE)
}

let service: HermesContainerService | null = null

export function configureHermesContainerService(
  config: HermesContainerServiceConfig,
): HermesContainerService {
  if (!service) {
    service = new HermesContainerService(config)
    return service
  }
  service.configure(config)
  return service
}

export function getHermesContainerService(): HermesContainerService {
  if (!service) service = new HermesContainerService()
  return service
}
