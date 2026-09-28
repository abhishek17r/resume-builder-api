import { Router } from 'express'
import { structured, MOCK } from '../ai.js'
import { AnalyzeRequest, MatchRequest, SuggestRequest, ImproveRequest, JobAnalysis, MatchResult, Suggestions, Rewrites, TagRequest, TagResult, VaultMatchRequest, VaultPicks, ComposeRequest, Composition } from '../schemas.js'
import { ANALYZE_SYSTEM, MATCH_SYSTEM, SUGGEST_SYSTEM, IMPROVE_SYSTEM, TAG_SYSTEM, VAULT_MATCH_SYSTEM, COMPOSE_SYSTEM } from '../prompts.js'
import { mockAnalyze, mockMatch, mockSuggest, mockImprove, mockVaultMatch, mockCompose } from '../mock.js'

export const router = Router()

// Validate the body with a Zod schema; respond 400 with the first problem.
const validate = (schema, body) => {
  const r = schema.safeParse(body)
  if (!r.success) {
    const issue = r.error.issues[0]
    const err = new Error(`${issue.path.join('.') || 'body'}: ${issue.message}`)
    err.status = 400
    err.code = 'invalid_request'
    throw err
  }
  return r.data
}

const asyncRoute = fn => (req, res, next) => fn(req, res).catch(next)

// The resume as compact text the model reads, with the ids it must cite.
function resumeText(resume) {
  const lines = [`CANDIDATE: ${resume.name}${resume.title ? ` — ${resume.title}` : ''}`]
  for (const s of resume.sections) {
    lines.push('', `## ${s.heading} [sectionId=${s.id} type=${s.type}]`)
    for (const e of s.entries) {
      const head = [e.title, e.subtitle].filter(Boolean).join(', ')
      const meta = [e.dates, e.location].filter(Boolean).join(' | ')
      lines.push(`- entryId=${e.id}: ${head}${meta ? ` (${meta})` : ''}`)
      for (const b of e.bullets) lines.push(`    [bullet ${b.i}] ${b.text}`)
    }
  }
  return lines.join('\n')
}

// Keep only references that exist in the resume we were sent — the UI applies edits by these ids.
function refExists(resume, { sectionId, entryId, bullet }) {
  const entry = resume.sections.find(s => s.id === sectionId)?.entries.find(e => e.id === entryId)
  if (!entry) return false
  return bullet === -1 || entry.bullets.some(b => b.i === bullet)
}

router.post('/jd/analyze', asyncRoute(async (req, res) => {
  const { jobDescription } = validate(AnalyzeRequest, req.body)
  const analysis = MOCK ? mockAnalyze(jobDescription) : await structured({
    system: ANALYZE_SYSTEM,
    volatile: `<job_description>\n${jobDescription}\n</job_description>`,
    schema: JobAnalysis,
    name: 'job_analysis',
    effort: 'medium',
  })
  res.json({ mock: MOCK, analysis })
}))

router.post('/jd/match', asyncRoute(async (req, res) => {
  const { resume, analysis } = validate(MatchRequest, req.body)
  const match = MOCK ? mockMatch(resume, analysis) : await structured({
    system: MATCH_SYSTEM,
    stable: [`<resume>\n${resumeText(resume)}\n</resume>`],
    volatile: `<job_analysis>\n${JSON.stringify(analysis)}\n</job_analysis>`,
    schema: MatchResult,
    name: 'match_result',
    effort: 'medium',
  })
  const known = new Set(analysis.requirements.map(r => r.id))
  match.requirements = match.requirements
    .filter(r => known.has(r.id))
    .map(r => ({ ...r, evidence: r.evidence.filter(e => refExists(resume, e)) }))
  match.matchScore = Math.max(0, Math.min(100, Math.round(match.matchScore)))
  res.json({ mock: MOCK, match })
}))

router.post('/jd/suggest', asyncRoute(async (req, res) => {
  const { resume, analysis, match } = validate(SuggestRequest, req.body)
  const out = MOCK ? mockSuggest(resume, analysis, match) : await structured({
    system: SUGGEST_SYSTEM,
    stable: [`<resume>\n${resumeText(resume)}\n</resume>`],
    volatile: `<job_analysis>\n${JSON.stringify(analysis)}\n</job_analysis>\n<coverage>\n${JSON.stringify(match)}\n</coverage>`,
    schema: Suggestions,
    name: 'suggestions',
    effort: 'high',
  })
  const suggestions = out.suggestions.filter(s => refExists(resume, s.target) && s.after.trim())
  if (suggestions.length < out.suggestions.length) {
    console.warn(`suggest: dropped ${out.suggestions.length - suggestions.length}/${out.suggestions.length} with unknown targets`, out.suggestions.filter(s => !suggestions.includes(s)).map(s => ({ kind: s.kind, target: s.target })))
  }
  res.json({ mock: MOCK, suggestions })
}))

