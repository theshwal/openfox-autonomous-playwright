#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const browserDir = 'node_modules/playwright-core/.local-browsers'
if (existsSync(browserDir) && existsSync(`${browserDir}/chromium`)) {
  console.log('[openfox-autonomous-playwright] Chromium already installed, skipping.')
  process.exit(0)
}

console.log('[openfox-autonomous-playwright] Attempting Chromium install (no sudo required).')

const candidates = [
  ['npx', ['--yes', 'playwright', 'install', 'chromium']],
  ['npx', ['--yes', 'playwright-core', 'install', 'chromium']],
]

for (const [cmd, args] of candidates) {
  const r = spawnSync(cmd, args, {
    stdio: 'pipe',
    env: { ...process.env },
  })
  const combined = ((r.stdout || '') + (r.stderr || '')).toString()
  if (r.status === 0) {
    console.log('[openfox-autonomous-playwright] Chromium installed OK.')
    process.exit(0)
  }
  console.warn(`[openfox-autonomous-playwright] ${cmd} ${args.join(' ')} failed: ${combined.split('\n').slice(-3).join(' / ')}`)
}

console.warn('[openfox-autonomous-playwright] Could not auto-install Chromium.')
console.warn('[openfox-autonomous-playwright] Run manually: npx playwright install chromium')
console.warn('[openfox-autonomous-playwright] Continuing anyway — plugin will surface an error when launching a worker.')
process.exit(0)
