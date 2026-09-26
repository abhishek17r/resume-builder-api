# resume-builder-api

Backend for [resume-builder](../resume-builder): resume optimisation and job-description tailoring through **OpenAI** or **Anthropic (Claude)**. The frontend never sees the API key.

## Run

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY or ANTHROPIC_API_KEY
npm run dev            # http://localhost:8787
```

Pick the provider with `AI_PROVIDER=openai|anthropic`, or leave it empty to use whichever key is set. With no key the server starts in **demo mode**: endpoints return keyword-heuristic results with `"mock": true`, so the app works end to end for development.

## Endpoints

All return JSON; errors are `{ "error": { "code", "message" } }`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | – | `{ ok, mock, provider, model }` |
| POST | `/api/jd/analyze` | `{ jobDescription }` | `{ analysis }` — title, company, seniority, requirements (must/nice, keywords) |
| POST | `/api/jd/match` | `{ resume, analysis }` | `{ match }` — matchScore, per-requirement covered/partial/missing with evidence refs |
| POST | `/api/jd/suggest` | `{ resume, analysis, match }` | `{ suggestions }` — tracked-change edits (rewrite bullet/summary, add skill, move bullet up) |
| POST | `/api/improve` | `{ bullets: [{ ref, text, issue }] }` | `{ rewrites }` — fixes for bullets flagged by the quality checks |

`resume` is the compact payload the frontend builds: sections → entries → numbered bullets. Every reference the model returns is checked against it before responding.

## Design notes

- **Providers** (`src/providers/`): OpenAI uses `chat.completions.parse` with a strict JSON-schema response format; Anthropic uses `messages.parse` with a Zod output format. Both take the same Zod schemas (`src/schemas.js`), prompts and checks — one structured call per endpoint, no chat.
- **Honesty rules** in every prompt: no invented facts or numbers; missing metrics become `[X]` placeholders.
- **Prompt caching**: system prompts are byte-stable and the resume comes before the variable parts, so match → suggest on the same resume reuses the prefix (explicit breakpoints on Anthropic, automatic prefix caching on OpenAI). An in-memory LRU also skips identical repeat requests.
- **Limits**: 1 MB bodies, per-client rate limit (`RATE_LIMIT_PER_MIN`), CORS restricted to `ALLOWED_ORIGINS`.

## Test

```bash
npm test   # runs in demo mode, no key needed
```