router.post('/improve', asyncRoute(async (req, res) => {
  const { context, bullets } = validate(ImproveRequest, req.body)
  const out = MOCK ? mockImprove(bullets) : await structured({
    system: IMPROVE_SYSTEM,
    volatile: `<context>${JSON.stringify(context)}</context>\n<bullets>\n${JSON.stringify(bullets)}\n</bullets>`,
    schema: Rewrites,
    name: 'rewrites',
    effort: 'low',
  })
  const byRef = new Map(bullets.map(b => [b.ref, b]))
  const norm = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const rewrites = out.rewrites
    .filter(r => byRef.has(r.ref))
    .map(r => (r.verdict === 'rewritten' && norm(r.after) === norm(byRef.get(r.ref).text) ? { ...r, verdict: 'already_fine', after: byRef.get(r.ref).text } : r))
  res.json({ mock: MOCK, rewrites })
}))

// Classify vault bullets against the app's taxonomy (sent by the frontend, which owns the list).
router.post('/vault/tag', asyncRoute(async (req, res) => {
  const { taxonomy, bullets } = validate(TagRequest, req.body)
  if (MOCK) return res.json({ mock: true, tags: [] }) // demo mode: keep the frontend's keyword tags
  const out = await structured({
    system: TAG_SYSTEM,
    stable: [`<taxonomy>\n${JSON.stringify(taxonomy)}\n</taxonomy>`],
    volatile: `<bullets>\n${JSON.stringify(bullets)}\n</bullets>`,
    schema: TagResult,
    name: 'tag_result',
    effort: 'low',
  })
  const ids = new Set(taxonomy.map(t => t.id))
  const refs = new Set(bullets.map(b => b.ref))
  const tags = out.tags
    .filter(t => refs.has(t.ref))
    .map(t => ({ ref: t.ref, tagIds: [...new Set(t.tagIds.filter(id => ids.has(id)))].slice(0, 3) }))
  res.json({ mock: false, tags })
}))

// Choose vault bullets that add evidence for a job's requirements. Only picks from the candidates sent.
router.post('/vault/match', asyncRoute(async (req, res) => {
  const { analysis, coverage, candidates } = validate(VaultMatchRequest, req.body)
  const out = MOCK ? mockVaultMatch(analysis, candidates) : await structured({
    system: VAULT_MATCH_SYSTEM,
    stable: [`<job_analysis>\n${JSON.stringify(analysis)}\n</job_analysis>\n<coverage>\n${JSON.stringify(coverage)}\n</coverage>`],
    volatile: `<candidates>\n${JSON.stringify(candidates)}\n</candidates>`,
    schema: VaultPicks,
    name: 'vault_picks',
    effort: 'low',
  })
  const refs = new Set(candidates.map(c => c.ref))
  const reqIds = new Set(analysis.requirements.map(r => r.id))
  const seen = new Set()
  const picks = out.picks
    .filter(p => refs.has(p.ref) && !seen.has(p.ref) && seen.add(p.ref))
    .map(p => ({ ...p, requirementIds: p.requirementIds.filter(id => reqIds.has(id)) }))
    .slice(0, 10)
  res.json({ mock: MOCK, picks })
}))

// Choose vault content for a new resume tailored to a job. Returns refs only; the frontend builds the resume.
router.post('/resume/compose', asyncRoute(async (req, res) => {
  const { analysis, targetBullets, items } = validate(ComposeRequest, req.body)
  const out = MOCK ? mockCompose(analysis, items, targetBullets) : await structured({
    system: COMPOSE_SYSTEM,
    stable: [`<vault>\n${JSON.stringify(items)}\n</vault>`],
    volatile: `<job_analysis>\n${JSON.stringify(analysis)}\n</job_analysis>\n<target_bullets>${targetBullets}</target_bullets>`,
    schema: Composition,
    name: 'composition',
    effort: 'medium',
  })
  const itemByRef = new Map(items.map(i => [i.ref, i]))
  const bulletOwner = new Map(items.flatMap(i => i.bullets.map(b => [b.ref, i])))
  const used = new Set()
  const entries = []
  for (const e of out.entries) {
    const item = itemByRef.get(e.itemRef)
    if (!item || item.kind === 'skills' || item.kind === 'summaries') continue
    const roleTitle = item.roles.some(r => r.title === e.roleTitle) ? e.roleTitle : ''
    const key = `${item.ref}|${roleTitle}`
    if (used.has(key)) continue
    used.add(key)
    const bulletRefs = [...new Set(e.bulletRefs)].filter(ref => bulletOwner.get(ref) === item)
    entries.push({ itemRef: item.ref, roleTitle, bulletRefs })
  }
  const skillRefs = [...new Set(out.skillRefs)].filter(ref => bulletOwner.get(ref)?.kind === 'skills')
  const summaryRef = bulletOwner.get(out.summaryRef)?.kind === 'summaries' ? out.summaryRef : ''
  if (entries.length < out.entries.length) console.warn(`compose: dropped ${out.entries.length - entries.length}/${out.entries.length} entries with unknown refs`)
  res.json({ mock: MOCK, composition: { summaryRef, entries, skillRefs, gaps: out.gaps.slice(0, 10) } })
}))
