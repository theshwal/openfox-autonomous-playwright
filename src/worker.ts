import { chromium, type Page } from 'playwright'
import { join } from 'node:path'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { WorkerMessageOut, WorkerMessageIn, Finding } from './types.js'

interface WorkerState {
  runId: string
  workerId: string
  mode: 'bugs' | 'faq' | 'docs'
  outputDir: string
  assetsDir: string
  seeds: string[]
  llmEndpoint: string
  llmModel: string
  llmApiKey: string
  headless: boolean
  maxPages: number
  maxDurationMs: number
  cbErrors: number
  cbStallMs: number
  screenshotMode: 'on-error' | 'milestones' | 'off'
  allowedOrigins: string[]
  axeAvailable: boolean
}

const out = (msg: WorkerMessageOut) => {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    // stdout closed
  }
}

let stopRequested = false
let initMessage: (WorkerMessageIn & { type: 'init' }) | null = null
let initResolvers: Array<(m: (WorkerMessageIn & { type: 'init' }) | null) => void> = []

process.on('message', (m: any) => {
  if (!m || typeof m !== 'object') return
  if ((m as any).type === 'stop') {
    stopRequested = true
  }
  if ((m as any).type === 'init' && !initMessage) {
    initMessage = m as WorkerMessageIn & { type: 'init' }
    for (const r of initResolvers) r(initMessage)
    initResolvers = []
  }
})
process.on('SIGTERM', () => {
  stopRequested = true
})

function waitForInit(timeoutMs = 30_000): Promise<(WorkerMessageIn & { type: 'init' }) | null> {
  if (initMessage) return Promise.resolve(initMessage)
  return new Promise((resolveP) => {
    initResolvers.push(resolveP)
    setTimeout(() => {
      if (!initMessage) resolveP(null)
    }, timeoutMs)
  })
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

async function snap(
  page: Page,
  state: WorkerState,
  n: number,
  reason: string,
): Promise<string | undefined> {
  try {
    const file = join(state.assetsDir, `${state.workerId}-${n}${reason ? '-' + reason : ''}.jpg`)
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false })
    if (buf) {
      await writeFile(file, buf)
      return file
    }
  } catch {}
  return undefined
}

async function summarize(page: Page): Promise<string> {
  try {
    const main = await page.$('main, article, body')
    const text = await main?.innerText().catch(() => '')
    return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
  } catch {
    return ''
  }
}

async function checkBrokenLinks(page: Page, workerId: string): Promise<Finding[]> {
  const findings: Finding[] = []
  try {
    const links: string[] = await page.evaluate(() => {
      const out: string[] = []
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (a as HTMLAnchorElement).href
        if (!href) continue
        try {
          const u = new URL(href, location.href)
          if (u.origin === location.origin) out.push(u.href)
        } catch {}
      }
      return out
    })
    const seen = new Set<string>()
    const unique = links.filter((l) => {
      if (seen.has(l)) return false
      seen.add(l)
      return true
    }).slice(0, 12)
    for (const href of unique) {
      try {
        const res = await page.request.fetch(href)
        if (res.status() >= 400) {
          findings.push({
            ts: new Date().toISOString(),
            workerId,
            url: page.url(),
            type: 'bug-broken-link',
            severity: res.status() >= 500 ? 'high' : 'medium',
            title: `Broken link ${res.status()} → ${href}`,
            evidence: `Link ${href} returned ${res.status()}`,
          })
        }
      } catch {}
    }
  } catch {}
  return findings
}

async function checkFormSubmission(page: Page, workerId: string): Promise<Finding[]> {
  const findings: Finding[] = []
  try {
    const forms = await page.$$('form')
    for (const form of forms.slice(0, 3)) {
      const inputs = await form.$$('input[type=email], input[name=email]')
      if (inputs.length === 0) continue
      const action = await form.getAttribute('action').catch(() => null)
      const hasSubmit = (await form.$$('button[type=submit], input[type=submit]')).length > 0
      if (!hasSubmit) {
        findings.push({
          ts: new Date().toISOString(),
          workerId,
          url: page.url(),
          type: 'bug-form',
          severity: 'medium',
          title: `Form without submit (action=${action ?? '<none>'})`,
          evidence: 'No submit button found in form with email input',
        })
      }
    }
  } catch {}
  return findings
}

