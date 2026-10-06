import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { router } from './routes/optimize.js'
import { integrations } from './routes/integrations.js'
import { providerInfo } from './ai.js'
import { localOnly } from './local.js'
import { renderPdf, findChrome } from './pdf.js'
import { ModelError } from './errors.js'

export function createApp() {
  const app = express()
  const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5190').split(',').map(s => s.trim())

  app.disable('x-powered-by')
  app.use(cors({ origin: origins }))

  // Resume → PDF with the local Chrome, so Download saves a file without a print dialog.
  // Its own body limit: the page's HTML and styles are larger than an API request.
  app.post('/api/pdf', localOnly, express.json({ limit: '20mb' }), async (req, res, next) => {
    try {
      const html = req.body?.html
      if (typeof html !== 'string' || !html.includes('<html')) return res.status(400).json({ error: { code: 'invalid', message: 'Send the resume as an HTML document.' } })
      const pdf = await renderPdf(html)
      res.type('application/pdf').send(pdf)
    } catch (err) { next(err) }
  })

  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_req, res) => res.json({ ok: true, ...providerInfo(), pdf: !!findChrome() }))

  // AI calls cost money: cap each client.
  app.use('/api', rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MIN || 20), standardHeaders: 'draft-8', legacyHeaders: false }))
  app.use('/api/integrations', integrations)
  app.use('/api', router)

  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }))

  // Errors → { error: { code, message } } with a sensible status; never leak stack traces.
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request too large.' } })
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'Body must be JSON.' } })
    const status = err instanceof ModelError || err.status ? err.status : 500
    if (status >= 500) console.error(err)
    res.status(status).json({ error: { code: err.code || 'internal', message: status >= 500 && !(err instanceof ModelError) ? 'Something went wrong.' : err.message } })
  })
  return app
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787)
  // Local-only by default: this server holds your API keys. Set HOST=0.0.0.0 to expose it deliberately.
  const host = process.env.HOST || '127.0.0.1'
  createApp().listen(port, host, () => {
    const p = providerInfo()
    console.log(`refit AI server on http://localhost:${port} — ${p.mock ? 'DEMO MODE (no provider set up; heuristic results)' : `${p.label} · ${p.model}`}`)
  })
}
