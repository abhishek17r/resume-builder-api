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

test('vault/match validates and only returns known refs', async () => {
  const bad = await post('/api/vault/match', { analysis: { title: 'x', company: '', seniority: 'unknown', summary: '', requirements: [] }, candidates: [] })
  assert.equal(bad.status, 400)
  const analysis = { title: 'Backend', company: '', seniority: 'senior', summary: '', requirements: [{ id: 'r1', text: 'Kafka', category: 'tool', importance: 'must', keywords: ['Kafka'] }] }
  const r = await post('/api/vault/match', { analysis, coverage: [{ id: 'r1', status: 'missing' }], candidates: [{ ref: 'v1', text: 'Moved billing events to Kafka, cutting lag 90%.' }, { ref: 'v2', text: 'Organised the team offsite.' }] })
  const body = await r.json()
  assert.equal(r.status, 200)
  assert.deepEqual(body.picks.map(p => p.ref), ['v1'])
  assert.deepEqual(body.picks[0].requirementIds, ['r1'])
})

test('resume/compose keeps only known refs, owned by their item', async () => {
  const analysis = { title: 'Backend', company: '', seniority: 'senior', summary: '', requirements: [{ id: 'r1', text: 'Kafka', category: 'tool', importance: 'must', keywords: ['Kafka'] }] }
  const items = [
    { ref: 'i1', kind: 'experience', title: 'Stripe', roles: [{ title: 'Engineer', dates: '2021 – Present' }], bullets: [{ ref: 'b1', text: 'Moved billing to Kafka.', role: 'Engineer', score: 90 }, { ref: 'b2', text: 'Ran the offsite.', role: 'Engineer', score: 40 }] },
    { ref: 'i2', kind: 'skills', title: 'Systems', bullets: [{ ref: 's1', text: 'Kafka' }, { ref: 's2', text: 'Excel' }] },
    { ref: 'i3', kind: 'summaries', title: 'Profile summaries', bullets: [{ ref: 'p1', text: 'Backend engineer.' }] },
  ]
  const r = await post('/api/resume/compose', { analysis, targetBullets: 6, headlines: ['Backend Engineer'], items })
  const { composition } = await r.json()
  assert.equal(r.status, 200)
  assert.equal(composition.summaryRef, 'p1')
  assert.equal(composition.headline, 'Backend Engineer')
  assert.deepEqual(composition.entries.map(e => [e.itemRef, e.roleTitle, e.bulletRefs[0]]), [['i1', 'Engineer', 'b1']])
  assert.equal(composition.skillRefs[0], 's1')
  const bad = await post('/api/resume/compose', { analysis, items: [] })
  assert.equal(bad.status, 400)
})
