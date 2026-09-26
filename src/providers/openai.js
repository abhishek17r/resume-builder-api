import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import { ModelError } from '../errors.js'

// OpenAI via the official SDK: chat.completions.parse with a strict JSON-schema response format.
export function createOpenAIProvider({ model = process.env.OPENAI_MODEL || 'gpt-5' } = {}) {
  const client = new OpenAI()
  // reasoning_effort only applies to reasoning models (gpt-5 family, o-series).
  const reasoning = /^(gpt-5|o\d)/.test(model)

  async function structured({ system, stable = [], volatile, schema, effort = 'medium', name = 'result' }) {
    let completion
    try {
      completion = await client.chat.completions.parse({
        model,
        // Stable content first: OpenAI caches long, identical prompt prefixes automatically.
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [...stable, volatile].join('\n\n') },
        ],
        response_format: zodResponseFormat(schema, name),
        ...(reasoning ? { reasoning_effort: effort } : {}),
      })
    } catch (error) {
      throw toModelError(error)
    }
    const choice = completion.choices[0]
    if (choice?.message?.refusal) throw new ModelError(422, 'refused', 'The model declined this request. Try removing unusual content from the job description.')
    if (choice?.finish_reason === 'length') throw new ModelError(502, 'truncated', 'The response was cut off. Try a shorter job description.')
    if (!choice?.message?.parsed) throw new ModelError(502, 'bad_output', 'The model returned an unexpected format. Please try again.')
    return choice.message.parsed
  }

  return { name: 'openai', model, structured }
}

function toModelError(error) {
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new ModelError(500, 'server_config', 'The server’s OpenAI API key is missing or invalid.')
  }
  if (error instanceof OpenAI.RateLimitError) return new ModelError(429, 'rate_limited', 'Too many requests right now — try again in a minute.')
  if (error instanceof OpenAI.NotFoundError) return new ModelError(500, 'server_config', `OpenAI model not found — check OPENAI_MODEL (${error.message}).`)
  if (error instanceof OpenAI.BadRequestError) return new ModelError(502, 'bad_request', `OpenAI rejected the request: ${error.message}`)
  if (error instanceof OpenAI.APIConnectionError) return new ModelError(503, 'unreachable', 'Couldn’t reach the OpenAI API.')
  if (error instanceof OpenAI.APIError) return new ModelError(502, 'upstream', `OpenAI API error (${error.status}).`)
  return new ModelError(500, 'internal', error.message || 'Unexpected error')
}
