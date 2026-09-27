import { spawnWorker, type ManagedWorker } from './transport/stdio-ipc.js'
import { mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { totalmem } from 'node:os'
import type {
  Finding,
  PluginSettingsValues,
  RunMode,
  RunState,
  Strategy,
  WorkerMessageOut,
  WorkerMessageIn,
} from './types.js'
import { STRINGS } from './i18n/strings.js'
import { executeStrategy } from './strategies/index.js'
import { resolveRunReporters } from './reporters/index.js'

export interface OrchestratorContext {
  logger: {
    debug: (...a: unknown[]) => void
    info: (...a: unknown[]) => void
    warn: (...a: unknown[]) => void
    error: (...a: unknown[]) => void
  }
  publish: (panelId: string | undefined, key: string, value: unknown) => void
  notify: (req: any) => void
  /** Sync-or-async-aware: await result if the storage get returns a Promise. */
  storageGet<T = unknown>(k: string): T | undefined | Promise<T | undefined>
  storageSet(k: string, v: unknown): void
  emitState: () => void
  workdirProvider: () => string
}

export interface StartRunInput {
  mode: RunMode
  strategy: Strategy
  targetUrl: string
  concurrency: number
  settings: PluginSettingsValues
}

interface InternalRun extends RunState {
  workdir: string
  settings: PluginSettingsValues
  runDir: string
  assetsDir: string
  workerStatus: Map<string, 'queued' | 'running' | 'stalled' | 'done'>
  workers: ManagedWorker[]
}

function totalMemGb(): number {
  return Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10
}

export class Orchestrator {
  readonly runs = new Map<string, InternalRun>()
  private workerEntry = ''

  constructor(private readonly ctx: OrchestratorContext) {}

  setWorkerEntry(p: string): void {
    this.workerEntry = p
  }

  async hydrateFromStorage(): Promise<void> {
    try {
      const raw = await this.ctx.storageGet<unknown>('runs/index')
      if (!Array.isArray(raw)) return
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Record<string, unknown>
        const id = String(e.id ?? '')
        if (!id || this.runs.has(id)) continue
        const workdir = this.ctx.workdirProvider()
        const outputDir = typeof e.outputDir === 'string' && e.outputDir.length > 0
          ? e.outputDir
          : DEFAULTS_FROM_HYDRATE.outputDir
        const outputRoot = isAbsolute(outputDir) ? outputDir : join(workdir, outputDir)
        const settings: PluginSettingsValues = {
          ...DEFAULTS_FROM_HYDRATE,
          ...(typeof e.settings === 'object' && e.settings ? (e.settings as Partial<PluginSettingsValues>) : {}),
          outputDir,
        }
        this.runs.set(id, {
          id,
          startedAt: String(e.startedAt ?? new Date().toISOString()),
          finishedAt: e.finishedAt ? String(e.finishedAt) : undefined,
          mode: (e.mode as RunMode) ?? 'bugs',
          strategy: (e.strategy as Strategy) ?? 'autodetect',
          targetUrl: String(e.targetUrl ?? ''),
          workerIds: [],
          children: [],
          status: 'completed',
          findings: [],
          visitedUrls: new Set<string>(),
          lastActivityTs: Date.parse(String(e.finishedAt ?? e.startedAt ?? Date.now())),
          workdir,
          settings,
          runDir: join(outputRoot, 'runs', id),
          assetsDir: join(outputRoot, 'assets', id),
          workerStatus: new Map(),
          workers: [],
        })
      }
    } catch (e: any) {
      this.ctx.logger.warn(`[orchestrator] hydrate failed: ${e.message}`)
    }
  }

  async start(input: StartRunInput): Promise<string> {
    if (!this.workerEntry) throw new Error('worker entry not configured')
    let concurrency = input.concurrency
    if (totalMemGb() < 8 && concurrency > 2) {
      const warnMsg = `[autonomous-playwright] machine has ${totalMemGb()} GB RAM, capping concurrency to 2`
      this.ctx.logger.warn(warnMsg)
      this.ctx.notify({
        title: { en: 'Low memory — concurrency capped', fr: 'Mémoire faible — concurrence plafonnée' },
        body: { en: warnMsg, fr: warnMsg },
        level: 'warning',
      })
      concurrency = 2
    }

    const id = randomUUID().slice(0, 8)
    const workdir = this.ctx.workdirProvider()
    const outputRoot = isAbsolute(input.settings.outputDir)
      ? input.settings.outputDir
      : join(workdir, input.settings.outputDir)
    const runDir = join(outputRoot, 'runs', id)
    const assetsDir = join(outputRoot, 'assets', id)
    await mkdir(join(runDir, 'raw'), { recursive: true })
    await mkdir(assetsDir, { recursive: true })

    const run: InternalRun = {
      id,
      startedAt: new Date().toISOString(),
      mode: input.mode,
      strategy: input.strategy,
      targetUrl: input.targetUrl,
      workerIds: [],
      children: [],
      status: 'queued',
      findings: [],
      visitedUrls: new Set<string>(),
      lastActivityTs: Date.now(),
      workdir,
      settings: input.settings,
      runDir,
      assetsDir,
      workerStatus: new Map(),
      workers: [],
    }
    this.runs.set(id, run)
    this.persistIndex()

    let strategyResult
    try {
      strategyResult = await executeStrategy({
        strategy: input.strategy,
        target: input.targetUrl,
        seedUrls: input.settings.seedUrls ?? [],
        allowedOrigins: input.settings.allowedOrigins ?? [],
        maxPages: input.settings.maxPages ?? 20,
        workdir,
        logger: this.ctx.logger,
      })
    } catch (e: any) {
      run.status = 'failed'
      run.finishedAt = new Date().toISOString()
      run.errorMessage = e?.message ?? String(e)
      await this.finalizeRun(run)
      this.ctx.notify({
        title: STRINGS.notifyRunFailed,
        body: { en: e?.message ?? 'strategy failed', fr: e?.message ?? 'échec stratégie' },
        level: 'error',
      })
      this.persistIndex()
      this.ctx.emitState()
      throw e
    }

    run.status = 'running'
    run.workerIds = Array.from({ length: concurrency }, () => randomUUID().slice(0, 6))

    const seeds = strategyResult.seeds
    this.ctx.publish('playwright-runs', run.id, this.snapshot(run))

    // F27: honor stop requested while still queued → mark stopped before spawning workers
    if (run.stopRequested) {
      run.status = 'stopped'
      run.finishedAt = new Date().toISOString()
      await this.finalizeRun(run)
      this.persistIndex()
      this.ctx.emitState()
      return id
    }
    const slicePerWorker = Math.max(1, Math.ceil(seeds.length / concurrency))
    let cursor = 0
    const nextSlice = () => {
      const slice = seeds.slice(cursor, cursor + slicePerWorker)
      cursor += slicePerWorker
      return slice.length ? slice : [input.targetUrl]
    }

    this.ctx.notify({ title: STRINGS.notifyRunStarted(input.mode), level: 'info' })

    for (const workerId of run.workerIds) {
      run.workerStatus.set(workerId, 'queued')
      const slice = nextSlice()
      const env: Record<string, string> = {
        AUTOPW_RUN_ID: id,
        AUTOPW_WORKER_ID: workerId,
        AUTOPW_MODE: input.mode,
        AUTOPW_OUTPUT: runDir,
        AUTOPW_ASSETS: assetsDir,
        AUTOPW_LLM_ENDPOINT:
          input.settings.llmEndpoint ?? process.env.OPENFOX_LLM_URL ?? 'http://localhost:8000/v1',
        AUTOPW_LLM_MODEL:
          input.settings.llmModel ?? process.env.OPENFOX_MODEL_NAME ?? 'auto',
        AUTOPW_LLM_API_KEY: input.settings.llmApiKey ?? '',
        AUTOPW_HEADLESS: String(input.settings.headless),
        AUTOPW_MAX_PAGES: String(input.settings.maxPages ?? 20),
        AUTOPW_MAX_DURATION_MS: String(input.settings.maxDurationMs ?? 600000),
        AUTOPW_CB_ERRORS: String(input.settings.circuitBreakerErrors ?? 5),
        AUTOPW_CB_STALL_MS: String(input.settings.circuitBreakerStallMs ?? 60000),
        AUTOPW_SCREENSHOT_MODE: input.settings.screenshotMode ?? 'on-error',
        AUTOPW_ALLOWED_ORIGINS: JSON.stringify(input.settings.allowedOrigins ?? []),
        AUTOPW_SEEDS: JSON.stringify(slice),
        AUTOPW_AXE_AVAILABLE: input.mode === 'bugs' ? 'true' : 'false',
        AUTOPW_AXE_SOURCE: join(workdir, 'node_modules', 'axe-core', 'axe.min.js'),
      }
      const w = spawnWorker(this.workerEntry, env)
      run.children.push(w.child)
      run.workers.push(w)
      this.attachWorker(w, run, workerId)
      w.send({
        type: 'init',
        config: {
          runId: id,
          workerId,
          mode: input.mode,
          outputDir: runDir,
          outputRoot: runDir,
          llm: {
            endpoint: env.AUTOPW_LLM_ENDPOINT,
            model: env.AUTOPW_LLM_MODEL,
            apiKey: input.settings.llmApiKey,
          },
          ...(input.settings as any),
          seeds: slice,
        },
      } as WorkerMessageIn)
    }

    this.ctx.logger.info(
      `[orchestrator] run=${id} workers=${run.workerIds.length} seeds=${seeds.length} mode=${input.mode}`,
    )
    this.ctx.emitState()
    return id
  }

  private attachWorker(
    w: ManagedWorker,
    run: InternalRun,
    workerId: string,
  ): void {
    w.on('message', async (msg: WorkerMessageOut) => {
      run.lastActivityTs = Date.now()
      if (msg.type === 'finding') {
        run.findings.push(msg.payload)
        if (msg.payload.url) run.visitedUrls.add(msg.payload.url)
        try {
          await writeFile(
            join(run.runDir, 'raw', `${msg.payload.workerId}.jsonl`),
            JSON.stringify(msg.payload) + '\n',
            { flag: 'a' },
          )
          await writeFile(
            join(run.runDir, 'raw', 'bugs.jsonl'),
            JSON.stringify(msg.payload) + '\n',
            { flag: 'a' },
          )
        } catch (e: any) {
          this.ctx.logger.warn(`[orchestrator] write finding failed: ${e.message}`)
        }
        this.ctx.publish('playwright-runs', run.id, this.snapshot(run))
      } else if (msg.type === 'progress' || msg.type === 'heartbeat' || msg.type === 'ready') {
        run.workerStatus.set(workerId, 'running')
        this.ctx.publish('playwright-runs', run.id, this.snapshot(run))
      } else if (msg.type === 'done') {
        run.workerStatus.set(workerId, msg.payload.reason === 'breaker' ? 'stalled' : 'done')
        this.ctx.logger.info(
          `[worker ${workerId}] done reason=${msg.payload.reason} visited=${msg.payload.visited}`,
        )
      } else if (msg.type === 'error') {
        this.ctx.logger.error(`[worker ${workerId}] ${msg.payload.message}`)
      } else if (msg.type === 'log') {
        const fn = (this.ctx.logger as any)[msg.payload.level] ?? this.ctx.logger.info
        fn(`[worker ${workerId}] ${msg.payload.message}`)
      }
      this.ctx.emitState()
    })
    w.on('exit', async () => {
      const allExited = run.children.every((c: any) => c.exitCode !== null)
      if (!allExited) return
      if (run.status !== 'running') return
      const hadStalled = Array.from(run.workerStatus.values()).includes('stalled')
      run.status = hadStalled ? 'failed' : 'completed'
      run.finishedAt = new Date().toISOString()
      await this.finalizeRun(run)
      this.ctx.notify({
        title: STRINGS.notifyRunDone(run.findings.length),
        level: run.findings.length > 0 ? 'success' : 'info',
      })
      this.persistIndex()
      this.ctx.emitState()
    })
  }

  private async finalizeRun(run: InternalRun): Promise<void> {
    const reporters = resolveRunReporters(run.mode)
    for (const r of reporters) {
      try {
        await r.fn(run.findings, {
          runId: run.id,
          outDir: run.runDir,
          projectRoot: run.workdir,
          ghMode: run.settings.ghMode,
          ghLabel: run.settings.ghLabel,
          logger: this.ctx.logger,
        })
      } catch (e: any) {
        this.ctx.logger.error(`[reporter ${r.name}] ${e.message}`)
      }
    }
  }

  async stop(runId: string): Promise<boolean> {
    const run = this.runs.get(runId)
    if (!run) return false
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') return true
    // F27: still queued → mark stopRequested; Orchestrator.start() will short-circuit before spawning workers
    if (run.status === 'queued') {
      run.stopRequested = true
      run.status = 'stopped'
      run.finishedAt = new Date().toISOString()
      this.persistIndex()
      this.ctx.emitState()
      return true
    }
    run.status = 'stopped'
    await Promise.all(run.workers.map((w) => w.stop(5_000)))
    run.finishedAt = new Date().toISOString()
    this.persistIndex()
    this.ctx.emitState()
    return true
  }

  async cleanup(
    olderThanDays: number,
    dryRun = false,
  ): Promise<{ removed: number; kept: number; assetsRemoved: number }> {
    const cutoff = Date.now() - olderThanDays * 86_400_000
    const workdir = this.ctx.workdirProvider()
    const outputRoots = new Set<string>()
    const addRoot = (outputDir: string) => {
      outputRoots.add(isAbsolute(outputDir) ? outputDir : join(workdir, outputDir))
    }
    addRoot('.openfox-autonomous-playwright')
    for (const r of this.runs.values()) {
      if (r.settings?.outputDir) addRoot(r.settings.outputDir)
    }
    let removed = 0
    let kept = 0
    let assetsRemoved = 0
    for (const outputRoot of outputRoots) {
      const runsDir = join(outputRoot, 'runs')
      const assetsDir = join(outputRoot, 'assets')
      if (existsSync(runsDir)) {
        const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => [])
        for (const e of entries) {
          if (!e.isDirectory()) continue
          const full = join(runsDir, e.name)
          const s = await stat(full).catch(() => null)
          if (!s) continue
          if (s.mtimeMs < cutoff) {
            if (!dryRun) await rm(full, { recursive: true, force: true })
            removed++
          } else kept++
        }
      }
      if (existsSync(assetsDir)) {
        const assetEntries = await readdir(assetsDir, { withFileTypes: true }).catch(() => [])
        for (const e of assetEntries) {
          if (!e.isDirectory()) continue
          const full = join(assetsDir, e.name)
          const s = await stat(full).catch(() => null)
          if (!s) continue
          if (s.mtimeMs < cutoff) {
            if (!dryRun) await rm(full, { recursive: true, force: true })
            assetsRemoved++
          }
        }
      }
    }
    return { removed, kept, assetsRemoved }
  }

  findRunningForWorkdir(workdir: string): InternalRun | undefined {
    for (const r of this.runs.values()) {
      if ((r.status === 'running' || r.status === 'queued') && r.workdir === workdir) return r
    }
    return undefined
  }

  list(): RunState[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(id: string): RunState | undefined {
    return this.runs.get(id)
  }

  async shutdown(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.status === 'running') await this.stop(run.id)
    }
  }

  private snapshot(run: InternalRun) {
    const workerStatus = [...run.workerStatus.entries()]
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      findingsCount: run.findings.length,
      workerCount: run.workerIds.length,
      visitedCount: run.visitedUrls.size,
      stalledCount: workerStatus.filter(([, s]) => s === 'stalled').length,
      doneCount: workerStatus.filter(([, s]) => s === 'done').length,
      lastActivityTs: run.lastActivityTs,
      mode: run.mode,
      strategy: run.strategy,
      sampleFindings: run.findings.slice(-5),
    }
  }

  private redactSettings(s: PluginSettingsValues | undefined): PluginSettingsValues | undefined {
    if (!s) return s
    const { llmApiKey: _omit, ...safe } = s
    void _omit
    return safe as PluginSettingsValues
  }

  private persistIndex(): void {
    try {
      const full = this.list().map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        mode: r.mode,
        strategy: r.strategy,
        status: r.status,
        findings: r.findings.length,
        targetUrl: r.targetUrl,
        outputDir: r.settings?.outputDir,
        settings: this.redactSettings(r.settings),
        stopRequested: r.stopRequested ?? false,
      }))
      const idx = full.slice(0, MAX_RUN_INDEX_ENTRIES)
      this.ctx.storageSet('runs/index', idx)
    } catch (e: any) {
      this.ctx.logger.warn(`[orchestrator] persist failed: ${e.message}`)
    }
  }
}

import { DEFAULTS as DEFAULTS_FROM_HYDRATE } from './types.js'

const MAX_RUN_INDEX_ENTRIES = 50
