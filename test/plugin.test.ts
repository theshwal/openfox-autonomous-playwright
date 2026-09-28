import { describe, it, expect } from 'vitest'
import { register } from '../src/index.js'
import { _internal as reporters } from '../src/reporters/index.js'
import { mergeSettings, DEFAULTS } from '../src/types.js'
import { STRINGS, isLocalized, type LocalizedString } from '../src/i18n/strings.js'

interface FakeRegistry {
  context: any
  calls: Record<string, any[]>
  registerTool(t: any): void
  registerCommand(c: any): void
  registerSkillSource(s: any): void
  registerSettings(s: any): void
  registerRpc(method: string, handler: any): void
  registerUiAction(a: any): void
  registerUiBadge(b: any): void
  registerUiPanel(p: any): void
  registerHook(event: string, handler: any): void
  registerAsset(p: string): void
  deactivateCallbacks: Array<() => Promise<void> | void>
}

function makeFakeRegistry(): FakeRegistry {
  const calls: Record<string, any[]> = {}
  const reg: any = {} as any
  const push = (k: string) => (v: any) => {
    if (!calls[k]) calls[k] = []
    calls[k].push(v)
  }
  ;(reg as any).context = {
    id: 'openfox-autonomous-playwright',
    version: '0.1.0',
    runtime: { mode: 'production' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    settings: async () => ({}),
    notify: () => {},
    publish: () => {},
  }
  reg.registerTool = push('tool')
  reg.registerCommand = push('command')
  reg.registerSkillSource = push('skill')
  reg.registerSettings = push('settings')
  reg.registerRpc = (method: string, handler: any) => {
    if (!calls.rpc) calls.rpc = []
    calls.rpc.push({ method, handler })
  }
  reg.registerUiAction = push('uiAction')
  reg.registerUiBadge = push('uiBadge')
  reg.registerUiPanel = push('uiPanel')
  reg.registerHook = push('hook')
  reg.registerAsset = push('asset')
  return Object.assign(reg as FakeRegistry, { calls })
}

describe('plugin register()', () => {
  it('exports a register function', () => {
    expect(typeof register).toBe('function')
  })

  it('registers the expected contributions', async () => {
    const fake = makeFakeRegistry()
    const deactivate = register(fake as any)
    expect(typeof deactivate).toBe('function')

    const toolNames = fake.calls.tool.map((t) => t.name)
    expect(toolNames).toContain('playwright_run')
    expect(toolNames).toContain('playwright_discover')

    const cmdIds = fake.calls.command.map((c) => c.id)
    expect(cmdIds).toContain('playwright-bugs')
    expect(cmdIds).toContain('playwright-faq')
    expect(cmdIds).toContain('playwright-docs')
    expect(cmdIds).toContain('playwright-status')
    expect(cmdIds).toContain('playwright-stop')

    const rpcMethods = fake.calls.rpc.map((r) => r.method)
    expect(rpcMethods).toContain('playwright.runs.list')
    expect(rpcMethods).toContain('playwright.runs.start')
    expect(rpcMethods).toContain('playwright.runs.stop')
    expect(rpcMethods).toContain('playwright.config.validate')

    const actionIds = fake.calls.uiAction.map((a) => a.id)
    expect(actionIds).toContain('autopw-launch')

    const panelIds = fake.calls.uiPanel.map((p) => p.id)
    expect(panelIds).toContain('autopw-new-run')
    expect(panelIds).toContain('playwright-runs')
    expect(panelIds).toContain('playwright-bugs-review')

    const hookEvents = fake.calls.hook
    expect(hookEvents).toContain('session.created')
    expect(hookEvents).toContain('turn.completed')

    expect(fake.calls.asset?.map((p: any) => p.path ?? p)).toContain('assets/report.html')

    const skills = fake.calls.skill[0]?.load()
    expect(Array.isArray(skills)).toBe(true)
    expect(skills[0].id).toBe('playwright-audit')

    await deactivate()
  })

  it('settings schema covers all defaults', () => {
    const fake = makeFakeRegistry()
    register(fake as any)
    const fields = fake.calls.settings[0].fields
    const keys = fields.map((f: any) => f.key)
    expect(keys).toContain('targetUrl')
    expect(keys).toContain('strategy')
    expect(keys).toContain('concurrency')
    expect(keys).toContain('ghMode')
    expect(keys).toContain('circuitBreakerErrors')
    for (const f of fields) {
      expect(typeof f.label.en).toBe('string')
      expect(typeof f.label.fr).toBe('string')
      expect(f.label.en.length).toBeGreaterThan(0)
      expect(f.label.fr.length).toBeGreaterThan(0)
    }
  })

  it('playwright.runs.start RPC errors when no URL', async () => {
    const fake = makeFakeRegistry()
    register(fake as any)
    const start = fake.calls.rpc.find((r: any) => r.method === 'playwright.runs.start').handler
    await expect(start({})).rejects.toThrow(/no target URL/i)
  })
})

describe('reporters helpers', () => {
  it('levenshtein handles basic cases', () => {
    expect(reporters.levenshtein('abc', 'abc')).toBe(0)
    expect(reporters.levenshtein('abc', 'abd')).toBe(1)
    expect(reporters.levenshtein('kitten', 'sitting')).toBe(3)
  })

  it('dedupe collapses near-duplicates by URL+normalizedTitle', () => {
    const f = (overrides: Partial<{ url: string; title: string; ts?: string; workerId?: string; type: any; severity?: any; }>): any => ({
      ts: '2024-01-01T00:00:00Z',
      workerId: 'w1',
      url: 'https://example.com/x',
      type: 'bug-4xx',
      severity: 'medium',
      title: '404 not found',
      ...overrides,
    })
    const list = [
      f({ title: '404 not found' }),
      f({ title: '404 not found!', url: 'https://example.com/y' }),
      f({ title: 'Different title' }),
    ]
    const out = reporters.dedupe(list as any)
    expect(out.length).toBeGreaterThanOrEqual(2)
  })

  it('renderBugsMd produces markdown with title and url', () => {
    const md = reporters.renderBugsMd([
      {
        ts: 'x',
        workerId: 'w',
        url: 'https://example.com',
        type: 'bug-5xx',
        severity: 'high',
        title: 'Crash on /login',
        evidence: 'stack trace ...',
      },
    ], 'test-audit')
    expect(md).toContain('# Bug audit')
    expect(md).toContain('Crash on /login')
    expect(md).toContain('https://example.com')
  })

  it('ghRepoFromRemote extracts owner/repo', () => {
    expect(reporters.ghRepoFromRemote('https://github.com/foo/bar.git')).toBe('foo/bar')
    expect(reporters.ghRepoFromRemote('git@github.com:foo/bar.git')).toBe('foo/bar')
    expect(reporters.ghRepoFromRemote('')).toBe(null)
  })
})

describe('mergeSettings', () => {
  it('fills defaults when no input', () => {
    const s = mergeSettings({})
    expect(s.concurrency).toBe(DEFAULTS.concurrency)
    expect(s.ghMode).toBe('preview')
    expect(s.maxPages).toBe(20)
  })

  it('parses JSON strings for seedUrls', () => {
    const s = mergeSettings({ seedUrls: '["https://a","https://b"]' })
    expect(s.seedUrls).toEqual(['https://a', 'https://b'])
  })

  it('falls back to empty array on invalid JSON', () => {
    const s = mergeSettings({ seedUrls: 'not json' })
    expect(s.seedUrls).toEqual([])
  })
})

describe('i18n strings', () => {
  it('every LocalizedString contains both en and fr', () => {
    const check = (label: LocalizedString, path: string) => {
      expect(isLocalized(label), `${path} not LocalizedString`).toBe(true)
      expect(typeof label.en, `${path}.en missing`).toBe('string')
      expect(typeof label.fr, `${path}.fr missing`).toBe('string')
      expect(label.en.length).toBeGreaterThan(0)
      expect(label.fr.length).toBeGreaterThan(0)
    }
    check(STRINGS.pluginName, 'pluginName')
    check(STRINGS.pluginDescription, 'pluginDescription')
    check(STRINGS.headerLaunch, 'headerLaunch')
    check(STRINGS.newRunPanelTitle, 'newRunPanelTitle')
    check(STRINGS.runsPanelTitle, 'runsPanelTitle')
    check(STRINGS.bugsReviewPanelTitle, 'bugsReviewPanelTitle')
    check(STRINGS.reportPanelTitle, 'reportPanelTitle')
    check(STRINGS.sessionStartPrompt, 'sessionStartPrompt')
  })
})
