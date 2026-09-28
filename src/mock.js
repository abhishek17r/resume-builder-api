// Demo-mode answers: simple keyword heuristics with the same shapes as the real endpoints,
// so the app works end to end without an API key. Clearly flagged as `mock: true`.

const STOP = new Set('the and for with you our are will your from that this have has able years year work team role who what we us in of to a an on as or at by be is it its into their they them experience strong plus'.split(' '))
const TECH = /\b([A-Z][A-Za-z0-9+#.]{1,}(?:\s[A-Z][A-Za-z0-9+#.]+)?|[a-z]+(?:\.js|SQL|script))\b/g

const words = t => t.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []

export function mockAnalyze(jd) {
  const lines = jd.split(/\n|(?<=\.)\s+/).map(l => l.replace(/^[\s•*-]+/, '').trim()).filter(l => l.length > 12 && l.length < 220)
  const reqLines = lines.filter(l => /\b(experience|proficien|knowledge|familiar|degree|years|ability|skill|expert|background|track record)\b/i.test(l)).slice(0, 10)
  const requirements = (reqLines.length ? reqLines : lines.slice(0, 6)).map((text, i) => {
    const keywords = [...new Set((text.match(TECH) ?? []).filter(k => !STOP.has(k.toLowerCase())))].slice(0, 4)
    const must = /\b(must|required|requirement|minimum|at least)\b/i.test(text) || i < 3
    const category = /degree|bachelor|master|phd/i.test(text) ? 'education' : /lead|mentor|manage/i.test(text) ? 'leadership' : keywords.length ? 'tool' : 'experience'
    return { id: `r${i + 1}`, text, category, importance: must ? 'must' : 'nice', keywords: keywords.length ? keywords : words(text).filter(w => w.length > 5 && !STOP.has(w)).slice(0, 3) }
  })
  const title = (jd.match(/^(?:job title:\s*)?([A-Z][^\n]{3,60})$/m)?.[1] ?? 'Role from job description').trim()
  return { title, company: jd.match(/\bat ([A-Z][A-Za-z0-9&. ]{1,30})/)?.[1]?.trim() ?? '', seniority: /senior|staff|principal|lead/i.test(jd) ? 'senior' : 'unknown', summary: 'Demo mode: requirements picked out by keyword matching.', requirements }
}

function bulletsOf(resume) {
  return resume.sections.flatMap(s => s.entries.flatMap(e => [
    { sectionId: s.id, entryId: e.id, bullet: -1, text: `${e.title} ${e.subtitle}` },
    ...e.bullets.map(b => ({ sectionId: s.id, entryId: e.id, bullet: b.i, text: b.text })),
  ]))
}

export function mockMatch(resume, analysis) {
  const all = bulletsOf(resume)
  let points = 0
  let max = 0
  const requirements = analysis.requirements.map(r => {
    const terms = (r.keywords.length ? r.keywords : words(r.text)).map(k => k.toLowerCase()).filter(k => k.length > 2)
    const hits = all.filter(b => terms.some(t => b.text.toLowerCase().includes(t)))
    const status = hits.length >= 2 ? 'covered' : hits.length === 1 ? 'partial' : 'missing'
    const weight = r.importance === 'must' ? 3 : 1
    max += weight
    points += weight * (status === 'covered' ? 1 : status === 'partial' ? 0.5 : 0)
    return { id: r.id, status, evidence: hits.slice(0, 3).map(({ sectionId, entryId, bullet }) => ({ sectionId, entryId, bullet })), note: hits.length ? `Found ${terms.filter(t => hits.some(h => h.text.toLowerCase().includes(t))).join(', ')} in your resume.` : 'No matching terms found.' }
  })
  return {
    matchScore: max ? Math.round((points / max) * 100) : 0,
    requirements,
    strengths: requirements.filter(r => r.status === 'covered').slice(0, 3).map(r => analysis.requirements.find(a => a.id === r.id).text),
    gaps: requirements.filter(r => r.status === 'missing').slice(0, 3).map(r => analysis.requirements.find(a => a.id === r.id).text),
  }
}

export function mockSuggest(resume, analysis, match) {
  const suggestions = []
  for (const r of match.requirements) {
    if (r.status === 'missing' || !r.evidence.length) continue
    const ev = r.evidence.find(e => e.bullet >= 0)
    if (!ev) continue
    const entry = resume.sections.find(s => s.id === ev.sectionId)?.entries.find(e => e.id === ev.entryId)
    const bullet = entry?.bullets.find(b => b.i === ev.bullet)
    if (!bullet) continue
    const req = analysis.requirements.find(a => a.id === r.id)
    suggestions.push({
      id: `s${suggestions.length + 1}`, kind: 'rewrite_bullet', target: ev, before: bullet.text,
      after: `${bullet.text.replace(/\.$/, '')}, applying ${req.keywords[0] ?? 'this experience'} to deliver [X]% improvement.`,
      reason: `Demo mode: surfaces “${req.keywords[0] ?? req.text}” for this requirement.`, requirementIds: [r.id],
    })
    if (suggestions.length >= 5) break
  }
  return { suggestions }
}

export function mockImprove(bullets) {
  return {
    rewrites: bullets.map(b => ({
      ref: b.ref,
      verdict: 'rewritten',
      after: `${b.text.replace(/^(responsible for|helped( to)?|worked on|assisted( with)?|involved in)\s+/i, 'Led ').replace(/^I\s+/, '').replace(/\.$/, '')}, improving [metric] by [X]%.`,
      reason: `Demo mode: fixes “${b.issue}” with a template rewrite.`,
    })),
  }
}

// Demo mode: keyword overlap between each candidate and the requirements.
export function mockVaultMatch(analysis, candidates) {
  const picks = candidates.map(c => {
    const t = c.text.toLowerCase()
    const hits = analysis.requirements.filter(r => r.keywords.some(k => k && t.includes(k.toLowerCase())))
    return { ref: c.ref, requirementIds: hits.map(r => r.id), reason: hits.length ? `Mentions ${hits.flatMap(r => r.keywords).filter(k => t.includes(k.toLowerCase())).slice(0, 3).join(', ')}.` : '' }
  }).filter(p => p.requirementIds.length).sort((a, b) => b.requirementIds.length - a.requirementIds.length).slice(0, 10)
  return { picks }
}

// Demo mode: keep every entry, rank bullets by keyword hits then score.
export function mockCompose(analysis, items, targetBullets, headlines = []) {
  const kws = analysis.requirements.flatMap(r => r.keywords).map(k => k.toLowerCase()).filter(Boolean)
  const hits = t => kws.filter(k => t.toLowerCase().includes(k)).length
  const rank = bs => [...bs].sort((a, b) => hits(b.text) - hits(a.text) || (b.score ?? 0) - (a.score ?? 0))
  const per = Math.max(2, Math.round(targetBullets / Math.max(1, items.filter(i => i.kind === 'experience').length)))
  const entries = items.filter(i => !['skills', 'summaries', 'education'].includes(i.kind)).flatMap(i => (i.roles.length ? i.roles.map(r => r.title) : ['']).map(role => ({
    itemRef: i.ref, roleTitle: role, bulletRefs: rank(i.bullets.filter(b => !role || !b.role || b.role === role)).slice(0, i.kind === 'experience' ? per : 2).map(b => b.ref),
  })))
  const skills = items.filter(i => i.kind === 'skills').flatMap(i => rank(i.bullets)).map(b => b.ref)
  const summary = items.find(i => i.kind === 'summaries')?.bullets[0]?.ref ?? ''
  return { summaryRef: summary, headline: headlines[0] ?? '', entries, skillRefs: skills, gaps: [] }
}

// Demo mode: no rewriting; relevant skill groups first.
export function mockTailor({ analysis, headlines, summaries, bullets, skills }) {
  const kws = analysis.requirements.flatMap(r => r.keywords).map(k => k.toLowerCase())
  const rel = g => g.items.filter(i => kws.some(k => i.toLowerCase().includes(k))).length
  return {
    headline: headlines[0] ?? analysis.title,
    summary: summaries[0] ?? '',
    bullets: bullets.map(b => ({ ref: b.ref, text: b.text })),
    skills: [...skills].sort((a, b) => rel(b) - rel(a)),
  }
}
