import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import { ModelError } from '../errors.js'

// OpenAI, and any OpenAI-compatible API (Gemini, OpenRouter, Groq, Ollama…), via the official SDK:
// chat.completions.parse with a strict JSON-schema response format. Compatible servers that don't support
// JSON schemas get a fallback: ask for a JSON object that follows the schema, then validate it here.
export function createOpenAIProvider({ apiKey = process.env.OPENAI_API_KEY, baseURL, model = process.env.OPENAI_MODEL || 'gpt-5.5', name = 'openai', compatible = false } = {}) {
  const client = new OpenAI({ apiKey: apiKey || 'not-needed', ...(baseURL ? { baseURL } : {}) })
  // reasoning_effort only applies to OpenAI's reasoning models (gpt-5 family, o-series).
  const reasoning = !compatible && /^(gpt-5|o\d)/.test(model)

  async function strict({ messages, schema, name: schemaName, effort }) {
    const completion = await client.chat.completions.parse({
      model, messages,
      response_format: zodResponseFormat(schema, schemaName),
      ...(reasoning ? { reasoning_effort: effort } : {}),
    })
    const choice = completion.choices[0]
    if (choice?.message?.refusal) throw new ModelError(422, 'refused', 'The model declined this request. Try removing unusual content from the job description.')
    if (choice?.finish_reason === 'length') throw new ModelError(502, 'truncated', 'The response was cut off. Try a shorter job description.')
    if (!choice?.message?.parsed) throw new ModelError(502, 'bad_output', 'The model returned an unexpected format. Please try again.')
    return choice.message.parsed
  }

  async function loose({ messages, schema, name: schemaName }) {
    const jsonSchema = zodResponseFormat(schema, schemaName).json_schema.schema
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: `${messages[0].content}\n\nReply with only a JSON object that matches this JSON Schema:\n${JSON.stringify(jsonSchema)}` },
        ...messages.slice(1),
      ],
      response_format: { type: 'json_object' },
    })
    const text = completion.choices[0]?.message?.content ?? ''
    let data
    try { data = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { throw new ModelError(502, 'bad_output', `${model} didn’t return valid JSON. Try a more capable model.`) }
    const parsed = schema.safeParse(data)
    if (!parsed.success) throw new ModelError(502, 'bad_output', `${model} returned JSON in the wrong shape. Try a more capable model.`)
    return parsed.data
  }

  async function structured({ system, stable = [], volatile, schema, effort = 'medium', name: schemaName = 'result' }) {
    // Stable content first: OpenAI caches long, identical prompt prefixes automatically.
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: [...stable, volatile].join('\n\n') },
    ]
    try {
      return await strict({ messages, schema, name: schemaName, effort })
    } catch (error) {
      if (error instanceof ModelError) throw error
      // Compatible servers often reject json_schema response formats; retry the portable way.
      if (compatible && error instanceof OpenAI.BadRequestError) {
        try { return await loose({ messages, schema, name: schemaName }) } catch (e) { throw e instanceof ModelError ? e : toModelError(e, name) }
      }
      throw toModelError(error, name)
    }
  }

  // Model ids the endpoint offers (used by the Integrations page). Throws only if the endpoint can't be
  // reached at all; an endpoint that doesn't list models gives an empty list.
  async function listModels() {
    try {
      const page = await client.models.list()
      return page.data.map(m => m.id).sort()
    } catch (error) {
      if (error instanceof OpenAI.APIConnectionError) throw toModelError(error, name)
      return []
    }
  }

  return { name, model, structured, listModels }
}

function toModelError(error, name = 'openai') {
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new ModelError(500, 'server_config', name === 'openai' ? 'The OpenAI API key is missing or invalid.' : 'The API key for this provider is missing or invalid.')
  }
  // OpenAI uses 429 both for rate limits and for an account with no credits left.
  if (error instanceof OpenAI.RateLimitError && /insufficient_quota|credit_balance|billing/i.test(`${error.code} ${error.type} ${error.error?.code} ${error.error?.type}`)) {
    return new ModelError(402, 'no_credits', 'This AI account has no API credits left. Add credits with the provider, or switch provider on the Integrations page.')
  }
  if (error instanceof OpenAI.RateLimitError) return new ModelError(429, 'rate_limited', 'Too many requests right now — try again in a minute.')
  if (error instanceof OpenAI.NotFoundError) return new ModelError(500, 'server_config', `Model not found — check the model name on the Integrations page (${error.message}).`)
  if (error instanceof OpenAI.BadRequestError) return new ModelError(502, 'bad_request', `The provider rejected the request: ${error.message}`)
  if (error instanceof OpenAI.APIConnectionError) return new ModelError(503, 'unreachable', name === 'openai' ? 'Couldn’t reach the OpenAI API.' : 'Couldn’t reach this provider. Check the endpoint URL (and that it’s running, for local models).')
  if (error instanceof OpenAI.APIError) return new ModelError(502, 'upstream', `Provider API error (${error.status}).`)
  return new ModelError(500, 'internal', error.message || 'Unexpected error')
}
