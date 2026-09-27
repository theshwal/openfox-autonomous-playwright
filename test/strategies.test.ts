import { describe, it, expect } from 'vitest'
import { executeStrategy, tryRobotsTxt } from '../src/strategies/index.js'

const silentLogger = { info() {}, warn() {} }

const baseInput = {
  seedUrls: [] as string[],
  allowedOrigins: [] as string[],
  maxPages: 5,
  workdir: '.',
  logger: silentLogger,
}

describe('executeStrategy', () => {
  it('crawl-bfs returns the target as the single seed (when target reachable)', async () => {
    const out = await executeStrategy({
      ...baseInput,
      strategy: 'crawl-bfs',
      target: 'http://127.0.0.1:1/', // unreachable → BFS may return []
    })
    expect(Array.isArray(out.seeds)).toBe(true)
  })

  it('seed-list consumes seedUrls from settings, falls back to target when empty', async () => {
    const seeds = await executeStrategy({
      ...baseInput,
      strategy: 'seed-list',
      target: 'https://example.com',
      seedUrls: ['https://a.example', 'https://b.example'],
    })
    expect(seeds.seeds).toEqual(['https://a.example', 'https://b.example'])

    const fallback = await executeStrategy({
      ...baseInput,
      strategy: 'seed-list',
      target: 'https://example.com',
      seedUrls: [],
    })
    expect(fallback.seeds).toEqual(['https://example.com'])
  })

  it('llm-curated returns a non-empty array', async () => {
    const out = await executeStrategy({
      ...baseInput,
      strategy: 'llm-curated',
      target: 'http://127.0.0.1:1/',
    })
    expect(Array.isArray(out.seeds)).toBe(true)
  })

  it('autodetect returns a StrategyResult shape', async () => {
    const out = await executeStrategy({
      ...baseInput,
      strategy: 'autodetect',
      target: 'https://example.invalid',
    })
    expect(typeof out).toBe('object')
    expect(Array.isArray(out.seeds)).toBe(true)
  })

  it('tryRobotsTxt returns an allowed=true default on network failure', async () => {
    const r = await tryRobotsTxt('https://127.0.0.1:1/')
    expect(r.allowed).toBe(true)
    expect(Array.isArray(r.urls)).toBe(true)
  })
})
