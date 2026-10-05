import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'
import { _resetBridge } from '../src/bridge.js'

let server
let base
before(() => new Promise(resolve => { server = createApp().listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve() }) }))
after(() => { _resetBridge(); server.close() })
afterEach(() => _resetBridge())

const json = (method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })

// A stand-in for the open app: reads commands from the event stream.
async function openApp() {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/api/bridge/events`, { signal: ctrl.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const next = async () => {
    for (;;) {
      const m = /^data: (.+)$/m.exec(buf)
      if (m) { buf = buf.slice(buf.indexOf(m[0]) + m[0].length); return JSON.parse(m[1]) }
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      buf += decoder.decode(value)
    }
  }
  await reader.read() // the ": connected" comment
  return { next, close: () => ctrl.abort() }
}

test('says the app is not open when no tab is connected', async () => {
  assert.equal((await json('GET', '/api/bridge/snapshot')).status, 409)
  const res = await json('POST', '/api/bridge/commands', { type: 'add_vault_bullets', args: {} })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.code, 'app_not_open')
})

test('rejects unknown commands', async () => {
  assert.equal((await json('POST', '/api/bridge/commands', { type: 'rm_rf', args: {} })).status, 400)
})

test('relays a command to the open app and returns its result', async () => {
  const app = await openApp()
  await json('PUT', '/api/bridge/snapshot', { resumes: [{ id: 'r1', name: 'PM' }], vault: { items: [], tags: [] }, currentId: 'r1' })
  const snap = await (await json('GET', '/api/bridge/snapshot')).json()
  assert.equal(snap.resumes[0].name, 'PM')

  const pending = json('POST', '/api/bridge/commands', { type: 'add_vault_bullets', args: { title: 'Acme', bullets: ['Shipped X'] } })
  const cmd = await app.next()
  assert.equal(cmd.type, 'add_vault_bullets')
  assert.deepEqual(cmd.args.bullets, ['Shipped X'])
  await json('POST', `/api/bridge/results/${cmd.id}`, { ok: true, result: { added: 1 } })
  const res = await pending
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, result: { added: 1 } })

  // An error from the app comes back as a 422 with its message.
  const failing = json('POST', '/api/bridge/commands', { type: 'replace_resume_bullet', args: {} })
  const cmd2 = await app.next()
  await json('POST', `/api/bridge/results/${cmd2.id}`, { ok: false, error: 'No such entry' })
  const res2 = await failing
  assert.equal(res2.status, 422)
  assert.equal((await res2.json()).error, 'No such entry')
  app.close()
})
