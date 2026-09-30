import { Router } from 'express'
import { z } from 'zod'
import { PRESETS, listIntegrations, saveIntegration, removeIntegration, setActive, configOf } from '../integrations.js'
import { buildProvider, providerInfo } from '../ai.js'

// The Integrations page: bring your own AI provider. These routes hold API keys, so they only answer
// requests from this computer, and never return a key (only a masked hint).
export const integrations = Router()

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
integrations.use((req, res, next) => (LOOPBACK.has(req.socket.remoteAddress)
  ? next()
  : res.status(403).json({ error: { code: 'local_only', message: 'Integrations can only be changed from this computer.' } })))

const bad = (res, message) => res.status(400).json({ error: { code: 'invalid', message } })
const known = id => Object.hasOwn(PRESETS, id)

const Save = z.object({
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  baseURL: z.union([z.literal(''), z.string().max(500).url().refine(u => /^https?:\/\//.test(u), 'Use an http(s) URL')]).optional(),
})

const snapshot = () => ({ integrations: listIntegrations(), current: providerInfo() })

integrations.get('/', (_req, res) => res.json(snapshot()))

integrations.put('/:id', (req, res) => {
  const { id } = req.params
  if (!known(id)) return bad(res, 'Unknown provider.')
  const parsed = Save.safeParse(req.body ?? {})
  if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? 'Invalid settings.')
  const body = parsed.data
  if (id === 'custom' && !(body.baseURL ?? configOf(id)?.baseURL)) return bad(res, 'A custom endpoint needs its base URL.')
  saveIntegration(id, body)
  res.json(snapshot())
})

integrations.delete('/:id', (req, res) => {
  if (!known(req.params.id)) return bad(res, 'Unknown provider.')
  removeIntegration(req.params.id)
  res.json(snapshot())
})

integrations.post('/active', (req, res) => {
  const id = req.body?.id ?? null
  if (id !== null && !(known(id) && configOf(id))) return bad(res, 'Save this provider before using it.')
  setActive(id)
  res.json(snapshot())
})

// Check a saved provider: list its models, then make one tiny structured call.
const Ping = z.object({ ok: z.boolean() })
integrations.post('/:id/test', async (req, res) => {
  const cfg = known(req.params.id) && configOf(req.params.id)
  if (!cfg) return bad(res, 'Save this provider before testing it.')
  if (PRESETS[cfg.id].needsKey && !cfg.apiKey) return res.json({ ok: false, error: 'Add an API key first.' })
  const provider = buildProvider(cfg)
  let models
  try { models = await provider.listModels() } catch (error) { return res.json({ ok: false, error: error.message }) }
  if (!cfg.model) return res.json({ ok: false, models, error: models.length ? 'Choose a model, then test again.' : 'Enter a model name, then test again.' })
  const started = Date.now()
  try {
    const out = await provider.structured({
      system: 'You check that an API connection works. Reply with the requested JSON only.',
      volatile: 'Return {"ok": true}.',
      schema: Ping, name: 'ping', effort: 'low', maxTokens: 256,
    })
    res.json({ ok: out.ok === true, latencyMs: Date.now() - started, model: cfg.model, models })
  } catch (error) {
    res.json({ ok: false, models, error: error.message || 'The provider returned an error.' })
  }
})
