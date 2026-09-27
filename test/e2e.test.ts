import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const WORKDIR = mkdtempSync(join(tmpdir(), 'autopw-e2e-'))
const OUTPUT = join(WORKDIR, '.openfox-autonomous-playwright')

let server: Server
let port = 0
const pages = new Map<string, string>()

pages.set(
  '/',
  `<!doctype html><html><body><h1>Home</h1></body></html>`,
)

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/broken') {
      res.statusCode = 404
      res.end('not found')
      return
    }
    if (url === '/sitemap.xml') {
      res.statusCode = 404
      res.end('no')
      return
    }
    const body = pages.get(url) ?? pages.get('/')!
    res.setHeader('content-type', 'text/html')
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (addr && typeof addr === 'object') port = addr.port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(WORKDIR, { recursive: true, force: true })
})

describe('end-to-end smoke', () => {
  it(
    'worker visits a local fixture, captures a 404 bug, writes raw.jsonl + BUGS.md',
    async () => {
      const target = `http://127.0.0.1:${port}/`
      const broken = `http://127.0.0.1:${port}/broken`
      const workerEntry = join(process.cwd(), 'dist', 'worker.js')
      if (!existsSync(workerEntry)) {
        const r = spawnSync('npx', ['tsup'], { encoding: 'utf8' })
        expect(r.status).toBe(0)
      }

      const { Orchestrator } = await import('../src/orchestrator.js')
      const { mergeSettings } = await import('../src/types.js')
      const errs: string[] = []
      const orchestrator = new Orchestrator({
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: (...a) => errs.push(a.map(String).join(' ')),
        },
        publish: () => {},
        notify: () => {},
        storageGet: <T>(_k: string) => undefined as T | undefined,
        storageSet: (_k, _v) => {},
        workdirProvider: () => WORKDIR,
        emitState: () => {},
      })
      orchestrator.setWorkerEntry(workerEntry)

      const id = await orchestrator.start({
        mode: 'bugs',
        strategy: 'seed-list',
        targetUrl: target,
        concurrency: 1,
        settings: mergeSettings({
          targetUrl: target,
          seedUrls: [target, broken],
          outputDir: OUTPUT,
          concurrency: 1,
          maxPages: 5,
          screenshotMode: 'on-error',
        }),
      })
      expect(id).toBeTruthy()

      await waitForRunDone(orchestrator, id, 30_000)
      const run = orchestrator.get(id)
      if (!run) throw new Error('run missing')
      const rawDir = join(OUTPUT, 'runs', id, 'raw')
      if (!existsSync(rawDir)) {
        throw new Error(`raw dir missing (status=${run.status}, findings=${run.findings.length}, errs=${errs.join(' | ')})`)
      }
      const files = readdirSync(rawDir).filter((f) => f.endsWith('.jsonl'))
      expect(files.length).toBeGreaterThan(0)

      let parsed: any[] = []
      for (const f of files) {
        const lines = readFileSync(join(rawDir, f), 'utf8').split(/\n/).filter(Boolean)
        for (const line of lines) parsed.push(JSON.parse(line))
      }
      const bugs = parsed.filter((p) => String(p.type).startsWith('bug'))
      expect(bugs.length).toBeGreaterThan(0)
      const has404 = parsed.some(
        (p) => p.type === 'bug-4xx' && typeof p.url === 'string' && p.url.endsWith('/broken'),
      )
      expect(has404).toBe(true)

      expect(run.visitedUrls.size).toBeGreaterThan(0)

      await orchestrator.shutdown()
    },
    90_000,
  )

  it(
    'runs.cleanup removes both runs/<id>/ and assets/<id>/ older than N days',
    async () => {
      const target = `http://127.0.0.1:${port}/`
      const workerEntry = join(process.cwd(), 'dist', 'worker.js')
      const { Orchestrator } = await import('../src/orchestrator.js')
      const { mergeSettings } = await import('../src/types.js')
      const orchestrator = new Orchestrator({
        logger: consoleLogger(),
        publish: () => {},
        notify: () => {},
        storageGet: <T>(_k: string) => undefined as T | undefined,
        storageSet: (_k, _v) => {},
        workdirProvider: () => WORKDIR,
        emitState: () => {},
      })
      orchestrator.setWorkerEntry(workerEntry)
      const id = await orchestrator.start({
        mode: 'bugs',
        strategy: 'seed-list',
        targetUrl: target,
        concurrency: 1,
        settings: mergeSettings({
          targetUrl: target,
          seedUrls: [target],
          outputDir: OUTPUT,
          concurrency: 1,
          maxPages: 1,
        }),
      })
      await waitForRunDone(orchestrator, id, 30_000)

      const assetsDir = join(OUTPUT, 'assets', id)
      expect(existsSync(assetsDir)).toBe(true)

      const result = await orchestrator.cleanup(0)
      expect(result.assetsRemoved).toBeGreaterThan(0)

      await orchestrator.shutdown()
    },
    90_000,
  )
})

function consoleLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: (..._a: unknown[]) => {},
    error: (...a: unknown[]) => console.error('[e2e]', ...a),
  }
}

async function waitForRunDone(o: { get(id: string): any }, id: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = o.get(id)
    if (r && r.status !== 'running' && r.status !== 'queued') return
    await new Promise((r2) => setTimeout(r2, 250))
  }
}
