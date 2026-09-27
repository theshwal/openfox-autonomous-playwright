import type {
  PluginRegistry,
  LocalizedString,
  PluginHookPayload,
  PluginToolContext,
  PluginSettingValue,
} from 'openfox/plugin'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { Orchestrator, type StartRunInput } from './orchestrator.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { totalmem } from 'node:os'
import { mergeSettings, type Finding, type RunMode, type Strategy, DEFAULTS } from './types.js'
import { STRINGS, t } from './i18n/strings.js'
import { _internal as reportersInternal } from './reporters/index.js'

const { ghRepoFromRemote: ghRepoFromRemoteReporter, renderIssueBody } = reportersInternal

export { Orchestrator } from './orchestrator.js'
export { mergeSettings } from './types.js'
export { DEFAULTS } from './types.js'

const t2 = (en: string, fr: string): LocalizedString => ({ en, fr })

interface RunSummary {
  id: string
  startedAt: string
  finishedAt?: string
  mode: string
  strategy: string
  status: string
  findings: number
  targetUrl: string
}

interface DiscoveryResult {
  gh: 'ok' | 'missing' | 'unauth'
  githubRemote?: string
  sitemapUrl?: string
  llmReachable: boolean
  llmModel: string
  playwrightInstalled: boolean
  chromiumVersion?: string
  recommendedStrategy: Strategy
  memory: { totalGb: number; warning?: string }
  robotsTxt?: { allowed: boolean; crawlDelayMs?: number }
}

interface RunStateView {
  id: string
  status: string
  findingsCount: number
  workerCount: number
  mode: string
  strategy: string
  sampleFindings: unknown[]
}

