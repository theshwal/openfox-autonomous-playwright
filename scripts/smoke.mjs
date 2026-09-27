import { register } from '../dist/index.js'

const calls = { tool: [], command: [], skill: [], settings: null, rpc: new Map(), uiAction: [], uiBadge: [], uiPanel: [], hook: [], asset: [], notify: null }
const ctx = {
  id: 'autopw',
  version: '0.1.0',
  runtime: { mode: 'production', configDirectory: '/tmp/openfox' },
  logger: { debug: () => {}, info: () => {}, warn: (...a) => console.warn('W', ...a), error: (...a) => console.error('E', ...a) },
  storage: { get: () => undefined, set: () => {} },
  settings: () => ({ targetUrl: 'https://example.com', concurrency: 2, strategy: 'autodetect', ghMode: 'preview', maxPages: 5 }),
  notify: (req) => { calls.notify = req },
  publish: () => {},
}

const reg = {
  context: ctx,
  registerTool: (t) => calls.tool.push(t.name),
  registerCommand: (c) => calls.command.push(c.id),
  registerSkillSource: (s) => calls.skill.push(s),
  registerSettings: (s) => { calls.settings = s },
  registerRpc: (m, h) => calls.rpc.set(m, h),
  registerUiAction: (a) => calls.uiAction.push(a.id),
  registerUiBadge: (b) => calls.uiBadge.push(b.id),
  registerUiPanel: (p) => calls.uiPanel.push(p.id),
  registerHook: (e, h) => calls.hook.push(e),
  registerAsset: (p) => calls.asset.push(p),
}

const deactivate = register(reg)
console.log('tools:', calls.tool.join(','))
console.log('commands:', calls.command.join(','))
console.log('panels:', calls.uiPanel.join(','))
console.log('actions:', calls.uiAction.join(','))
console.log('badges:', calls.uiBadge.join(','))
console.log('skills:', calls.skill.map(s => s.id).join(','))
console.log('rpc:', [...calls.rpc.keys()].join(','))
console.log('hooks:', calls.hook.join(','))
console.log('assets:', calls.asset.join(','))
console.log('settings.fields:', calls.settings.fields.length)
await deactivate()
