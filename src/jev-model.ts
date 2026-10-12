// Jev's providers, and a topic's own Jev settings: the `jev` block in its file. Shared by the hooks
// (src/config.ts, src/scrub.ts) and the panel (hooks/panel.tsx), so it imports nothing.
//
//   "jev": { "model": "jev-1.14.0", "flag": 0.35, "mostly": 0.6 }
//   "jev": { "model": { "typesafe": "jev-1.14.0", "openrouter": "typesafe/jev-1.14" } }
//
// Each field is optional. A model ID is sent as written, never converted: a TypeSafe ID starts with
// `jev-`, an OpenRouter ID with `typesafe/`. A single ID for the other provider, or an object without
// one for the provider in use, is an error that turns the topic off; md-scrub doesn't guess.

export type ProviderId = 'typesafe' | 'openrouter'

// The two ways to reach Jev, each with its own endpoint and pinned model (md-scrub's thresholds were
// tuned for these; see claude/notes/typesafe-direct-api.md).
export const PROVIDERS = {
  typesafe: { id: 'typesafe', name: 'TypeSafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0' },
  openrouter: { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
} as const

export type JevOverride = { model?: string | Partial<Record<ProviderId, string>>; flag?: number; mostly?: number }

const NAMES: Record<ProviderId, string> = { typesafe: 'TypeSafe', openrouter: 'OpenRouter' }
const A: Record<ProviderId, string> = { typesafe: 'a TypeSafe', openrouter: 'an OpenRouter' }
const providerOf = (id: string): ProviderId | undefined =>
  id.startsWith('typesafe/') ? 'openrouter' : id.startsWith('jev-') ? 'typesafe' : undefined

/** What's wrong with a `jev` block, or undefined. `provider` is the one in use; without one (no key)
 *  the model isn't checked against it. */
export function jevError(jev: unknown, provider: ProviderId | undefined): string | undefined {
  if (jev === undefined) return undefined
  if (typeof jev !== 'object' || jev === null || Array.isArray(jev)) return '"jev" must be an object'
  const j = jev as Record<string, unknown>
  for (const k of ['flag', 'mostly']) {
    const v = j[k]
    if (v !== undefined && (typeof v !== 'number' || v < 0 || v > 1)) return `"jev.${k}" must be a number from 0 to 1`
  }
  const m = j.model
  if (m === undefined) return undefined
  if (typeof m === 'string') {
    const of = providerOf(m)
    if (!of) return `"jev.model" ${m} is neither a TypeSafe ID (jev-…) nor an OpenRouter ID (typesafe/…)`
    if (provider && of !== provider) return `"jev.model" ${m} is ${A[of]} ID, but md-scrub is using ${NAMES[provider]}`
    return undefined
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return '"jev.model" must be a model ID or { "typesafe": …, "openrouter": … }'
  for (const [k, v] of Object.entries(m)) {
    if (k !== 'typesafe' && k !== 'openrouter') return `"jev.model" has "${k}"; use "typesafe" or "openrouter"`
    if (typeof v !== 'string' || providerOf(v) !== k) return `"jev.model.${k}" must be ${A[k]} ID (${k === 'typesafe' ? 'jev-…' : 'typesafe/…'})`
  }
  if (provider && !(m as Record<string, unknown>)[provider]) return `"jev.model" gives no ${NAMES[provider]} ID, and md-scrub is using ${NAMES[provider]}`
  return undefined
}

/** The model a topic asks for under `provider`, or undefined for md-scrub's own. Assumes `jevError` passed. */
export function topicModel(jev: JevOverride | undefined, provider: ProviderId): string | undefined {
  const m = jev?.model
  return typeof m === 'string' ? m : m?.[provider]
}
