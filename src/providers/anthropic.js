import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { ModelError } from '../errors.js'

// Claude via the Anthropic SDK: one messages.parse call with a Zod output format.
export function createAnthropicProvider({ apiKey, model = process.env.CLAUDE_MODEL || 'claude-opus-5' } = {}) {
  const client = new Anthropic(apiKey ? { apiKey } : {})

  async function structured({ system, stable = [], volatile, schema, effort = 'medium', maxTokens = 16000 }) {
    // Stable blocks (e.g. the resume, reused across match → suggest) come first with a cache breakpoint.
    const content = [
      ...stable.map((text, i) => ({ type: 'text', text, ...(i === stable.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) })),
      { type: 'text', text: volatile },
    ]
    let response
    try {
      response = await client.messages.parse({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
        output_config: { effort, format: zodOutputFormat(schema) },
      })
    } catch (error) {
      throw toModelError(error)
    }
    if (response.stop_reason === 'refusal') throw new ModelError(422, 'refused', 'The model declined this request. Try removing unusual content from the job description.')
    if (response.stop_reason === 'max_tokens') throw new ModelError(502, 'truncated', 'The response was cut off. Try a shorter job description.')
    if (!response.parsed_output) throw new ModelError(502, 'bad_output', 'The model returned an unexpected format. Please try again.')
    return response.parsed_output
  }

  async function listModels() {
    try {
      const page = await client.models.list({ limit: 100 })
      return page.data.map(m => m.id)
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionError) throw toModelError(error)
      return []
    }
  }

  return { name: 'anthropic', model, structured, listModels }
}

// Most specific first; only rate limits and server/network errors are worth retrying from the client.
function toModelError(error) {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ModelError(500, 'server_config', 'The Anthropic API key is missing or invalid.')
  }
  if (error instanceof Anthropic.RateLimitError) return new ModelError(429, 'rate_limited', 'Too many requests right now — try again in a minute.')
  if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(error.message)) {
    return new ModelError(402, 'no_credits', 'Your Anthropic account has no API credits left. Add credits in the Anthropic Console → Billing, or switch provider on the Integrations page.')
  }
  if (error instanceof Anthropic.BadRequestError) return new ModelError(502, 'bad_request', `Claude rejected the request: ${error.message}`)
  if (error instanceof Anthropic.APIConnectionError) return new ModelError(503, 'unreachable', 'Couldn’t reach the Claude API.')
  if (error instanceof Anthropic.APIError) return new ModelError(502, 'upstream', `Claude API error (${error.status}).`)
  return new ModelError(500, 'internal', error.message || 'Unexpected error')
}
