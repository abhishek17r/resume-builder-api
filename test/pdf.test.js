import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { findChrome, closePdfBrowser } from '../src/pdf.js'

let server
let base
before(() => new Promise(resolve => { server = createApp().listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve() }) }))
after(() => { closePdfBrowser(); server.close() })

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('pdf rejects anything that is not an HTML document', async () => {
  assert.equal((await post('/api/pdf', { html: 'hello' })).status, 400)
})

test('pdf renders an A4 page with the local browser', { skip: !findChrome() && 'no Chrome/Chromium/Edge/Brave here' }, async () => {
  const html = '<!doctype html><html><head><style>@page { size: 210mm 297mm; margin: 0 } body { font: 12pt serif }</style></head><body><h1>John Doe</h1><p>Staff Software Engineer</p></body></html>'
  const res = await post('/api/pdf', { html })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/pdf')
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
  assert.match(bytes.toString('latin1'), /\/MediaBox \[0 0 59[45](\.\d+)? 841(\.\d+)?\]/) // A4 is 595 × 842 points
})

test('AI endpoints say "not connected" when no provider is set up', async () => {
  const saved = process.env.MOCK
  delete process.env.MOCK
  try {
    const res = await post('/api/improve', { bullets: [{ ref: 'b', text: 'Led things.', issue: 'metric' }] })
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error.code, 'ai_not_connected')
  } finally { process.env.MOCK = saved }
})