export function register(registry: PluginRegistry): () => Promise<void> {
  const ctx = registry.context
  const log = {
    debug: (...a: unknown[]) => ctx.logger.debug('[autonomous-pw] ' + a.join(' ')),
    info: (...a: unknown[]) => ctx.logger.info('[autonomous-pw] ' + a.join(' ')),
    warn: (...a: unknown[]) => ctx.logger.warn('[autonomous-pw] ' + a.join(' ')),
    error: (...a: unknown[]) => ctx.logger.error('[autonomous-pw] ' + a.join(' ')),
  }
  let workdir = '.'

  const orchestrator = new Orchestrator({
    logger: log,
    publish: (panelId, key, value) => ctx.publish(panelId, key, value),
    notify: (req) => ctx.notify(req as any),
    storageGet: <T = unknown>(k: string) => {
      const v = ctx.storage.get(k)
      if (v == null) return undefined as T | undefined
      try {
        return JSON.parse(String(v)) as T
      } catch {
        return (v as unknown) as T
      }
    },
    storageSet: (k, v) => ctx.storage.set(k, JSON.stringify(v) as any),
    workdirProvider: () => workdir,
    emitState: () => {
      try {
        ctx.publish(undefined, 'tick', Date.now())
      } catch {}
    },
  })
  orchestrator.hydrateFromStorage()

  try {
    const entry = resolveWorkerEntry()
    orchestrator.setWorkerEntry(entry)
    log.info('worker entry resolved', entry)
  } catch (e: any) {
    log.error('cannot resolve worker entry:', e.message)
  }

  registry.registerSettings({
    fields: [
      {
        key: 'targetUrl',
        type: 'text',
        label: t2('Target URL', 'URL cible'),
        section: t2('Target', 'Cible'),
        placeholder: 'https://example.com',
      },
      {
        key: 'strategy',
        type: 'select',
        label: t2("Exploration strategy", "Stratégie d'exploration"),
        section: t2('Target', 'Cible'),
        default: DEFAULTS.strategy,
        options: [
          { value: 'autodetect', label: t2('Auto-detect', 'Auto-détection') },
          { value: 'crawl-bfs', label: t2('Crawl BFS', 'Crawl BFS') },
          { value: 'seed-list', label: t2('Seed list', 'Liste de seeds') },
          { value: 'sitemap', label: t2('Sitemap', 'Sitemap') },
          { value: 'llm-curated', label: t2('LLM curated', 'Curated par LLM') },
        ],
      },
      {
        key: 'seedUrls',
        type: 'textarea',
        label: t2('Seed URLs (JSON)', 'URLs seeds (JSON)'),
        section: t2('Target', 'Cible'),
        description: t2('JSON array of URLs (for seed-list)', "Tableau JSON d'URLs (pour seed-list)"),
      },
      {
        key: 'allowedOrigins',
        type: 'textarea',
        label: t2('Allowed origins (JSON)', 'Origines autorisées (JSON)'),
        section: t2('Target', 'Cible'),
        description: t2('JSON regex array', 'Tableau de regex JSON'),
      },
      {
        key: 'concurrency',
        type: 'number',
        label: t2('Concurrency', 'Concurrence'),
        section: t2('Execution', 'Exécution'),
        default: DEFAULTS.concurrency,
      },
      {
        key: 'maxPages',
        type: 'number',
        label: t2('Max pages (per worker)', 'Pages max (par worker)'),
        section: t2('Execution', 'Exécution'),
        default: DEFAULTS.maxPages,
      },
      {
        key: 'maxDepth',
        type: 'number',
        label: t2('Max depth', 'Profondeur max'),
        section: t2('Execution', 'Exécution'),
        default: DEFAULTS.maxDepth,
      },
      {
        key: 'maxDurationMs',
        type: 'number',
        label: t2('Max duration (ms)', 'Durée max (ms)'),
        section: t2('Execution', 'Exécution'),
        default: DEFAULTS.maxDurationMs,
      },
      {
        key: 'headless',
        type: 'boolean',
        label: t2('Headless', 'Headless'),
        section: t2('Execution', 'Exécution'),
        default: DEFAULTS.headless,
      },
      {
        key: 'screenshotMode',
        type: 'select',
        label: t2('Screenshot mode', 'Mode capture'),
        section: t2('Output', 'Sortie'),
        default: DEFAULTS.screenshotMode,
        options: [
          { value: 'on-error', label: t2('On error', 'Sur erreur') },
          { value: 'milestones', label: t2('Milestones', 'Étapes clés') },
          { value: 'off', label: t2('Off', 'Désactivé') },
        ],
      },
      {
        key: 'outputDir',
        type: 'path',
        label: t2('Output dir', 'Dossier de sortie'),
        section: t2('Output', 'Sortie'),
        default: DEFAULTS.outputDir,
      },
      {
        key: 'ghMode',
        type: 'select',
        label: t2('GitHub mode (bugs)', 'Mode GitHub (bugs)'),
        section: t2('Output', 'Sortie'),
        default: DEFAULTS.ghMode,
        options: [
          { value: 'preview', label: t2('Preview (review before)', 'Preview (revue avant)') },
          { value: 'auto', label: t2('Auto', 'Auto') },
          { value: 'off', label: t2('Off', 'Désactivé') },
        ],
      },
      {
        key: 'ghLabel',
        type: 'text',
        label: t2('GH label', 'Label GH'),
        section: t2('Output', 'Sortie'),
        default: DEFAULTS.ghLabel,
      },
      {
        key: 'llmEndpoint',
        type: 'text',
        label: t2('LLM endpoint', 'Endpoint LLM'),
        section: t2('LLM', 'LLM'),
        description: t2('Falls back to OPENFOX_LLM_URL', 'Fallback sur OPENFOX_LLM_URL'),
      },
      {
        key: 'llmModel',
        type: 'text',
        label: t2('LLM model', 'Modèle LLM'),
        section: t2('LLM', 'LLM'),
        description: t2('Falls back to OPENFOX_MODEL_NAME', 'Fallback sur OPENFOX_MODEL_NAME'),
      },
      {
        key: 'llmApiKey',
        type: 'password',
        label: t2('LLM API key', 'Clé API LLM'),
        section: t2('LLM', 'LLM'),
        secret: true,
      },
      {
        key: 'circuitBreakerErrors',
        type: 'number',
        label: t2('CB errors', 'Erreurs CB'),
        section: t2('Safety', 'Sécurité'),
        default: DEFAULTS.circuitBreakerErrors,
      },
      {
        key: 'circuitBreakerStallMs',
        type: 'number',
        label: t2('CB stall ms', 'Stall CB (ms)'),
        section: t2('Safety', 'Sécurité'),
        default: DEFAULTS.circuitBreakerStallMs,
      },
      {
        key: 'retentionDays',
        type: 'number',
        label: t2('Retention (days)', 'Rétention (jours)'),
        section: t2('Safety', 'Sécurité'),
        default: DEFAULTS.retentionDays,
      },
    ],
  })

  registry.registerTool({
    name: 'playwright_run',
    description:
      'Launch parallel Playwright agents against a target URL. mode: bugs | faq | docs. Returns {runId}.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL (defaults to settings.targetUrl)' },
        mode: { type: 'string', enum: ['bugs', 'faq', 'docs'] },
        strategy: {
          type: 'string',
          enum: ['autodetect', 'crawl-bfs', 'seed-list', 'sitemap', 'llm-curated'],
        },
        concurrency: { type: 'number', minimum: 1, maximum: 4 },
        force: {
          type: 'boolean',
          description:
            'Bypass the same-workdir active-run guard. Use runs.stop first, or force=true to start anyway.',
          default: false,
        },
      },
      required: ['mode'],
    },
    execute: async (args: Record<string, unknown>, execCtx: PluginToolContext) => {
      try {
        const settings = readSettings(registry, execCtx)
        const url = (args.url as string) ?? settings.targetUrl ?? ''
        if (!url) return { success: false, error: 'no target URL (provide one or set in settings)' }
        const mode = (args.mode as RunMode) ?? 'bugs'
        const strategy = (args.strategy as Strategy) ?? settings.strategy ?? 'autodetect'
        const concurrency = (args.concurrency as number) ?? settings.concurrency ?? 2
        const force = Boolean(args.force)
        if (execCtx.workdir) workdir = execCtx.workdir
        const activeRun = orchestrator.findRunningForWorkdir(workdir)
        if (activeRun && !force) {
          return {
            success: false,
            error: `a Playwright run is already active for this project (runId=${activeRun.id}). Pass {force:true} to start another or call runs.stop first.`,
          }
        }
        if (mode === 'bugs') {
          // C21: ensure axe-core is available for the run (lightweight install-on-demand)
          let axePresent = false
          try {
            const probe = execFileSync('node', [
              '-e',
              `try { require.resolve('axe-core', { paths: [${JSON.stringify(workdir)}] }); console.log('ok') } catch { console.log('missing') }`,
            ], { encoding: 'utf8' }).trim()
            axePresent = probe === 'ok'
          } catch {
            axePresent = false
          }
          if (axePresent) {
            log.info('axe-core already present in target workdir')
          } else {
            log.info('axe-core not found, installing --no-save')
            const r = spawnSync(
              'npm',
              ['install', '--no-save', '--silent', '--prefix', workdir, 'axe-core'],
              { encoding: 'utf8' },
            )
            if (r.status === 0) log.info('axe-core installed for the run')
            else log.warn(`axe-core install returned non-zero (${r.status}); axe-core scan disabled.`)
          }
        }
        const runId = await orchestrator.start({
          mode,
          strategy,
          targetUrl: url,
          concurrency,
          settings,
        })
        return {
          success: true,
          output: JSON.stringify({
            runId,
            mode,
            strategy,
            targetUrl: url,
            concurrency,
          }),
        }
      } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) }
      }
    },
  })

  registry.registerTool({
    name: 'playwright_discover',
    description:
      'Probe the project environment without spawning workers. Returns gh, sitemap, llm, memory info and recommended strategy.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args: Record<string, unknown>, execCtx: PluginToolContext) => {
      try {
        const wd = execCtx.workdir ?? workdir
        const settings = readSettings(registry, execCtx)
        const result = await discover(wd, settings)
        return { success: true, output: JSON.stringify(result) }
      } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) }
      }
    },
  })

  registry.registerCommand({
    id: 'playwright-bugs',
    name: 'Playwright: bug-hunt',
    prompt: 'Use playwright_run with mode="bugs" against the URL provided: {{args}}',
    agentMode: 'builder',
  })
  registry.registerCommand({
    id: 'playwright-faq',
    name: 'Playwright: FAQ',
    prompt: 'Use playwright_run with mode="faq" against the URL provided: {{args}}',
    agentMode: 'builder',
  })
  registry.registerCommand({
    id: 'playwright-docs',
    name: 'Playwright: docs',
    prompt: 'Use playwright_run with mode="docs" against the URL provided: {{args}}',
    agentMode: 'builder',
  })
  registry.registerCommand({
    id: 'playwright-status',
    name: 'Playwright: status',
    prompt: 'Use runs.list RPC to summarize active Playwright runs. Empty input: {{args}}',
    agentMode: 'builder',
  })
  registry.registerCommand({
    id: 'playwright-stop',
    name: 'Playwright: stop',
    prompt:
      'Use runs.stop RPC with the runId from {{args}}. Confirm with the user before stopping.',
    agentMode: 'builder',
  })

  registry.registerSkillSource({
    id: 'autonomous-playwright',
    label: t2('Autonomous Playwright', 'Playwright Autonome'),
    load: () => [
      {
        id: 'playwright-audit',
        name: 'Audit a web project',
        description:
          'Launch N parallel Playwright agents against a target URL for bug-hunting, FAQ or documentation.',
        prompt:
          "To audit a project: (1) call playwright_discover to probe the environment; (2) decide mode based on user intent (bugs / faq / docs); (3) call playwright_run with the resolved URL, the chosen mode, and strategy=autodetect unless the user provided one; (4) once the run completes, summarize the findings referenced in runs.get and the Markdown files (BUGS.md / FAQ.md / DOCS.md) created in the project root.",
      },
    ],
  })

  registry.registerUiAction({
    id: 'autopw-launch',
    slot: 'header.actions',
    label: STRINGS.headerLaunch,
    icon: 'puzzle',
    onActivate: { kind: 'openPanel', panelId: 'autopw-new-run' },
  })

  registry.registerUiAction({
    id: 'autopw-insert-report',
    slot: 'composer.actions',
    label: t2('Insert latest report', 'Insérer dernier rapport'),
    icon: 'plus',
    onActivate: { kind: 'rpc', method: 'report.insertLatest' },
    visibleWhen: { hasMessage: false },
  })

  registry.registerUiPanel({
    id: 'autopw-new-run',
    title: STRINGS.newRunPanelTitle,
    size: 'md',
    kind: 'declarative',
    content: [
      { type: 'text', text: STRINGS.pluginDescription },
      {
        type: 'input',
        id: 'autopw-url',
        placeholder: t2('https://example.com', 'https://exemple.com'),
        label: t2('Target URL', 'URL cible'),
      },
      {
        type: 'select',
        id: 'autopw-mode',
        label: t2('Mode', 'Mode'),
        defaultValue: 'bugs',
        options: [
          { value: 'bugs', label: t2('Bug-hunt', 'Détection de bugs') },
          { value: 'faq', label: t2('FAQ', 'FAQ') },
          { value: 'docs', label: t2('Docs', 'Documentation') },
        ],
      },
      {
        type: 'button',
        label: t2('Run', 'Lancer'),
        onActivate: { kind: 'rpc', method: 'runs.start' },
      },
    ],
  })

  registry.registerUiPanel({
    id: 'playwright-runs',
    title: STRINGS.runsPanelTitle,
    size: 'xl',
    kind: 'declarative',
    content: [
      {
        type: 'text',
        text: t2(
          'Live runs and findings (refresh every 2s).',
          'Runs live et résultats (refresh 2s).',
        ),
      },
      {
        type: 'table',
        columns: [
          t2('Run', 'Run'),
          t2('Mode', 'Mode'),
          t2('Status', 'Statut'),
          t2('Workers', 'Workers'),
          t2('Findings', 'Résultats'),
        ],
        rows: [],
      },
    ],
  })

  registry.registerUiPanel({
    id: 'playwright-bugs-review',
    title: STRINGS.bugsReviewPanelTitle,
    size: 'full',
    kind: 'declarative',
    content: [
      {
        type: 'text',
        text: t2(
          'Review the bug candidates before creating GitHub issues.',
          'Revoyez les candidats bugs avant de créer les issues GitHub.',
        ),
      },
      {
        type: 'button',
        label: t2('Apply selected', 'Appliquer la sélection'),
        onActivate: { kind: 'rpc', method: 'gh.applyCandidates' },
      },
    ],
  })

  registry.registerUiPanel({
    id: 'playwright-report',
    title: STRINGS.reportPanelTitle,
    size: 'xl',
    kind: 'iframe',
    url: 'assets/report.html',
  })

  registry.registerUiBadge({
    id: 'autopw-status',
    slot: 'session.row.badges',
    label: STRINGS.badgeIdle,
    icon: 'play',
    appearance: 'icon',
    visibleWhen: { hasSession: true },
    source: {
      kind: 'rpc',
      method: 'sessionStatus',
      refreshMs: 2000,
      cacheScope: 'project',
    },
  })

  registry.registerRpc('sessionStatus', async (_params, execCtx) => {
    try {
      const wd = execCtx?.workdir ?? workdir
      const runsForWd = orchestrator.list().filter((r) => r.workdir === wd)
      const running = runsForWd.find((r) => r.status === 'running')
      if (running) {
        return {
          visible: true,
          label: t2(`PW ${running.mode}…`, `PW ${running.mode}…`),
          tone: 'info',
        } as any
      }
      const stalled = runsForWd.find((r) => r.status === 'failed')
      if (stalled) {
        return {
          visible: true,
          label: t2(`PW failed`, `PW échoué`),
          tone: 'danger',
        } as any
      }
      const done = runsForWd.find((r) => r.status === 'completed' || r.status === 'stopped')
      if (done) {
        return {
          visible: true,
          label: t2(`PW done`, `PW terminé`),
          tone: 'success',
        } as any
      }
      return { visible: false } as any
    } catch {
      return { visible: false }
    }
  })

  registry.registerRpc('runs.list', async () => {
    return orchestrator.list().map((r): RunSummary => ({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      mode: r.mode,
      strategy: r.strategy,
      status: r.status,
      findings: r.findings.length,
      targetUrl: r.targetUrl,
    }))
  })

  registry.registerRpc('runs.get', async (params: Record<string, unknown>) => {
    const id = String((params as any).id ?? '')
    const r = orchestrator.get(id)
    if (!r) return null
    const view: RunStateView = {
      id: r.id,
      status: r.status,
      findingsCount: r.findings.length,
      workerCount: r.workerIds.length,
      mode: r.mode,
      strategy: r.strategy,
      sampleFindings: r.findings.slice(-5) as unknown[],
    }
    return view
  })

  registry.registerRpc('runs.start', async (params: Record<string, unknown>, execCtx: PluginToolContext) => {
    if (execCtx?.workdir) workdir = execCtx.workdir
    const settings = readSettings(registry, execCtx)
    const url = (params?.url as string) ?? settings.targetUrl ?? ''
    if (!url) throw new Error('no target URL provided and none in settings')
    const force = Boolean(params?.force)
    const activeRun = orchestrator.findRunningForWorkdir(workdir)
    if (activeRun && !force) {
      throw new Error(
        `a Playwright run is already active for this project (runId=${activeRun.id}). Pass {force:true} to start another or call runs.stop first.`,
      )
    }
    const input: StartRunInput = {
      mode: ((params?.mode as RunMode) ?? 'bugs'),
      strategy: ((params?.strategy as Strategy) ?? settings.strategy ?? 'autodetect'),
      targetUrl: url,
      concurrency: ((params?.concurrency as number) ?? settings.concurrency ?? 2),
      settings,
    }
    return await orchestrator.start(input)
  })

  registry.registerRpc('runs.stop', async (params: Record<string, unknown>) => {
    const id = String((params as any).id ?? '')
    return await orchestrator.stop(id)
  })

  registry.registerRpc('runs.cleanup', async (params: Record<string, unknown> = {}) => {
    const olderThanDays = Number((params as any).olderThanDays ?? 30)
    const dryRun = Boolean((params as any).dryRun)
    return await orchestrator.cleanup(olderThanDays, dryRun)
  })

  registry.registerRpc('report.preview', async (params: Record<string, unknown>) => {
    const id = String((params as any).id ?? '')
    const kind = (params as any).kind as 'bug' | 'faq' | 'docs'
    const run = orchestrator.get(id)
    if (!run) return { runId: id, kind, found: false }
    const cwd = run.workdir ?? ''
    const candidates = [
      join(run.runDir ?? '', 'BUGS.md'),
      join(run.runDir ?? '', 'FAQ.md'),
      join(run.runDir ?? '', 'DOCS.md'),
      join(cwd, 'BUGS.md'),
      join(cwd, 'FAQ.md'),
      join(cwd, 'DOCS.md'),
    ]
    const fileMap: Record<string, string[]> = {
      bug: [candidates[0], candidates[3]],
      faq: [candidates[1], candidates[4]],
      docs: [candidates[2], candidates[5]],
    }
    const ordered = fileMap[kind] ?? []
    let content = ''
    let found = false
    let picked: string | null = null
    for (const p of ordered) {
      try {
        const { readFileSync } = await import('node:fs')
        content = readFileSync(p, 'utf8')
        found = true
        picked = p
        break
      } catch {}
    }
    return {
      runId: id,
      kind,
      found,
      path: picked,
      preview: content.slice(0, 8_000),
      length: content.length,
    }
  })

  registry.registerRpc('report.insertLatest', async () => {
    const workdirRoot = workdir
    const files = ['BUGS.md', 'FAQ.md', 'DOCS.md']
    for (const f of files) {
      const p = join(workdirRoot, f)
      if (existsSync(p)) return { inserted: f, path: p }
    }
    return { inserted: null, path: null }
  })

  registry.registerRpc('gh.applyCandidates', async (params: Record<string, unknown> = {}) => {
    const runId = String((params as any).runId ?? '')
    const ids = Array.isArray((params as any).ids) ? (params as any).ids : []
    const run = orchestrator.get(runId)
    if (!run) return { applied: 0, error: 'unknown runId' }
    const candidatesPath = join(run.runDir ?? '', 'candidates.json')
    let candidates: Array<Finding & { _key?: string }> = []
    try {
      const { readFileSync } = await import('node:fs')
      candidates = JSON.parse(readFileSync(candidatesPath, 'utf8'))
    } catch {
      candidates = run.findings.filter((f) => f.type.startsWith('bug')) as Array<Finding & { _key?: string }>
    }
    const selected = candidates.filter((c) => ids.includes(c._key))
    const auditId = run.id
    const created: string[] = []
    const { spawnSync } = await import('node:child_process')
    const ghAuth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
    if (ghAuth.status !== 0) return { applied: 0, error: 'gh not authenticated' }
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: run.workdir ?? workdir,
      encoding: 'utf8',
    })
    const repo = ghRepoFromRemoteReporter(remote.stdout?.trim() ?? '')
    if (!repo) return { applied: 0, error: 'cannot determine gh repo' }
    for (const c of selected) {
      const body = renderIssueBody(c, auditId)
      const r = spawnSync(
        'gh',
        [
          'issue',
          'create',
          '--repo',
          repo,
          '--label',
          run.settings?.ghLabel ?? 'autonomous-audit',
          '--title',
          c.title,
          '--body',
          body,
        ],
        { encoding: 'utf8' },
      )
      if (r.status === 0) {
        const line = r.stdout.split('\n').find((l) => /https?:\/\//.test(l))
        if (line) created.push(line.trim())
      }
    }
    return { applied: created.length, urls: created }
  })

  registry.registerRpc('pool.stats', async () => {
    const runs = orchestrator.list()
    return {
      runsInMemory: runs.length,
      running: runs.filter((r) => r.status === 'running').length,
      queued: runs.filter((r) => r.status === 'queued').length,
      completed: runs.filter((r) => r.status === 'completed').length,
      failed: runs.filter((r) => r.status === 'failed').length,
      totalFindings: runs.reduce((acc, r) => acc + r.findings.length, 0),
      memoryGb: Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    }
  })

  registry.registerRpc('config.validate', async (_params, execCtx: PluginToolContext) => {
    const s = readSettings(registry, execCtx)
    const pkgRoot = getPkgRoot()
    const llmReachable = await probeLLMReachable(s.llmEndpoint)
    const { spawnSync } = await import('node:child_process')
    const ghAuth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
    return {
      hasLLM: !!((s.llmEndpoint || process.env.OPENFOX_LLM_URL) && llmReachable),
      llmReachable,
      hasPlaywright: existsSync(join(pkgRoot, 'node_modules', 'playwright')),
      ghAuthed: ghAuth.status === 0,
      targetUrl: s.targetUrl,
      allowedOrigins: s.allowedOrigins,
    }
  })

  registry.registerHook('session.created', async (payload: PluginHookPayload) => {
    try {
      // F35: update workdir BEFORE reading settings so the check uses the current session's workdir
      if (payload.data?.workdir) workdir = String(payload.data.workdir)
      const settings = readSettings(registry, { ...payload, workdir } as any)
      if (!settings.targetUrl) return
      ctx.notify({
        title: STRINGS.sessionStartPrompt,
        level: 'info',
        actions: [
          {
            label: t2('Yes', 'Oui'),
            onActivate: {
              kind: 'rpc',
              method: 'runs.start',
              params: { mode: 'bugs' },
            },
          },
          {
            label: t2('Configure first', "Configurer d'abord"),
            onActivate: { kind: 'openPanel', panelId: 'autopw-new-run' },
          },
        ],
      })
    } catch {}
  })

  registry.registerHook('turn.completed', async (payload: PluginHookPayload) => {
    if (!payload?.sessionId) return
    try {
      ctx.storage.set(`metrics:${payload.sessionId}` as any, JSON.stringify(payload.data ?? {}) as any)
      try {
        const raw = ctx.storage.get('runs/index')
        const idx = raw ? JSON.parse(String(raw)) : []
        if (Array.isArray(idx) && idx.length > 50) {
          const cap = idx.slice(0, 50)
          ctx.storage.set('runs/index' as any, JSON.stringify(cap) as any)
        }
      } catch {}
    } catch {}
  })

  registry.registerAsset('assets/report.html')

  ctx.notify({
    title: STRINGS.pluginName,
    body: STRINGS.pluginDescription,
    level: 'info',
  })

  return async () => {
    log.info('deactivating; shutting down orchestrator')
    await orchestrator.shutdown()
  }
}

