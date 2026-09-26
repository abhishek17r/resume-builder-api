import { Router } from 'express'
import { structured, MOCK } from '../claude.js'
import { AnalyzeRequest, MatchRequest, SuggestRequest, ImproveRequest, JobAnalysis, MatchResult, Suggestions, Rewrites } from '../schemas.js'
import { ANALYZE_SYSTEM, MATCH_SYSTEM, SUGGEST_SYSTEM, IMPROVE_SYSTEM } from '../prompts.js'
import { mockAnalyze, mockMatch, mockSuggest, mockImprove } from '../mock.js'

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
    effort: 'high',
  })
  const suggestions = out.suggestions.filter(s => refExists(resume, s.target) && s.after.trim())
  res.json({ mock: MOCK, suggestions })
}))

router.post('/improve', asyncRoute(async (req, res) => {
  const { context, bullets } = validate(ImproveRequest, req.body)
  const out = MOCK ? mockImprove(bullets) : await structured({
    system: IMPROVE_SYSTEM,
    volatile: `<context>${JSON.stringify(context)}</context>\n<bullets>\n${JSON.stringify(bullets)}\n</bullets>`,
    schema: Rewrites,
    effort: 'low',
  })
  const refs = new Set(bullets.map(b => b.ref))
  res.json({ mock: MOCK, rewrites: out.rewrites.filter(r => refs.has(r.ref)) })
}))
