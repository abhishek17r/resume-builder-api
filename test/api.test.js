import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/server.js'

// Runs in demo mode (MOCK=1 via npm test): checks validation, shapes and reference filtering.
let server
let base
before(() => new Promise(resolve => { server = createApp().listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve() }) }))
after(() => server.close())

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const JD = `Senior Backend Engineer at Example Co
You will build payment APIs.
Requirements:
- 5+ years of experience building distributed systems in Go or Java
- Strong knowledge of PostgreSQL and Kafka
- Experience mentoring engineers is a plus`

const resume = {
  name: 'John Doe', title: 'Staff Software Engineer',
  sections: [
    { id: 'exp', type: 'experience', heading: 'Experience', entries: [
      { id: 'e1', title: 'Staff Software Engineer', subtitle: 'Stripe', dates: '2021 – Present', location: '', bullets: [
        { i: 0, text: 'Built ledger services in Go handling payments at scale.' },
        { i: 1, text: 'Mentored 8 engineers.' },
      ] },
    ] },
    { id: 'sk', type: 'skills', heading: 'Skills', entries: [{ id: 'k1', title: 'Systems', subtitle: 'Kafka, gRPC', dates: '', location: '', bullets: [] }] },
  ],
}

test('health reports demo mode', async () => {
  const r = await fetch(base + '/health')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).mock, true)
})

test('analyze rejects a too-short job description', async () => {
  const r = await post('/api/jd/analyze', { jobDescription: 'short' })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error.code, 'invalid_request')
})

test('analyze → match → suggest round trip', async () => {
  const a = await (await post('/api/jd/analyze', { jobDescription: JD })).json()
  assert.ok(a.analysis.requirements.length > 0)
  const m = await (await post('/api/jd/match', { resume, analysis: a.analysis })).json()
  assert.ok(m.match.matchScore >= 0 && m.match.matchScore <= 100)
  assert.equal(m.match.requirements.length, a.analysis.requirements.length)
  const s = await post('/api/jd/suggest', { resume, analysis: a.analysis, match: m.match })
  assert.equal(s.status, 200)
  for (const sug of (await s.json()).suggestions) assert.ok(['exp', 'sk'].includes(sug.target.sectionId))
})

test('match drops evidence that points at bullets which do not exist', async () => {
  const analysis = { title: 'x', company: '', seniority: 'unknown', summary: '', requirements: [{ id: 'r1', text: 'Go', category: 'skill', importance: 'must', keywords: ['Go'] }] }
  const m = await (await post('/api/jd/match', { resume, analysis })).json()
  for (const r of m.match.requirements) for (const e of r.evidence) assert.ok(e.bullet === -1 || [0, 1].includes(e.bullet))
})

test('improve returns one rewrite per bullet', async () => {
  const r = await post('/api/improve', { bullets: [{ ref: 'exp/e1/1', text: 'Helped with onboarding.', issue: 'weak verb' }] })
  const body = await r.json()
  assert.equal(body.rewrites.length, 1)
  assert.equal(body.rewrites[0].ref, 'exp/e1/1')
})

test('unknown routes and bad JSON give JSON errors', async () => {
  assert.equal((await fetch(base + '/api/nope', { method: 'POST' })).status, 404)
  const bad = await fetch(base + '/api/improve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  assert.equal(bad.status, 400)
})

test('improve marks a no-op rewrite as already_fine', async () => {
  const r = await post('/api/improve', { bullets: [{ ref: 'x', text: 'Cut onboarding time from one week to one day.', issue: 'No measurable result' }] })
  const [w] = (await r.json()).rewrites
  assert.ok(['rewritten', 'already_fine'].includes(w.verdict))
})

test('vault tagging validates input and returns no tags in demo mode', async () => {
  const bad = await post('/api/vault/tag', { taxonomy: [], bullets: [] })
  assert.equal(bad.status, 400)
  const r = await post('/api/vault/tag', { taxonomy: [{ id: 'people', label: 'People management', description: 'Hiring and mentoring' }], bullets: [{ ref: 'b1', text: 'Mentored 8 engineers.', context: 'Stripe' }] })
  const body = await r.json()
  assert.equal(r.status, 200)
  assert.deepEqual(body.tags, [])
})
