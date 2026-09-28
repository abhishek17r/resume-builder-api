import { z } from 'zod'

// ---------- request payloads (validated before anything reaches the model) ----------

// A bullet/paragraph inside an entry's description, addressed by its position.
const Bullet = z.object({ i: z.number().int().min(0), text: z.string().max(2000) })

const Entry = z.object({
  id: z.string().max(64),
  title: z.string().max(300).default(''),
  subtitle: z.string().max(300).default(''),
  dates: z.string().max(80).default(''),
  location: z.string().max(120).default(''),
  bullets: z.array(Bullet).max(40).default([]),
})

const Section = z.object({
  id: z.string().max(64),
  type: z.string().max(40),
  heading: z.string().max(120),
  entries: z.array(Entry).max(60),
})

export const ResumePayload = z.object({
  name: z.string().max(200).default(''),
  title: z.string().max(300).default(''),
  sections: z.array(Section).max(30),
})

export const AnalyzeRequest = z.object({
  jobDescription: z.string().trim().min(80, 'Paste the full job description (at least a few sentences).').max(30000),
})

// ---------- model outputs (structured outputs: every field required, nullable instead of optional) ----------

export const JobAnalysis = z.object({
  title: z.string().describe('Job title as written in the posting'),
  company: z.string().describe('Hiring company, or empty string if not stated'),
  seniority: z.enum(['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'executive', 'unknown']),
  summary: z.string().describe('One or two sentences on what the role is about'),
  requirements: z.array(z.object({
    id: z.string().describe('Short stable id like r1, r2, …'),
    text: z.string().describe('The requirement in plain words'),
    category: z.enum(['skill', 'tool', 'experience', 'domain', 'education', 'leadership', 'soft']),
    importance: z.enum(['must', 'nice']),
    keywords: z.array(z.string()).describe('Exact terms an ATS would search for'),
  })),
})

export const MatchRequest = z.object({ resume: ResumePayload, analysis: JobAnalysis })

export const MatchResult = z.object({
  matchScore: z.number().describe('0-100 fit of this resume for this job'),
  requirements: z.array(z.object({
    id: z.string().describe('The requirement id from the analysis'),
    status: z.enum(['covered', 'partial', 'missing']),
    evidence: z.array(z.object({
      sectionId: z.string(),
      entryId: z.string(),
      bullet: z.number().int().describe('Bullet index, or -1 for the entry as a whole'),
    })),
    note: z.string().describe('Why, in one short sentence'),
  })),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
})

export const SuggestRequest = z.object({ resume: ResumePayload, analysis: JobAnalysis, match: MatchResult })

export const Suggestions = z.object({
  suggestions: z.array(z.object({
    id: z.string(),
    kind: z.enum(['rewrite_bullet', 'rewrite_summary', 'add_skill', 'move_bullet_up']),
    target: z.object({
      sectionId: z.string(),
      entryId: z.string(),
      bullet: z.number().int().describe('Bullet index; -1 when not about a single bullet'),
    }),
    before: z.string().describe('Current text (empty for add_skill)'),
    after: z.string().describe('Proposed text; use [X] placeholders for any number the resume does not state'),
    reason: z.string(),
    requirementIds: z.array(z.string()),
  })),
})

export const ImproveRequest = z.object({
  context: z.object({ title: z.string().max(300).default(''), targetRole: z.string().max(300).default('') }).default({ title: '', targetRole: '' }),
  bullets: z.array(z.object({
    ref: z.string().max(200),
    text: z.string().min(1).max(2000),
    issue: z.string().max(200),
  })).min(1).max(20),
})

export const Rewrites = z.object({
  rewrites: z.array(z.object({
    ref: z.string(),
    verdict: z.enum(['rewritten', 'already_fine']).describe('already_fine when the flagged issue is not actually present'),
    after: z.string().describe('Rewritten bullet (or the original, unchanged, when already_fine); [X] placeholders for unknown numbers'),
    reason: z.string().describe('For rewritten: what changed and how it fixes the issue. For already_fine: why the issue does not apply.'),
  })),
})

// ---------- vault tagging ----------
export const TagRequest = z.object({
  taxonomy: z.array(z.object({ id: z.string().max(40), label: z.string().max(80), description: z.string().max(400) })).min(1).max(30),
  bullets: z.array(z.object({
    ref: z.string().max(100),
    text: z.string().min(1).max(1500),
    context: z.string().max(200).default(''),
  })).min(1).max(60),
})

export const TagResult = z.object({
  tags: z.array(z.object({
    ref: z.string(),
    tagIds: z.array(z.string()).describe('1-3 tag ids from the taxonomy, most relevant first; empty if none fit'),
  })),
})

// Pick vault bullets (already written by the user) that would strengthen a resume for a job.
export const VaultMatchRequest = z.object({
  analysis: JobAnalysis,
  coverage: z.array(z.object({ id: z.string().max(40), status: z.enum(['covered', 'partial', 'missing']) })).max(60).default([]),
  candidates: z.array(z.object({
    ref: z.string().max(100),
    text: z.string().min(1).max(1500),
    context: z.string().max(200).default(''),
  })).min(1).max(80),
})

export const VaultPicks = z.object({
  picks: z.array(z.object({
    ref: z.string(),
    requirementIds: z.array(z.string()).describe('Requirement ids this bullet gives evidence for'),
    reason: z.string().describe('One short sentence: what this bullet proves for the job'),
  })).describe('At most 10, most useful first; only bullets that genuinely help'),
})

// Build a resume for a job from the vault: the model only chooses and orders existing content by ref.
export const ComposeRequest = z.object({
  analysis: JobAnalysis,
  targetBullets: z.number().int().min(6).max(60).default(18),
  headlines: z.array(z.string().max(300)).max(20).default([]),
  items: z.array(z.object({
    ref: z.string().max(100),
    kind: z.string().max(40),
    title: z.string().max(300),
    subtitle: z.string().max(300).default(''),
    roles: z.array(z.object({ title: z.string().max(300), dates: z.string().max(80).default('') })).max(20).default([]),
    dates: z.string().max(80).default(''),
    bullets: z.array(z.object({
      ref: z.string().max(100),
      text: z.string().min(1).max(3000),
      role: z.string().max(300).default(''),
      score: z.number().min(0).max(100).optional(),
    })).max(200),
  })).min(1).max(200),
})

export const Composition = z.object({
  summaryRef: z.string().describe('Ref of the best-fitting summary bullet, or empty string if none fits'),
  headline: z.string().describe('The best-fitting headline, copied exactly from the headlines list, or empty string'),
  entries: z.array(z.object({
    itemRef: z.string(),
    roleTitle: z.string().describe('For companies: which role (exact title from roles); empty otherwise'),
    bulletRefs: z.array(z.string()).describe('Chosen bullet refs for this entry, most relevant first'),
  })).describe('Entries to include, in the order they should appear within their kind'),
  skillRefs: z.array(z.string()).describe('Skill bullet refs to include, most relevant first'),
  gaps: z.array(z.string()).describe('Must-have requirements with no evidence anywhere in the vault, in a few words each'),
})
