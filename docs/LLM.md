# LLM layer — providers, and why the guardrails are in code

## No API key is required to develop this

`LLM_PROVIDER` selects the backend. Everything below works today:

| Provider | Key | Notes |
|---|---|---|
| `stub` | none | Deterministic, offline. The whole test suite runs on this. |
| `ollama` | **none** | Local. Current default (`qwen2.5-coder:3b`). Zero cost. |
| `groq` | free key | OpenAI-compatible. Best free option for real quality. |
| `openai` | key | Generic OpenAI-compatible base URL — covers DeepSeek, Together, HF router. |
| `anthropic` | key | Official SDK. Recommended for production tailoring. |

```bash
LLM_PROVIDER=ollama LLM_MODEL=qwen2.5-coder:3b npm run score      # today, no key
LLM_PROVIDER=groq   LLM_MODEL=llama-3.3-70b-versatile npm run score
LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-5 npm run tailor
```

## Why a weak model is safe here

The model **never writes resume text**. It returns bullet IDs; `renderResume`
looks each one up in `resume/bullets.yaml` and emits the approved string
verbatim. A hallucinated ID simply does not resolve and is dropped, and
`verifyNoFabrication` then asserts every rendered line exists in the bank.

So fabrication is structurally impossible rather than merely discouraged. That
matters more than usual here: inventing an employer, a date or a metric on a job
application is a real problem, and worse during a visa process.

Scoring output is schema-validated on the way in, so a weak model fails loudly
instead of writing garbage into the database.

## Three failure modes found while building against a 3B local model

**Ollama's default context is 2048 tokens.** A long job description pushes the
schema instructions — which sit at the end of the prompt — out of the window.
The model then returns a plausible object missing every required field, and it
looks like the model is too weak when it simply never saw the instruction. Fixed
with an explicit `num_ctx`.

**Describing a schema in prose is not enough.** qwen2.5-coder:3b returned the
right keys with wrong types (`"fit": "High"`, `"family": "Software Engineer"`)
until `schemaHint()` rendered the literal shape and the allowed enum values into
the prompt.

**Coercion can itself fabricate.** The first version stripped non-digits before
`Number()`, so `"High"` became `""` became **0** — silently inventing a score of
zero. Coercion now only accepts a string that genuinely is a number and
otherwise passes the value through so validation rejects it. There is a
regression test for this.

## Model quality, honestly

On `qwen2.5-coder:3b` the pipeline runs end-to-end but the *judgement* is weak:
scores cluster at 80-85, nearly everything is classified `swe`, and reasons are
generic. It proves the plumbing, not the ranking.

For usable scoring, either pull a larger local model (`qwen2.5:7b`,
`llama3.1:8b`) or use a Groq free key. Reserve Claude for tailoring, where
judgement about which bullets to foreground actually pays for itself.
