import type { Finding, GhMode, FindingType } from '../types.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface ReporterContext {
  runId: string
  outDir: string
  projectRoot: string
  ghMode: GhMode
  ghLabel: string
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

export type Reporter = (
  findings: Finding[],
  ctx: ReporterContext,
) => Promise<void> | void

export interface NamedReporter {
  name: string
  fn: Reporter
}

export function resolveRunReporters(mode: string): NamedReporter[] {
  if (mode === 'bugs') return [bugReporter]
  if (mode === 'faq') return [faqReporter]
  if (mode === 'docs') return [docsReporter]
  return []
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

const bugReporter: NamedReporter = {
  name: 'bug',
  fn: async (findings, ctx) => {
    const bugs = findings.filter((f) => f.type.startsWith('bug')) as Finding[]
    if (bugs.length === 0) return
    const candidates = dedupe(bugs)
    await writeFile(join(ctx.outDir, 'candidates.json'), JSON.stringify(candidates, null, 2))
    const auditId = ctx.runId
    const projectBugsMd = join(ctx.projectRoot, 'BUGS.md')
    if (ctx.ghMode === 'preview') {
      const md =
        renderBugsMd(candidates, auditId) +
        '\n\n<!-- ghMode=preview: open the autonomous-playwright panel to apply candidates -->\n'
      await writeFile(projectBugsMd, md, { flag: 'w' })
      await writeFile(join(ctx.outDir, 'BUGS.md'), md, { flag: 'w' })
      return
    }
    if (ctx.ghMode === 'off') {
      const md = renderBugsMd(candidates, auditId)
      await writeFile(projectBugsMd, md, { flag: 'w' })
      await writeFile(join(ctx.outDir, 'BUGS.md'), md, { flag: 'w' })
      return
    }
    if (ctx.ghMode === 'auto') {
      if (candidates.length > 20) {
        ctx.logger.warn(
          `[bug-reporter] ${candidates.length} candidates > 20, falling back to BUGS.md`,
        )
        await writeFile(projectBugsMd, renderBugsMd(candidates, auditId), { flag: 'w' })
        await writeFile(join(ctx.outDir, 'BUGS.md'), renderBugsMd(candidates, auditId), { flag: 'w' })
        return
      }
      const ghStatus = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
      if (ghStatus.status !== 0) {
        ctx.logger.warn('[bug-reporter] gh not authenticated, falling back to BUGS.md')
        await writeFile(projectBugsMd, renderBugsMd(candidates, auditId), { flag: 'w' })
        return
      }
      const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
        cwd: ctx.projectRoot,
        encoding: 'utf8',
      })
      const repo = ghRepoFromRemote(remote.stdout?.trim() ?? '')
      if (!repo) {
        ctx.logger.warn('[bug-reporter] cannot determine gh repo, falling back to BUGS.md')
        await writeFile(projectBugsMd, renderBugsMd(candidates, auditId), { flag: 'w' })
        return
      }
      const created: string[] = []
      for (const c of candidates) {
        const body = renderIssueBody(c, auditId)
        const r = spawnSync(
          'gh',
          [
            'issue',
            'create',
            '--repo',
            repo,
            '--label',
            ctx.ghLabel,
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
        } else {
          ctx.logger.warn(`[bug-reporter] gh issue create failed: ${r.stderr}`)
        }
      }
      const createdMd =
        renderBugsMd(candidates, auditId) +
        '\n\n## Created GitHub issues\n\n' +
        created.map((l) => `- ${l}`).join('\n') +
        '\n'
      await writeFile(projectBugsMd, createdMd, { flag: 'w' })
      await writeFile(join(ctx.outDir, 'BUGS.md'), createdMd, { flag: 'w' })
    }
  },
}

function dedupe(bugs: Finding[]): Array<Finding & { _key: string }> {
  const seen: Array<Finding & { _key: string }> = []
  for (const b of bugs) {
    const key = `${b.url}::${normalizeTitle(b.title)}`
    const exists = seen.find(
      (s) => levenshtein(`${s.url}::${normalizeTitle(s.title)}`, key) <= 10,
    )
    if (!exists) seen.push({ ...b, _key: key })
  }
  return seen
}

