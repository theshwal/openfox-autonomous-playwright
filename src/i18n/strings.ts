export type LocalizedString = { en: string; fr: string }

export const t = (en: string, fr: string): LocalizedString => ({ en, fr })

export const STRINGS = {
  pluginName: t('Autonomous Playwright', 'Playwright Autonome'),
  pluginDescription: t(
    'Launch parallel Playwright agents for bug-hunting, FAQ and documentation.',
    'Lance des agents Playwright en parallèle pour détecter des bugs, générer une FAQ et documenter.',
  ),
  headerLaunch: t('Launch Playwright audit', 'Lancer audit Playwright'),
  sessionStartPrompt: t(
    'Run a Playwright audit against this project?',
    'Lancer un audit Playwright sur ce projet ?',
  ),
  newRunPanelTitle: t('New Playwright run', 'Nouvelle exécution Playwright'),
  runsPanelTitle: t('Playwright runs', 'Exécutions Playwright'),
  bugsReviewPanelTitle: t('Bug review', 'Revue de bugs'),
  reportPanelTitle: t('Playwright report', 'Rapport Playwright'),
  badgeIdle: t('Idle', 'Inactif'),
  notifyRunStarted: (mode: string) =>
    t(`Run started (mode=${mode})`, `Exécution démarrée (mode=${mode})`),
  notifyRunDone: (count: number) =>
    t(`Run completed — ${count} findings`, `Exécution terminée — ${count} résultats`),
  notifyRunFailed: t('Run failed', 'Exécution échouée'),
}

export function isLocalized(value: unknown): value is LocalizedString {
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value).sort()
  return (
    keys.length === 2 && keys[0] === 'en' && keys[1] === 'fr' && typeof (value as any).en === 'string'
  )
}
