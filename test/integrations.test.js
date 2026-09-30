import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.js'
import { _reset } from '../src/integrations.js'

// Integrations are saved to a throwaway data folder; keys must never come back to the client.
const dir = mkdtempSync(join(tmpdir(), 'offerstack-int-'))
let server
let base
before(() => new Promise(resolve => {
  process.env.OFFERSTACK_DATA = dir
  _reset()
  server = createApp().listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve() })
}))
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

const call = (method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }))

test('lists every preset, none configured at first', async () => {
  const { status, body } = await call('GET', '/api/integrations')
  assert.equal(status, 200)
  assert.ok(body.integrations.some(i => i.id === 'anthropic'))
  assert.ok(body.integrations.every(i => !i.configured && !i.hasKey))
})

test('saves a key, returns only a masked hint, and stores the file privately', async () => {
  const { body } = await call('PUT', '/api/integrations/openai', { apiKey: 'sk-test-1234567890abcd', model: 'gpt-5.5' })
  const openai = body.integrations.find(i => i.id === 'openai')
  assert.equal(openai.hasKey, true)
  assert.equal(openai.keyHint, '••••abcd')
  assert.ok(!JSON.stringify(body).includes('sk-test'))
  const file = join(dir, 'integrations.json')
  assert.ok(readFileSync(file, 'utf8').includes('sk-test-1234567890abcd'))
  assert.equal(statSync(file).mode & 0o077, 0) // no access for group or others
  // Saving again without a key keeps the saved one
  const again = await call('PUT', '/api/integrations/openai', { model: 'gpt-5-mini' })
  assert.equal(again.body.integrations.find(i => i.id === 'openai').keyHint, '••••abcd')
})

test('validates providers and endpoints', async () => {
  assert.equal((await call('PUT', '/api/integrations/nope', { apiKey: 'x' })).status, 400)
  assert.equal((await call('PUT', '/api/integrations/groq', { apiKey: 'x' })).status, 400) // coming soon
  assert.equal((await call('PUT', '/api/integrations/gemini', { baseURL: 'ftp://x', model: 'm' })).status, 400)
  assert.equal((await call('POST', '/api/integrations/active', { id: 'gemini' })).status, 400) // not saved yet
  const list = (await call('GET', '/api/integrations')).body.integrations
  assert.deepEqual(list.filter(i => !i.soon).map(i => i.id), ['openai', 'anthropic', 'gemini'])
})

test('switches the active provider and removes one', async () => {
  const on = await call('POST', '/api/integrations/active', { id: 'openai' })
  assert.equal(on.body.integrations.find(i => i.id === 'openai').active, true)
  const off = await call('DELETE', '/api/integrations/openai')
  assert.equal(off.body.integrations.find(i => i.id === 'openai').configured, false)
  assert.ok(off.body.integrations.every(i => !i.active))
})

test('testing an unreachable endpoint reports why instead of failing', async () => {
  await call('PUT', '/api/integrations/openai', { apiKey: 'sk-test', baseURL: 'http://127.0.0.1:9/v1', model: 'gpt-5-mini' })
  const { status, body } = await call('POST', '/api/integrations/openai/test')
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.match(body.error, /reach|connect/i)
})
