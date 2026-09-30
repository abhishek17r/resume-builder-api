# Offerstack AI server

The local AI server for [Offerstack](https://github.com/abhishek17r/resume-builder): job analysis, tailoring, scoring and vault tagging through **OpenAI** or **Anthropic (Claude)**. It runs on your machine next to the app and holds your API key; the browser never sees it.

Most people don't run this on its own: the [one-line installer](https://github.com/abhishek17r/resume-builder#quickstart) sets up both, and `npm run dev` in the app starts this server too.

## Run

```bash
npm install
cp .env.example .env   # add OPENAI_API_KEY or ANTHROPIC_API_KEY
npm run dev            # http://localhost:8787
```

**Choosing the AI.** The easiest way is the app's **Integrations** page: connect OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Ollama (local) or any OpenAI-compatible endpoint, test it and switch any time, with no restart. Those settings are saved in `.data/integrations.json` (git-ignored, readable only by your user); keys are never returned to the browser. Without a provider chosen there, the server falls back to `.env`: `AI_PROVIDER=openai|anthropic`, or whichever key is set. With no key the server starts in **demo mode**: endpoints return keyword-heuristic results with `"mock": true`, so the app works end to end for development.

## Endpoints

All return JSON; errors are `{ "error": { "code", "message" } }`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | – | `{ ok, mock, provider, model }` |
| POST | `/api/jd/analyze` | `{ jobDescription }` | `{ analysis }` — title, company, seniority, requirements (must/nice, keywords) |
| POST | `/api/jd/match` | `{ resume, analysis }` | `{ match }` — matchScore, per-requirement covered/partial/missing with evidence refs |
| POST | `/api/jd/suggest` | `{ resume, analysis, match }` | `{ suggestions }` — tracked-change edits (rewrite bullet/summary, add skill, move bullet up) |
| POST | `/api/improve` | `{ bullets: [{ ref, text, issue }] }` | `{ rewrites }` — fix or `already_fine` verdict per flagged bullet |
| POST | `/api/vault/tag` | `{ taxonomy, bullets: [{ ref, text, context }] }` | `{ tags }` — 1–3 tag ids per bullet from the taxonomy the frontend sends |
| POST | `/api/vault/match` | `{ analysis, coverage, candidates }` | `{ picks }` — vault bullets that evidence a job's requirements, by ref |
| POST | `/api/vault/suggest-tags` | `{ existing, jobs, bullets }` | `{ tags }` — new tag proposals backed by at least 2 bullets |
| POST | `/api/resume/compose` | `{ analysis, targetBullets, headlines, items }` | `{ composition }` — which vault roles, bullets, skills, summary and headline to use, by ref |
| GET | `/api/integrations` | – | `{ integrations, current }` — every provider preset with its saved model and a masked key hint; what's in use |
| PUT | `/api/integrations/:id` | `{ apiKey?, model?, baseURL? }` | save a provider (omit `apiKey` to keep the saved one) |
| POST | `/api/integrations/:id/test` | – | `{ ok, latencyMs, models, error? }` — lists the provider's models and makes one tiny call |
| POST | `/api/integrations/active` | `{ id \| null }` | use this provider (`null`: back to `.env` or demo mode) |
| DELETE | `/api/integrations/:id` | – | remove a provider and its key |
| POST | `/api/resume/tailor` | `{ analysis, headlines, summaries, roles, bullets, skills }` | `{ tailored }` — headline, summary, lightly edited bullets and skills; each edit passes the guards or the original is kept |

`resume` is the compact payload the frontend builds: sections → entries → numbered bullets. Every reference the model returns is checked against it before responding.

## Design notes

- **Providers** (`src/providers/`): OpenAI uses `chat.completions.parse` with a strict JSON-schema response format; Anthropic uses `messages.parse` with a Zod output format. Both take the same Zod schemas (`src/schemas.js`), prompts and checks — one structured call per endpoint, no chat.
- **Honesty rules** in every prompt: no invented facts or numbers; missing metrics become `[X]` placeholders.
- **Guards after the model** (`routes/optimize.js`): tailored bullets must keep every number, stay within ~20% of the length and keep most words; summary numbers must appear in the candidate's material; skills must be evidenced; every reference is checked. Anything that fails keeps the original text.
- **Prompt caching**: system prompts are byte-stable and the resume comes before the variable parts, so match → suggest on the same resume reuses the prefix (explicit breakpoints on Anthropic, automatic prefix caching on OpenAI). An in-memory LRU also skips identical repeat requests.
- **Limits**: 1 MB bodies, per-client rate limit (`RATE_LIMIT_PER_MIN`), CORS restricted to `ALLOWED_ORIGINS`.
- **Local only**: the server listens on `127.0.0.1` (set `HOST` to change that deliberately), and the integrations routes refuse requests that don't come from this computer.
- **OpenAI-compatible providers** use the OpenAI SDK with their base URL. If an endpoint rejects strict JSON-schema output, the call is retried asking for a JSON object that follows the schema, which is then validated.

## Test

```bash
npm test   # runs in demo mode, no key needed
```

## Licence

[AGPL-3.0](LICENSE) © Abhishek Ranjan. Contributions are accepted under the [CLA](https://github.com/abhishek17r/resume-builder/blob/main/CLA.md).