function readSettings(
  registry: PluginRegistry,
  execCtx?: PluginToolContext,
): ReturnType<typeof mergeSettings> {
  try {
    const raw = registry.context.settings('project', execCtx?.projectId)
    return mergeSettings(raw as Record<string, unknown>)
  } catch {
    return mergeSettings({})
  }
}

function resolveWorkerEntry(): string {
  const candidates = [
    join(getPkgRoot(), 'worker.js'),
    join(getPkgRoot(), 'dist', 'worker.js'),
    join(getPkgRoot(), 'src', 'worker.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

function getPkgRoot(): string {
  const url = new URL(import.meta.url).pathname
  const here = url.replace(/\/index\.[mc]?[jt]s$/, '').replace(/\/[a-z-]+\.js$/, '')
  return here && here.length > 0 ? here : process.cwd()
}

async function discover(
  workdir: string,
  settings: ReturnType<typeof mergeSettings>,
): Promise<DiscoveryResult> {
  const { totalmem } = await import('node:os')
  const totalGb = Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10
  const warning =
    totalGb < 8 ? `Only ${totalGb} GB total RAM — consider concurrency=1.` : undefined
  const llmEndpoint = settings.llmEndpoint || process.env.OPENFOX_LLM_URL || ''
  let llmReachable = false
  try {
    if (llmEndpoint) {
      const base = llmEndpoint.replace(/\/v1\/?$/, '')
      const res = await fetch(`${base}/models`, { method: 'GET' }).catch(() => null)
      llmReachable = !!res && res.ok
    }
  } catch {
    llmReachable = false
  }
  let robotsTxt: { allowed: boolean; crawlDelayMs?: number } | undefined
  if (settings.targetUrl) {
    try {
      const r = await fetch(new URL('/robots.txt', settings.targetUrl).toString(), {
        headers: { 'user-agent': 'Mozilla/5.0' },
      }).catch(() => null)
      if (r?.ok) {
        const text = await r.text()
        const disallowedGlobal = /^User-agent:\s*\*[\s\S]+?Disallow:\s*\/\s*$/im.test(text)
        robotsTxt = { allowed: !disallowedGlobal }
        const dl = text.match(/Crawl-delay:\s*(\d+)/i)
        if (dl) robotsTxt.crawlDelayMs = Number(dl[1]) * 1000
      }
    } catch {}
  }
  let ghState: DiscoveryResult['gh'] = 'missing'
  let githubRemote: string | undefined
  try {
    const { spawnSync } = await import('node:child_process')
    const status = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
    if (status.status === 0) ghState = 'ok'
    else ghState = 'unauth'
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: workdir,
      encoding: 'utf8',
    })
    if (remote.stdout) githubRemote = remote.stdout.trim()
  } catch {}
  const pkgRoot = getPkgRoot()
  const playwrightInstalled = existsSync(join(pkgRoot, 'node_modules', 'playwright'))
  let chromiumVersion: string | undefined
  chromiumVersion = await detectChromiumVersion(pkgRoot)
  let sitemapUrl: string | undefined
  let recommendedStrategy: Strategy = 'crawl-bfs'
  if (settings.targetUrl) {
    sitemapUrl = new URL('/sitemap.xml', settings.targetUrl).toString()
    try {
      const r = await fetch(sitemapUrl, { method: 'HEAD' }).catch(() => null)
      if (r?.ok) recommendedStrategy = 'sitemap'
    } catch {}
  }
  return {
    gh: ghState,
    githubRemote,
    sitemapUrl,
    llmReachable,
    llmModel: settings.llmModel ?? process.env.OPENFOX_MODEL_NAME ?? 'unknown',
    playwrightInstalled,
    chromiumVersion,
    recommendedStrategy,
    memory: { totalGb, warning },
    robotsTxt,
  }
}

async function detectChromiumVersion(pkgRoot: string): Promise<string | undefined> {
  // 1. Most reliable: presence of INSTALLATION_COMPLETE in the cache dir
  try {
    const { readdirSync, existsSync } = await import('node:fs')
    const base = join(pkgRoot, 'node_modules', 'playwright-core', '.local-browsers')
    if (!existsSync(base)) return undefined
    const subdirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
    const chromium = subdirs.find((d) => d.name.startsWith('chromium-'))
    if (chromium) return chromium.name.replace(/^chromium-/, '')
    if (subdirs.find((d) => d.name === 'chromium')) return 'headless-shells'
  } catch {}
  // 2. Fallback: shell out to `npx playwright --version`
  try {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('npx', ['--no-install', 'playwright', '--version'], { encoding: 'utf8' })
    if (r.status === 0) return (r.stdout || r.stderr || '').trim().split(/\s+/).pop()
  } catch {}
  return undefined
}

async function probeLLMReachable(endpoint: string | undefined): Promise<boolean> {
  const url = endpoint || process.env.OPENFOX_LLM_URL
  if (!url) return false
  try {
    const base = url.replace(/\/v1\/?$/, '')
    const res = await fetch(`${base}/models`, { method: 'GET' }).catch(() => null)
    return !!res && res.ok
  } catch {
    return false
  }
}
