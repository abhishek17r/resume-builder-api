import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { createHash } from 'node:crypto'

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5'

// Demo mode: no key configured (or MOCK=1) → routes answer with heuristic results instead.
export const MOCK = process.env.MOCK === '1' || !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)

const client = MOCK ? null : new Anthropic()

export class ModelError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// Small in-memory LRU so repeating the same request (same resume + same JD) doesn't pay twice.
const CACHE_MAX = 200
const cache = new Map()
const keyOf = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
function remember(key, value) {
  cache.set(key, value)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return value
}

/**
 * One structured call: system prompt (cached) + user content blocks → parsed object matching `schema`.
 * `stable` blocks come first and carry a cache breakpoint (e.g. the resume, reused across match/suggest);
 * `volatile` text follows.
 */
export async function structured({ system, stable = [], volatile, schema, effort = 'medium', maxTokens = 16000 }) {
  const key = keyOf(MODEL, system, stable, volatile, effort)
  if (cache.has(key)) return cache.get(key)

  const content = [
    ...stable.map((text, i) => ({
      type: 'text',
      text,
      ...(i === stable.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    })),
    { type: 'text', text: volatile },
  ]

  let response
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { effort, format: zodOutputFormat(schema) },
    })
  } catch (error) {
    throw toModelError(error)
  }

  if (response.stop_reason === 'refusal') {
    throw new ModelError(422, 'refused', 'The model declined this request. Try removing unusual content from the job description.')
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ModelError(502, 'truncated', 'The response was cut off. Try a shorter job description.')
  }
  if (!response.parsed_output) {
    throw new ModelError(502, 'bad_output', 'The model returned an unexpected format. Please try again.')
  }
  return remember(key, response.parsed_output)
}

// Most specific first; only rate limits and server/network errors are worth retrying from the client.
function toModelError(error) {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ModelError(500, 'server_config', 'The server’s Claude API key is missing or invalid.')
  }
  if (error instanceof Anthropic.RateLimitError) return new ModelError(429, 'rate_limited', 'Too many requests right now — try again in a minute.')
  if (error instanceof Anthropic.BadRequestError) return new ModelError(502, 'bad_request', `Claude rejected the request: ${error.message}`)
  if (error instanceof Anthropic.APIConnectionError) return new ModelError(503, 'unreachable', 'Couldn’t reach the Claude API.')
  if (error instanceof Anthropic.APIError) return new ModelError(502, 'upstream', `Claude API error (${error.status}).`)
  return new ModelError(500, 'internal', error.message || 'Unexpected error')
}
