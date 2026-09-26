import { createHash } from 'node:crypto'
import { createAnthropicProvider } from './providers/anthropic.js'
import { createOpenAIProvider } from './providers/openai.js'

// Provider selection:
//   AI_PROVIDER=anthropic | openai  — explicit
//   otherwise: Anthropic if its key is set, else OpenAI if its key is set, else demo mode.
//   MOCK=1 forces demo mode (keyword heuristics, no API calls).
const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
const hasOpenAI = !!process.env.OPENAI_API_KEY
const wanted = (process.env.AI_PROVIDER || '').toLowerCase() || (hasAnthropic ? 'anthropic' : hasOpenAI ? 'openai' : '')

export const MOCK = process.env.MOCK === '1' || !wanted || (wanted === 'anthropic' && !hasAnthropic) || (wanted === 'openai' && !hasOpenAI)

const provider = MOCK ? null : wanted === 'openai' ? createOpenAIProvider() : createAnthropicProvider()

export const PROVIDER = provider?.name ?? null
export const MODEL = provider?.model ?? null

// Small in-memory LRU so repeating the same request (same resume + same JD) doesn't pay twice.
const CACHE_MAX = 200
const cache = new Map()

/** One structured call → an object matching `schema`. See providers/*.js for the per-vendor details. */
export async function structured(args) {
  const key = createHash('sha256').update(JSON.stringify([PROVIDER, MODEL, args.system, args.stable, args.volatile, args.effort, args.name])).digest('hex')
  if (cache.has(key)) return cache.get(key)
  const result = await provider.structured(args)
  cache.set(key, result)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return result
}
