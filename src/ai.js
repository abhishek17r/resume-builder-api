import { createHash } from 'node:crypto'
import { createAnthropicProvider } from './providers/anthropic.js'
import { createOpenAIProvider } from './providers/openai.js'
import { activeId, configOf } from './integrations.js'

// Which AI to use, decided on every request so switching on the Integrations page needs no restart:
//   1. the integration chosen on the Integrations page (saved on this machine), else
//   2. the .env settings: AI_PROVIDER=anthropic|openai, or whichever key is set (Anthropic first), else
//   3. demo mode (keyword heuristics, no API calls). MOCK=1 always forces demo mode.

// Accept common spellings ("OpenAI", "open_ai", "claude"…); anything else is a config error, not a silent fallback.
const ALIASES = { openai: 'openai', gpt: 'openai', chatgpt: 'openai', anthropic: 'anthropic', claude: 'anthropic' }
const raw = (process.env.AI_PROVIDER || '').trim()
const normalised = raw.toLowerCase().replace(/[^a-z]/g, '')
if (raw && !ALIASES[normalised]) {
  throw new Error(`AI_PROVIDER="${raw}" isn't recognised. Use "openai" or "anthropic" (or leave it empty to pick from whichever key is set).`)
}

function envConfig() {
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  const wanted = ALIASES[normalised] || (hasAnthropic ? 'anthropic' : hasOpenAI ? 'openai' : '')
  if (wanted === 'anthropic' && hasAnthropic) return { id: 'env', source: 'env', kind: 'anthropic', label: 'Anthropic (.env)', model: process.env.CLAUDE_MODEL || 'claude-opus-5' }
  if (wanted === 'openai' && hasOpenAI) return { id: 'env', source: 'env', kind: 'openai', label: 'OpenAI (.env)', model: process.env.OPENAI_MODEL || 'gpt-5.5' }
  return null
}

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
  const cfg = process.env.MOCK === '1' ? null : saved ? { ...saved, source: 'integrations' } : envConfig()
  const key = JSON.stringify(cfg)
  if (key !== current.key) current = { key, cfg, provider: cfg ? buildProvider(cfg) : null }
  return current
}

export const isMock = () => !resolve().provider

// What's in use, for /health and the Integrations page (never includes a key).
export function providerInfo() {
  const { cfg, provider } = resolve()
  return { mock: !provider, provider: provider?.name ?? null, model: provider?.model ?? null, label: cfg?.label ?? null, source: cfg?.source ?? null }
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
