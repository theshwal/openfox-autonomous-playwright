export type RunMode = 'bugs' | 'faq' | 'docs'
export type Strategy = 'crawl-bfs' | 'seed-list' | 'sitemap' | 'llm-curated' | 'autodetect'
export type GhMode = 'preview' | 'auto' | 'off'
export type ScreenshotMode = 'on-error' | 'milestones' | 'off'

export interface PluginSettingsValues {
  targetUrl?: string
  concurrency: number
  strategy: Strategy
  seedUrls: string[]
  maxPages: number
  maxDepth: number
  maxDurationMs: number
  headless: boolean
  screenshotMode: ScreenshotMode
  outputDir: string
  llmEndpoint?: string
  llmModel?: string
  llmApiKey?: string
  allowedOrigins: string[]
  ghMode: GhMode
  ghLabel: string
  circuitBreakerErrors: number
  circuitBreakerStallMs: number
  retentionDays: number
}

export const DEFAULTS: PluginSettingsValues = {
  concurrency: 2,
  strategy: 'autodetect',
  seedUrls: [],
  maxPages: 20,
  maxDepth: 3,
  maxDurationMs: 600_000,
  headless: true,
  screenshotMode: 'on-error',
  outputDir: '.openfox-autonomous-playwright',
  allowedOrigins: [],
  ghMode: 'preview',
  ghLabel: 'autonomous-audit',
  circuitBreakerErrors: 5,
  circuitBreakerStallMs: 60_000,
  retentionDays: 30,
}

export function mergeSettings(raw: Record<string, unknown>): PluginSettingsValues {
  const out: PluginSettingsValues = { ...DEFAULTS, ...(raw as Partial<PluginSettingsValues>) }
  if (typeof out.seedUrls === 'string') {
    try {
      out.seedUrls = JSON.parse(out.seedUrls as unknown as string)
    } catch {
      out.seedUrls = []
    }
  }
  if (typeof out.allowedOrigins === 'string') {
    try {
      out.allowedOrigins = JSON.parse(out.allowedOrigins as unknown as string)
    } catch {
      out.allowedOrigins = []
    }
  }
  return out
}

export type FindingType =
  | 'bug-4xx'
  | 'bug-5xx'
  | 'bug-console'
  | 'bug-broken-link'
  | 'bug-form'
  | 'bug-a11y'
  | 'bug-visual'
  | 'faq-entry'
  | 'doc-section'

export interface Finding {
  ts: string
  workerId: string
  url: string
  type: FindingType
  severity?: 'low' | 'medium' | 'high' | 'critical'
  title: string
  evidence?: string
  screenshotPath?: string
  meta?: Record<string, unknown>
}

export type WorkerMessageOut =
  | { type: 'progress'; payload: { visited: number; queueSize: number } }
  | { type: 'finding'; payload: Finding }
  | { type: 'heartbeat'; payload: { ts: string; visited: number; inFlight: string } }
  | { type: 'ready'; payload: { workerId: string; runId: string } }
  | { type: 'done'; payload: { reason: 'limit' | 'breaker' | 'stopped' | 'completed'; visited: number; findings: number } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'log'; payload: { level: 'debug' | 'info' | 'warn' | 'error'; message: string } }

export type WorkerMessageIn =
  | { type: 'init'; config: import('./types.js').PluginSettingsValues & { runId: string; workerId: string; mode: RunMode; outputDir: string; outputRoot: string; llm: { endpoint: string; model: string; apiKey?: string } } }
  | { type: 'stop' }

export interface RunState {
  id: string
  startedAt: string
  finishedAt?: string
  mode: RunMode
  strategy: Strategy
  targetUrl: string
  workerIds: string[]
  children: import('node:child_process').ChildProcess[]
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped'
  findings: Finding[]
  visitedUrls: Set<string>
  lastActivityTs: number
  errorMessage?: string
  workdir?: string
  settings?: PluginSettingsValues
  runDir?: string
  assetsDir?: string
  stopRequested?: boolean
}