async function checkVisualOverlap(page: Page, workerId: string): Promise<Finding[]> {
  const findings: Finding[] = []
  try {
    const overlap = await page.evaluate(() => {
      const points = [
        { x: 100, y: 100 },
        { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        { x: window.innerWidth - 100, y: window.innerHeight - 100 },
      ]
      const problems: string[] = []
      for (const p of points) {
        const els = document.elementsFromPoint(p.x, p.y)
        for (let i = 0; i < els.length - 1; i++) {
          const a = els[i]
          const b = els[i + 1]
          if (a && b && a.tagName === 'BUTTON' && b.tagName === 'BUTTON') {
            problems.push(`${p.x},${p.y}: overlapping buttons`)
            break
          }
        }
      }
      return problems
    })
    for (const issue of overlap.slice(0, 3)) {
      findings.push({
        ts: new Date().toISOString(),
        workerId,
        url: page.url(),
        type: 'bug-visual',
        severity: 'low',
        title: 'Visual overlap detected',
        evidence: issue,
      })
    }
  } catch {}
  return findings
}

async function scanA11y(page: Page, workerId: string): Promise<Finding[]> {
  try {
    const present = await page
      .evaluate(() => typeof (window as any).axe?.run === 'function')
      .catch(() => false)
    if (!present) return []
    const violations: any[] = await page
      .evaluate(async () => {
        try {
          const axe = (window as any).axe
          if (typeof axe?.run !== 'function') return []
          const r = await axe.run({ exclude: [['[aria-hidden="true"]']] })
          return r?.violations ?? []
        } catch {
          return []
        }
      })
      .catch(() => [])
    const list: Finding[] = []
    if (Array.isArray(violations)) {
      for (const v of violations.slice(0, 5)) {
        list.push({
          ts: new Date().toISOString(),
          workerId,
          url: page.url(),
          type: 'bug-a11y',
          severity: 'medium',
          title: `[axe-core] ${v.id}: ${v.help ?? ''}`,
          evidence: (v.nodes ?? []).slice(0, 2).map((n: any) => n.html).join('\n'),
        })
      }
    }
    return list
  } catch {
    return []
  }
}

async function visit(
  page: Page,
  url: string,
  state: WorkerState,
  counter: { n: number },
  findingsEmitted: { count: number },
) {
  // F29: register listeners BEFORE goto so initial-load errors aren't dropped
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  let responseStatus = 0
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    if (resp) responseStatus = resp.status()
  } catch (e: any) {
    throw e
  }
  const title = await page.title().catch(() => '')
  if (responseStatus >= 400) {
    const f: Finding = {
      ts: new Date().toISOString(),
      workerId: state.workerId,
      url,
      type: responseStatus >= 500 ? 'bug-5xx' : 'bug-4xx',
      severity: responseStatus >= 500 ? 'high' : 'medium',
      title: `${responseStatus} on ${url}`,
      evidence: `Response status ${responseStatus}`,
    }
    findingsEmitted.count++
    out({ type: 'finding', payload: f })
  }
  if (consoleErrors.length) {
    const f: Finding = {
      ts: new Date().toISOString(),
      workerId: state.workerId,
      url,
      type: 'bug-console',
      severity: 'medium',
      title: `Console errors on ${title || url}`,
      evidence: consoleErrors.slice(0, 3).join('\n'),
    }
    if (state.screenshotMode !== 'off') {
      f.screenshotPath = await snap(page, state, ++counter.n, 'console')
    }
    findingsEmitted.count++
    out({ type: 'finding', payload: f })
  }
  // broken links
  for (const f of await checkBrokenLinks(page, state.workerId)) {
    if (state.screenshotMode !== 'off') f.screenshotPath = await snap(page, state, ++counter.n, 'link')
    findingsEmitted.count++
    out({ type: 'finding', payload: f })
  }
  // forms
  for (const f of await checkFormSubmission(page, state.workerId)) {
      findingsEmitted.count++
      out({ type: 'finding', payload: f })
    }
  // visual overlap
  for (const f of await checkVisualOverlap(page, state.workerId)) {
    if (state.screenshotMode !== 'off') f.screenshotPath = await snap(page, state, ++counter.n, 'overlap')
    findingsEmitted.count++
    out({ type: 'finding', payload: f })
  }
  // a11y (if axe-core was injected at startup)
  if (state.axeAvailable) {
    for (const f of await scanA11y(page, state.workerId)) {
      if (state.screenshotMode !== 'off') f.screenshotPath = await snap(page, state, ++counter.n, 'a11y')
      findingsEmitted.count++
      out({ type: 'finding', payload: f })
    }
  }
  switch (state.mode) {
    case 'bugs':
      break
    case 'faq': {
      const faq: Finding = {
        ts: new Date().toISOString(),
        workerId: state.workerId,
        url,
        type: 'faq-entry',
        title: `How does ${title || new URL(url).pathname} work?`,
        evidence: await summarize(page),
        meta: { theme: 'Getting started' },
      }
      findingsEmitted.count++
      out({ type: 'finding', payload: faq })
      break
    }
    case 'docs': {
      const docs: Finding = {
        ts: new Date().toISOString(),
        workerId: state.workerId,
        url,
        type: 'doc-section',
        title: title || new URL(url).pathname,
        evidence: await summarize(page),
        meta: { heading: title || new URL(url).pathname },
      }
      if (state.screenshotMode === 'milestones') {
        docs.screenshotPath = await snap(page, state, ++counter.n, 'doc')
      }
      findingsEmitted.count++
      out({ type: 'finding', payload: docs })
      break
    }
  }
}

