import type { Strategy } from '../types.js'

export interface StrategyInput {
  strategy: Strategy
  target: string
  seedUrls: string[]
  allowedOrigins: string[]
  maxPages: number
  workdir: string
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
}

export interface StrategyResult {
  seeds: string[]
  robotsTxt?: { allowed: boolean; crawlDelayMs?: number }
  bfsOrigin?: string
}

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
}

export async function executeStrategy(input: StrategyInput): Promise<StrategyResult> {
  const picked: Strategy =
    input.strategy === 'autodetect' ? await autodetect(input) : input.strategy
  const log = (n: string) => input.logger.info(`[strategy:${picked}] ${n}`)
  switch (picked) {
    case 'crawl-bfs': {
      log(`bfs seed=${input.target} maxDepth=${input.maxPages ?? 20}`)
      const urls = await runBfsCrawl(input.target, input.allowedOrigins, input.maxPages ?? 20, log)
      return { seeds: urls, bfsOrigin: input.target }
    }
    case 'seed-list': {
      const seeds = (input.seedUrls ?? []).filter((u) => typeof u === 'string' && u.length > 0)
      log(`seed-list with ${seeds.length} entries`)
      return { seeds: seeds.length ? seeds : [input.target] }
    }
    case 'sitemap': {
      const urls = await trySitemap(input.target, log)
      if (urls.length) {
        const capped = urls.slice(0, input.maxPages ?? 20)
        return { seeds: capped }
      }
      log('sitemap empty, falling back to single target')
      return { seeds: [input.target] }
    }
    case 'llm-curated': {
      log(`llm-curated seed=${input.target}`)
      const urls = await runLlmCurated(input.target, input.allowedOrigins, log)
      return { seeds: urls.length ? urls : [input.target] }
    }
    case 'autodetect': {
      return { seeds: [input.target] }
    }
  }
}

async function autodetect(input: StrategyInput): Promise<Strategy> {
  try {
    const probe = await fetch(new URL('/sitemap.xml', input.target).toString(), {
      method: 'HEAD',
    }).catch(() => null)
    if (probe && probe.ok) return 'sitemap'
  } catch {}
  try {
    const probe = await fetch(new URL('/robots.txt', input.target).toString(), {
      method: 'HEAD',
    }).catch(() => null)
    if (probe && probe.ok) return 'crawl-bfs'
  } catch {}
  return 'crawl-bfs'
}

async function trySitemap(target: string, log: (s: string) => void): Promise<string[]> {
  try {
    const url = new URL('/sitemap.xml', target).toString()
    const res = await fetch(url)
    if (!res.ok) {
      log(`sitemap HTTP ${res.status} — falling through`)
      const robots = await tryRobotsTxt(target)
      if (robots.urls.length) return robots.urls
      return []
    }
    const xml = await res.text()
    let matches: RegExpExecArray[] = []
    try {
      matches = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g))
    } catch {}
    const urls = matches.map((m) => m[1]).filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
    if (urls.length) return urls
    const robots = await tryRobotsTxt(target)
    return robots.urls
  } catch (e: any) {
    log(`sitemap probe failed: ${e?.message ?? String(e)}`)
    return []
  }
}

export async function tryRobotsTxt(target: string): Promise<{ urls: string[]; allowed: boolean; crawlDelayMs?: number }> {
  try {
    const url = new URL('/robots.txt', target).toString()
    const res = await fetch(url, { headers: BROWSER_HEADERS })
    if (!res.ok) return { urls: [], allowed: true }
    const text = await res.text()
    const allowed = !/^User-agent:\s*\*\s*[\r\n]+Disallow:\s*\/\s*$/im.test(text)
    const delayMatch = text.match(/Crawl-delay:\s*(\d+)/i)
    const crawlDelayMs = delayMatch ? Number(delayMatch[1]) * 1000 : undefined
    const lines = text.split(/\r?\n/)
    const sitemaps: string[] = []
    for (const ln of lines) {
      const m = ln.match(/^Sitemap:\s*(.+)$/i)
      if (m) sitemaps.push(m[1].trim())
    }
    const allUrls: string[] = []
    for (const sm of sitemaps) {
      try {
        const r = await fetch(sm)
        if (r.ok) {
          const xml = await r.text()
          for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) allUrls.push(m[1])
        }
      } catch {}
    }
    return { urls: allUrls, allowed, crawlDelayMs }
  } catch {
    return { urls: [], allowed: true }
  }
}

async function runBfsCrawl(
  start: string,
  allowedOrigins: string[],
  maxPages: number,
  log: (s: string) => void,
): Promise<string[]> {
  const origin = new URL(start).origin
  const allowed = (allowedOrigins ?? []).map((p) => new RegExp(p))
  const isAllowed = (u: string) => {
    if (allowed.length === 0) return true
    return allowed.some((r) => r.test(u))
  }
  const visited = new Set<string>([start])
  const queue: string[] = [start]
  const out: string[] = [start]
  let depth = 0
  while (queue.length > 0 && out.length < maxPages) {
    const nextQueue: string[] = []
    for (const url of queue) {
      if (out.length >= maxPages) break
      try {
        const res = await fetch(url, { headers: BROWSER_HEADERS })
        if (!res.ok) continue
        const html = await res.text()
        for (const m of html.matchAll(/href=(?:"([^"]+)"|'([^']+)')/g)) {
          const href = m[1] || m[2]
          if (!href) continue
          let abs: URL
          try {
            abs = new URL(href, url)
          } catch {
            continue
          }
          const norm = abs.origin + abs.pathname
          if (abs.origin !== origin) continue
          if (!isAllowed(norm)) continue
          if (visited.has(norm)) continue
          visited.add(norm)
          out.push(norm)
          nextQueue.push(norm)
          if (out.length >= maxPages) break
        }
      } catch (e: any) {
        log(`bfs fetch ${url} failed: ${e?.message ?? String(e)}`)
      }
    }
    queue.length = 0
    queue.push(...nextQueue)
    depth++
    if (depth > 5) break
  }
  return out
}

async function runLlmCurated(
  start: string,
  allowedOrigins: string[],
  log: (s: string) => void,
): Promise<string[]> {
  log('llm-curated: gathering accessibility tree (lightweight via raw HTML + link extraction)')
  const collected = new Set<string>([start])
  try {
    const res = await fetch(start, { headers: BROWSER_HEADERS })
    if (!res.ok) return [start]
    const html = await res.text()
    const linkMatches = Array.from(html.matchAll(/<a[^>]+href=(?:"([^"]+)"|'([^']+)')/g)).slice(0, 30)
    const origin = new URL(start).origin
    const allowed = (allowedOrigins ?? []).map((p) => new RegExp(p))
    const isAllowed = (u: string) => allowed.length === 0 || allowed.some((r) => r.test(u))
    for (const m of linkMatches) {
      const href = m[1] || m[2]
      if (!href) continue
      try {
        const abs = new URL(href, start)
        if (abs.origin !== origin) continue
        const norm = abs.origin + abs.pathname
        if (!isAllowed(norm)) continue
        collected.add(norm)
      } catch {}
    }
  } catch (e: any) {
    log(`llm-curated fetch failed: ${e?.message ?? String(e)}`)
  }
  return Array.from(collected)
}
