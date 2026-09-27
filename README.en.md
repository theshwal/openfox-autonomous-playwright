# openfox-autonomous-playwright (English)

> Launch N parallel Playwright agents against a target URL for bug-hunting, FAQ generation, and documentation. OpenFox plugin.

**Also available in**: [Français](./README.md)

## Overview

Official [OpenFox](https://github.com/co-l/openfox) plugin that starts multiple isolated Chromium browsers via `child_process.fork` in headless mode. Each agent explores the target with a configurable strategy and reports findings that are aggregated in `BUGS.md` / `FAQ.md` / `DOCS.md` at the project root. The bug mode optionally pushes GitHub *issues* via `gh` after validation in a panel.

## Install

From **Settings → Plugins → Install from GitHub URL**:

```
https://github.com/theshwal/openfox-autonomous-playwright
```

Install triggers `postinstall` to download Chromium (~150 MB, **idempotent**). If your environment refuses it (CI, containers), run manually:

```sh
npx playwright install chromium
```

## Examples

### Bug-hunt

```
/playwright-bugs https://example.com
```

→ Opens the `playwright-runs` panel, launches 2 parallel workers, captures 4xx/5xx, console errors, broken forms.
→ Generates `BUGS.md` + `runs/<run-id>/raw/*.jsonl`. With `ghMode=preview`, opens the `playwright-bugs-review` panel to tick which issues to create.

### FAQ

```
/playwright-faq https://docs.example.com
```

→ Aggregates implicit user questions, writes `FAQ.md` at the project root, embeds screenshots as `![](./.openfox-autonomous-playwright/assets/<run>/...)`.

### Docs

```
/playwright-docs https://my-app.example.com
```

→ Generates `DOCS.md` with sections (Overview, Table of contents, Features, Troubleshooting).

## Settings

| Key | Type | Default | Section | Description |
|---|---|---|---|---|
| `targetUrl` | text | — | Target | Starting URL |
| `strategy` | select | `autodetect` | Target | `autodetect`, `crawl-bfs`, `seed-list`, `sitemap`, `llm-curated` |
| `seedUrls` | textarea | — | Target | JSON array of URLs (for seed-list) |
| `allowedOrigins` | textarea | — | Target | JSON regex (BFS filter) |
| `concurrency` | number (1-4) | 2 | Execution | Parallel workers. Capped at 2 if < 8 GB RAM |
| `maxPages` | number | 20 | Execution | Pages max per worker |
| `maxDepth` | number | 3 | Execution | BFS max depth |
| `maxDurationMs` | number | 600000 | Execution | Global timeout |
| `headless` | boolean | true | Execution | Run Chromium headless |
| `screenshotMode` | select | `on-error` | Output | `on-error` / `milestones` / `off` |
| `outputDir` | path | `.openfox-autonomous-playwright` | Output | Output root folder |
| `ghMode` | select | `preview` | Output | How to push issues to GitHub |
| `ghLabel` | text | `autonomous-audit` | Output | Label applied to created issues |
| `llmEndpoint` | text | env `OPENFOX_LLM_URL` | LLM | OpenAI-compatible endpoint |
| `llmModel` | text | env `OPENFOX_MODEL_NAME` | LLM | Model |
| `llmApiKey` | password | — | LLM | API key (never logged) |
| `circuitBreakerErrors` | number | 5 | Safety | Consecutive errors → stop |
| `circuitBreakerStallMs` | number | 60000 | Safety | Stall ms → stop |
| `retentionDays` | number | 30 | Safety | Run retention |

## Architecture

```
┌────────── OpenFox process ──────────┐
│  Plugin entry (src/index.ts)        │
│   ├─ UI contributions               │
│   ├─ RPC methods (11)               │
│   ├─ Tools (2)                      │
│   ├─ Slash commands (5)             │
│   ├─ Settings (19 fields)           │
│   ├─ Hooks (session.created, …)    │
│   └─ Orchestrator (singleton)       │
└──────┬─────────────────────────────┘
       │ child_process.fork × N
       ▼
┌──────── Worker × N ─────────────────┐
│  src/worker.ts                      │
│  ├─ Playwright Chromium             │
│  ├─ Strategy adapter                │
│  ├─ LLM loop (Vercel AI ready)      │
│  ├─ Circuit breaker                 │
│  └─ NDJSON over stdout              │
└─────────────────────────────────────┘
       │
       ▼
   <workdir>/.openfox-autonomous-playwright/
     ├─ runs/<run-id>/raw/<worker-id>.jsonl
     ├─ runs/<run-id>/candidates.json
     ├─ runs/<run-id>/BUGS.md (if bugs)
     ├─ assets/<run-id>/*.jpg
     ├─ BUGS.md / FAQ.md / DOCS.md  (project root, if reporters enabled)
     └─ runs/index (plugin storage)
```

The orchestrator uses **stdio NDJSON + IPC channel** for transport (no HTTP port, no auth token). Each worker emits `{type:'finding'|'progress'|'heartbeat'|'done'|'error'|'log', payload}` lines; the orchestrator passes them to `ctx.publish` (panel snapshot) and `ctx.logger` (diagnostics).

## Troubleshooting

| Symptom | Solution |
|---|---|
| `Chromium failed to launch` | Run `npx playwright install chromium`, then reload the plugin. |
| `gh issue create` fails silently | Check `gh auth status`; `ghMode=preview` opens a UI panel to re-apply creation. |
| Workers loop forever | Lower `maxPages` / `maxDurationMs`, then `playwright.runs.stop`. |
| `ENOSPC: no space left` | Drop `screenshotMode` to `off` or clean with RPC `playwright.runs.cleanup`. |
| LLM unreachable | Check `OPENFOX_LLM_URL` / `llmEndpoint`; `playwright_discover` returns the verdict. |
| No issue created under `ghMode=auto` | `gh auth status` non-zero, or > 20 candidates, or missing GitHub repo → fallback BUGS.md. |

## Limitations

- **No stealth anti-bot** — robots.txt is respected best-effort, but no CAPTCHA / fingerprint bypass.
- **Recommended minimum LLM: 7B params** (Qwen2.5-7B, Mistral-7B, etc.) for reliable bug-hunting decisions.
- **LLM loop: OpenAI-compatible HTTP** — no MCP LLM runtime (each worker makes its own HTTP call).
- **Axe-core:** not bundled (avoids +50 MB). Roadmap for an on-demand injection mode.

## Development

```sh
npm install        # downloads Playwright + Chromium
npm run typecheck  # tsc --noEmit
npm test           # vitest run (19 tests : 12 unit + 5 strategies + 2 e2e Chromium)
npm run build      # tsup → dist/
```

## License

MIT. © theshwal & contributors.