function renderBugsMd(list: Array<Finding & { _key?: string }>, auditId: string): string {
  let md = `# Bug audit\n\n_Count: ${list.length}_\n\n<!-- audit-id:${auditId} -->\n\n`
  for (const b of list) {
    md += `## [${b.severity ?? 'medium'}] ${b.title}\n\n`
    md += `- URL: ${b.url}\n`
    md += `- Type: ${b.type}\n`
    if (b.evidence) md += `- Evidence:\n\n\`\`\`\n${b.evidence}\n\`\`\`\n`
    if (b.screenshotPath) md += `- ![screenshot](${b.screenshotPath.replace(/\\/g, '/')})\n`
    md += '\n'
  }
  return md
}

function renderIssueBody(b: Finding, auditId: string): string {
  return [
    `Reported by \`openfox-autonomous-playwright\` (audit \`${auditId}\`).`,
    `<!-- audit-id:${auditId} -->`,
    '',
    `- Type: ${b.type}`,
    `- Severity: ${b.severity ?? 'medium'}`,
    `- URL: ${b.url}`,
    b.evidence ? `\n**Evidence**\n\n\`\`\`\n${b.evidence}\n\`\`\`` : '',
    b.screenshotPath
      ? `\n**Screenshot**\n\n![screenshot](${b.screenshotPath.replace(/\\/g, '/')})`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function ghRepoFromRemote(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

const faqReporter: NamedReporter = {
  name: 'faq',
  fn: async (findings, ctx) => {
    const entries = findings.filter((f) => f.type === ('faq-entry' as FindingType))
    if (entries.length === 0) {
      await writeFile(
        join(ctx.outDir, 'FAQ.md'),
        '# FAQ\n\n_No FAQ entries captured for this run. Try increasing maxPages or switching to `seed-list`._\n',
      )
      return
    }
    const grouped = new Map<string, Finding[]>()
    for (const f of entries) {
      const theme = (f.meta as any)?.theme ?? 'General'
      if (!grouped.has(theme)) grouped.set(theme, [])
      grouped.get(theme)!.push(f)
    }
    let md = '# FAQ\n\n'
    for (const [theme, list] of grouped) {
      md += `## ${theme}\n\n`
      for (const f of list)
        md += `- ${f.title}\n${f.evidence ?? ''}\n${f.screenshotPath ? `  ![](${f.screenshotPath.replace(/\\/g, '/')})\n` : ''}\n`
      md += '\n'
    }
    await writeFile(join(ctx.projectRoot, 'FAQ.md'), md, { flag: 'w' })
  },
}

const docsReporter: NamedReporter = {
  name: 'docs',
  fn: async (findings, ctx) => {
    const sections = findings.filter((f) => f.type === ('doc-section' as FindingType))
    const toc = sections
      .map(
        (s, i) =>
          `${i + 1}. [${(s.meta as any)?.heading ?? s.title}](#${slug((s.meta as any)?.heading ?? s.title)})`,
      )
      .join('\n')
    let md = `# Documentation\n\n## Table of contents\n\n${toc}\n\n## Overview\n\n_Document auto-generated by openfox-autonomous-playwright on ${new Date().toISOString().slice(0, 10)}._\n\n`
    for (const s of sections) {
      const heading = (s.meta as any)?.heading ?? s.title
      md += `## ${heading}\n\n${s.evidence ?? ''}\n\n`
      if (s.screenshotPath) md += `![screenshot](${s.screenshotPath.replace(/\\/g, '/')})\n\n`
    }
    md += `## Troubleshooting\n\n_Auto-populated section. Add manual troubleshooting entries._\n`
    await writeFile(join(ctx.projectRoot, 'DOCS.md'), md, { flag: 'w' })
  },
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export const _internal = {
  normalizeTitle,
  levenshtein,
  dedupe,
  renderBugsMd,
  ghRepoFromRemote,
  renderIssueBody,
}