async function main(): Promise<void> {
  const env = process.env
  const seedsFromEnv = safeJson<string[]>(env.AUTOPW_SEEDS ?? '[]', [])
  const state: WorkerState = {
    runId: env.AUTOPW_RUN_ID ?? 'unknown',
    workerId: env.AUTOPW_WORKER_ID ?? 'unknown',
    mode: (env.AUTOPW_MODE as any) ?? 'bugs',
    outputDir: env.AUTOPW_OUTPUT ?? process.cwd(),
    assetsDir: env.AUTOPW_ASSETS ?? process.cwd(),
    seeds: seedsFromEnv,
    llmEndpoint: env.AUTOPW_LLM_ENDPOINT ?? 'http://localhost:8000/v1',
    llmModel: env.AUTOPW_LLM_MODEL ?? 'auto',
    llmApiKey: env.AUTOPW_LLM_API_KEY ?? '',
    headless: env.AUTOPW_HEADLESS !== 'false',
    maxPages: Number(env.AUTOPW_MAX_PAGES ?? 20),
    maxDurationMs: Number(env.AUTOPW_MAX_DURATION_MS ?? 600000),
    cbErrors: Number(env.AUTOPW_CB_ERRORS ?? 5),
    cbStallMs: Number(env.AUTOPW_CB_STALL_MS ?? 60000),
    screenshotMode: (env.AUTOPW_SCREENSHOT_MODE as any) ?? 'on-error',
    allowedOrigins: safeJson<string[]>(env.AUTOPW_ALLOWED_ORIGINS ?? '[]', []),
    axeAvailable: env.AUTOPW_AXE_AVAILABLE === 'true',
  }
  await mkdir(state.assetsDir, { recursive: true }).catch(() => {})
  await mkdir(state.outputDir, { recursive: true }).catch(() => {})

  const init = await waitForInit()
  if (!init) {
    out({ type: 'error', payload: { message: 'init timeout' } })
    out({ type: 'done', payload: { reason: 'breaker', visited: 0, findings: 0 } })
    process.exit(1)
    return
  }
  const configSeeds = (init.config as any).seeds as string[] | undefined
  if (Array.isArray(configSeeds) && configSeeds.length > 0) state.seeds = configSeeds

  // init ack (F23-style; lets the orchestrator know worker is up)
  out({
    type: 'log',
    payload: {
      level: 'info',
      message: `worker ${state.workerId} starting (seeds=${state.seeds.length})`,
    },
  })
  out({
    type: 'ready',
    payload: { workerId: state.workerId, runId: state.runId },
  })

  const startedAt = Date.now()
  const session = await chromium.launch({ headless: state.headless })

  let visited = 0
  let consecutiveErrors = 0
  let lastProgressTs = Date.now()
  let done = false
  // F45: findingsEmitted counter (object reference passed to visit())
  const findingsEmitted = { count: 0 }
  const counter = { n: 0 }

  // 5s heartbeat loop (separate from per-visit heartbeat)
  const heartbeatTimer = setInterval(() => {
    if (done) return
    out({
      type: 'heartbeat',
      payload: {
        ts: new Date().toISOString(),
        visited,
        inFlight: 'idle-or-running',
      },
    })
  }, 5_000)

  try {
    const context = await session.newContext({
      userAgent: 'OpenFoxAutonomousPlaywright/0.1 (+local-agent)',
      viewport: { width: 1280, height: 720 },
    })

    // Conditionally inject axe-core for a11y scanning
    if (state.mode === 'bugs' && state.axeAvailable) {
      const axeSrc = await tryReadAxeSource()
      if (axeSrc) {
        await context.addInitScript({ content: axeSrc })
      }
    }

    for (const url of state.seeds) {
      if (stopRequested || done) break
      if (visited >= state.maxPages) {
        out({ type: 'done', payload: { reason: 'limit', visited, findings: findingsEmitted.count } })
        done = true
        break
      }
      if (Date.now() - startedAt > state.maxDurationMs) {
        out({ type: 'done', payload: { reason: 'limit', visited, findings: findingsEmitted.count } })
        done = true
        break
      }
      visited++
      const page = await context.newPage()
      try {
        await visit(page, url, state, counter, findingsEmitted)
        consecutiveErrors = 0
        lastProgressTs = Date.now()
      } catch {
        consecutiveErrors++
        if (consecutiveErrors >= state.cbErrors) {
          out({
            type: 'done',
            payload: { reason: 'breaker', visited, findings: findingsEmitted.count },
          })
          done = true
          break
        }
      } finally {
        await page.close().catch(() => {})
      }
      out({
        type: 'progress',
        payload: { visited, queueSize: state.seeds.length - visited },
      })
      if (Date.now() - lastProgressTs > state.cbStallMs) {
        out({ type: 'done', payload: { reason: 'breaker', visited, findings: findingsEmitted.count } })
        done = true
        break
      }
    }

    if (!done && !stopRequested && visited < state.maxPages) {
      out({ type: 'done', payload: { reason: 'completed', visited, findings: findingsEmitted.count } })
    }
    if (stopRequested && !done) {
      out({ type: 'done', payload: { reason: 'stopped', visited, findings: findingsEmitted.count } })
    }
    await context.close().catch(() => {})
  } catch (e: any) {
    out({ type: 'error', payload: { message: `fatal ${e?.message ?? String(e)}` } })
    out({ type: 'done', payload: { reason: 'breaker', visited, findings: findingsEmitted.count } })
  } finally {
    clearInterval(heartbeatTimer)
    await session.close().catch(() => {})
    process.exit(0)
  }
}

async function tryReadAxeSource(): Promise<string | null> {
  try {
    const paths = [
      process.env.AUTOPW_AXE_SOURCE ?? '',
      join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'),
    ]
    for (const p of paths) {
      if (!p) continue
      if (!existsSync(p)) continue
      const s = await stat(p)
      if (!s.isFile()) continue
      const { readFile } = await import('node:fs/promises')
      return await readFile(p, 'utf8')
    }
    return null
  } catch {
    return null
  }
}

main().catch((e) => {
  out({ type: 'error', payload: { message: e?.message ?? String(e) } })
  out({ type: 'done', payload: { reason: 'breaker', visited: 0, findings: 0 } })
  process.exit(1)
})
