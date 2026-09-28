# openfox-autonomous-playwright (Français)

> Lance N agents Playwright en parallèle contre une URL cible pour détecter des bugs, générer une FAQ ou documenter automatiquement. Plugin OpenFox.

**Aussi disponible en**: [English](./README.en.md)

[![OpenFox plugin](https://img.shields.io/badge/OpenFox-plugin-2.0-brightgreen)](https://github.com/co-l/openfox)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Présentation

Plugin officiel [OpenFox](https://github.com/co-l/openfox) qui démarre plusieurs navigateurs Playwright Chromium isolés (`child_process.fork`) en mode headless. Chaque agent explore la cible selon une stratégie configurable, capture des findings (bugs, FAQ, documentation) et les agrège dans `BUGS.md` / `FAQ.md` / `DOCS.md` à la racine du projet. Le mode bug pousse optionnellement des *issues* GitHub via `gh` après validation dans un panel.

## Installation

Depuis **Settings → Plugins → Install from GitHub URL** :

```
https://github.com/theshwal/openfox-autonomous-playwright
```

L'install déclenche `postinstall` qui télécharge Chromium (~150 MB, **idempotent**). Si l'environnement refuse l'installation (CI, conteneur), exécutez manuellement :

```sh
npx playwright install chromium
```

## Exemples

### Bug-hunt

```
/playwright-bugs https://example.com
```

→ Ouvre le panel `playwright-runs`, lance 2 workers en parallèle, capture les 4xx/5xx, console errors, formulaires cassés.
→ Génère `BUGS.md` + `runs/<run-id>/raw/*.jsonl`. Avec `ghMode=preview`, ouvre le panel `playwright-bugs-review` pour cocher les issues à créer.

### FAQ

```
/playwright-faq https://docs.example.com
```

→ Agrège les questions implicites détectées, écrit `FAQ.md` à la racine, screenshots intégrés au format `![](./.openfox-autonomous-playwright/assets/<run>/...)`.

### Docs

```
/playwright-docs https://my-app.example.com
```

→ Génère `DOCS.md` structuré (Overview, Table of contents, Features, Troubleshooting).

## Settings

| Clé | Type | Défaut | Section | Description |
|---|---|---|---|---|
| `targetUrl` | text | — | Target | URL de départ |
| `strategy` | select | `autodetect` | Target | `autodetect`, `crawl-bfs`, `seed-list`, `sitemap`, `llm-curated` |
| `seedUrls` | textarea | — | Target | JSON array d'URLs (pour seed-list) |
| `allowedOrigins` | textarea | — | Target | JSON regex (filtre BFS) |
| `concurrency` | number (1-4) | 2 | Execution | Workers parallèles. Capé à 2 si < 8 GB RAM |
| `maxPages` | number | 20 | Execution | Pages max par worker |
| `maxDepth` | number | 3 | Execution | Profondeur BFS max |
| `maxDurationMs` | number | 600000 | Execution | Timeout global |
| `headless` | boolean | true | Execution | Lance Chromium headless |
| `screenshotMode` | select | `on-error` | Output | `on-error` / `milestones` / `off` |
| `outputDir` | path | `.openfox-autonomous-playwright` | Output | Dossier racine de sortie |
| `ghMode` | select | `preview` | Output | Mode d'envoi d'issues GitHub |
| `ghLabel` | text | `autonomous-audit` | Output | Label appliqué aux issues |
| `llmEndpoint` | text | env `OPENFOX_LLM_URL` | LLM | Endpoint OpenAI-compatible |
| `llmModel` | text | env `OPENFOX_MODEL_NAME` | LLM | Modèle |
| `llmApiKey` | password | — | LLM | Clé API (jamais loggée) |
| `circuitBreakerErrors` | number | 5 | Safety | Erreurs consécutives → stop |
| `circuitBreakerStallMs` | number | 60000 | Safety | Stall ms → stop |
| `retentionDays` | number | 30 | Safety | Rétention runs |

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
│  ├─ Playwright Chromium (pool)      │
│  ├─ Strategy adapter               │
│  ├─ LLM loop (Vercel AI ready)      │
│  ├─ Circuit breaker                 │
│  └─ NDJSON over stdout              │
└─────────────────────────────────────┘
       │
       ▼
   <workdir>/.openfox-autonomous-playwright/
     ├─ runs/<run-id>/raw/<worker-id>.jsonl
     ├─ runs/<run-id>/candidates.json
     ├─ runs/<run-id>/BUGS.md (si bugs)
     ├─ assets/<run-id>/*.jpg
     ├─ BUGS.md / FAQ.md / DOCS.md  (racine projet, si reporters activés)
     └─ runs/index (storage plugin)
```

## Troubleshooting

| Symptôme | Solution |
|---|---|
| `Chromium failed to launch` | Lancer `npx playwright install chromium` puis recharger le plugin. |
| `gh issue create` échoue silencieusement | Vérifier `gh auth status` ; `ghMode=preview` ouvre un panel UI pour rejouer la création. |
| Workers en boucle infinie | Baisser `maxPages` / `maxDurationMs`, puis `playwright.runs.stop`. |
| `ENOSPC: no space left` | Réduire `screenshotMode` à `off` ou nettoyer via RPC `playwright.runs.cleanup`. |
| LLM unreachable | Vérifier `OPENFOX_LLM_URL` / `llmEndpoint` ; `playwright_discover` retourne le verdict. |
| Pas d'issue créée en `ghMode=auto` | `gh auth status` non-zero, ou > 20 candidats, ou repo Git absent → fallback BUGS.md. |

## Limitations connues

- **Stealth anti-bot : non** — robots.txt respecté best-effort, mais pas de contournement de CAPTCHA / fingerprinting.
- **Modèle minimum recommandé : 7B params** (Qwen2.5-7B, Mistral-7B, etc.) pour des décisions de bug-hunting fiables.
- **LLM loop intégrée : openAI-compatible HTTP** — pas de MCP LLM runtime (chaque worker fait son appel HTTP).
- **Axe-core :** non inclus dans le bundle (évite ~50 MB). Voir la roadmap pour un mode d'injection à la demande.

## Développement

```sh
npm install        # télécharge Playwright + Chromium
npm run typecheck  # tsc --noEmit
npm test           # vitest run (19 tests : 12 unit + 5 strategies + 2 e2e Chromium)
npm run build      # tsup → dist/
```

## Licence

MIT. © theshwal & contributors.
