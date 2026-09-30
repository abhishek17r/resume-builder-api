import { createHash } from 'node:crypto'
import { createAnthropicProvider } from './providers/anthropic.js'
import { createOpenAIProvider } from './providers/openai.js'
import { activeId, configOf, migrateEnvKeys } from './integrations.js'

// Which AI to use: the provider chosen on the app's Integrations page, and nothing else. Keys live in the
// integrations file (see integrations.js), not in .env. With none chosen, AI features report "not connected".
// MOCK=1 forces demo mode (keyword heuristics, no API calls): used by the tests and the demo recorder.

// One-time move: keys from an older .env (OPENAI_API_KEY / ANTHROPIC_API_KEY) become integrations, so an
// existing setup keeps working; after that, .env keys are ignored.
if (process.env.MOCK !== '1') migrateEnvKeys()

export function buildProvider(cfg) {
  if (cfg.kind === 'anthropic') return createAnthropicProvider({ apiKey: cfg.apiKey || undefined, model: cfg.model })
  return createOpenAIProvider({
    apiKey: cfg.apiKey || undefined, baseURL: cfg.baseURL || undefined, model: cfg.model,
    name: cfg.kind === 'openai' ? 'openai' : cfg.id, compatible: cfg.kind === 'openai-compatible',
  })
}

let current = { key: null, cfg: null, provider: null }
function resolve() {
  const saved = activeId() && configOf(activeId())
  const cfg = process.env.MOCK === '1' || !saved ? null : { ...saved, source: 'integrations' }
  const key = JSON.stringify(cfg)
  if (key !== current.key) current = { key, cfg, provider: cfg ? buildProvider(cfg) : null }
  return current
}

// Demo mode only when forced (MOCK=1); otherwise no provider means "not connected".
export const isMock = () => process.env.MOCK === '1'
export const isConnected = () => !!resolve().provider

// What's in use, for /health and the Integrations page (never includes a key).
export function providerInfo() {
  const { cfg, provider } = resolve()
  return { mock: isMock(), connected: !!provider, provider: provider?.name ?? null, model: provider?.model ?? null, label: cfg?.label ?? null, source: cfg?.source ?? null }
}

// Small in-memory LRU so repeating the same request (same resume + same JD) doesn't pay twice.
const CACHE_MAX = 200
const cache = new Map()

/** One structured call → an object matching `schema`. See providers/*.js for the per-vendor details. */
export async function structured(args) {
  const { provider, cfg } = resolve()
  const key = createHash('sha256').update(JSON.stringify([cfg?.id, cfg?.baseURL, provider.name, provider.model, args.system, args.stable, args.volatile, args.effort, args.name])).digest('hex')
  if (cache.has(key)) return cache.get(key)
  const result = await provider.structured(args)
  cache.set(key, result)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return result
}
