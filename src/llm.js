/**
 * Provider-agnostic LLM client.
 *
 * The model is a config line, not an architectural decision. Every stage runs
 * on Claude Fable 5.1 through Claude Code in headless mode, billed to the Max
 * plan, never the API key. The other providers remain for tests and benchmarks
 * and are reached only when LLM_PROVIDER names them.
 *
 *   claude-code  headless `claude -p` on the Max plan (default, claude-fable-5-1)
 *   stub      deterministic, no network — used by the test suite
 *   ollama    local, zero key, zero cost  (LLM_MODEL=qwen2.5-coder:3b)
 *   groq      free tier, OpenAI-compatible
 *   openai    any OpenAI-compatible endpoint (DeepSeek, Together, HF router)
 *   anthropic official SDK
 *
 * Every provider is asked for JSON and the result is schema-validated here, so
 * a weaker dev model cannot quietly corrupt downstream data — it fails loudly
 * instead. That property is what makes developing against a 3B local model
 * safe: the guardrails live in code, not in the prompt.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { getJson, postJson } from "./util/http.js";
import { sha256 } from "./util/normalize.js";

import { record as recordUsage } from "./ledger.js";

// "5m" or "1h". One hour by default: this pipeline's stable prefixes are the
// bullet catalogue and the system prompt, neither of which changes between
// runs, and its cycles are spaced far enough apart that a five-minute entry is
// usually cold by the time the next call arrives.
const CACHE_TTL = process.env.CACHE_TTL || "1h";

// Defaults match production, so a script that runs without .env still lands
// on Fable via the Max plan rather than on a local model or the API.
export const PROVIDER = process.env.LLM_PROVIDER || "claude-code";
export const MODEL = process.env.LLM_MODEL || "claude-fable-5-1";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

/* ------------------------------------------------------------ validation */

/**
 * Minimal structural validator. Not a full JSON-Schema implementation — just
 * enough to guarantee the fields downstream code reads actually exist and have
 * the right type, which is the entire point of validating model output.
 */
export function validate(value, schema, path = "$") {
  const errs = [];
  const t = schema.type;

  if (t === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [
        `${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`,
      ];
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errs.push(`${path}.${key}: missing required field`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value)
        errs.push(...validate(value[key], sub, `${path}.${key}`));
    }
    return errs;
  }

  if (t === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errs.push(
        `${path}: ${value.length} items exceeds max ${schema.maxItems}`,
      );
    }
    if (schema.items)
      value.forEach((v, i) =>
        errs.push(...validate(v, schema.items, `${path}[${i}]`)),
      );
    return errs;
  }

  if (t === "number" || t === "integer") {
    if (typeof value !== "number" || Number.isNaN(value))
      return [`${path}: expected number`];
    if (t === "integer" && !Number.isInteger(value))
      errs.push(`${path}: expected integer`);
    if (schema.minimum != null && value < schema.minimum)
      errs.push(`${path}: ${value} < min ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum)
      errs.push(`${path}: ${value} > max ${schema.maximum}`);
    return errs;
  }

  if (t === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.enum && !schema.enum.includes(value)) {
      errs.push(`${path}: "${value}" not in [${schema.enum.join(", ")}]`);
    }
    return errs;
  }

  if (t === "boolean" && typeof value !== "boolean")
    return [`${path}: expected boolean`];
  return errs;
}

/** Models wrap JSON in prose or fences no matter how firmly you ask them not to. */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  try {
    return JSON.parse(body.trim());
  } catch {
    // fall back to the outermost balanced {...}
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Render the schema into the prompt. Describing it in prose is not enough for
 * smaller models: qwen2.5-coder:3b returned the right KEYS with wrong types
 * ("fit": "High", "family": "Software Engineer") until the literal shape and
 * the allowed enum values were shown.
 */
export function schemaHint(schema, indent = 0) {
  const pad = " ".repeat(indent);
  if (schema.type === "object") {
    const lines = Object.entries(schema.properties || {}).map(([k, v]) => {
      const req = (schema.required || []).includes(k) ? "" : "   // optional";
      return `${pad}  "${k}": ${schemaHint(v, indent + 2)}${req}`;
    });
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }
  if (schema.type === "array") {
    const max = schema.maxItems ? ` (max ${schema.maxItems})` : "";
    return `[${schemaHint(schema.items || { type: "string" }, indent)}]${max}`;
  }
  if (schema.enum) return `<one of: ${schema.enum.map((e) => JSON.stringify(e)).join(" | ")}>`;
  if (schema.type === "integer") {
    const r = schema.minimum != null ? ` ${schema.minimum}-${schema.maximum}` : "";
    return `<integer${r}, NOT a string>`;
  }
  if (schema.type === "number") return "<number>";
  if (schema.type === "boolean") return "<true|false>";
  return "<string>";
}

/**
 * Conservative normalisation of near-miss values. Only reshapes what the model
 * already said — never substitutes a value it did not produce. A numeric string
 * becomes a number; an enum value is matched case-insensitively and by prefix.
 * Anything it cannot resolve is left alone so validation still rejects it.
 */
export function coerce(value, schema) {
  if (!schema) return value;

  if (schema.type === "object" && value && typeof value === "object") {
    const out = { ...value };
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in out) out[k] = coerce(out[k], sub);
    }
    return out;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return typeof value === "string" && value ? [value] : value;
    const arr = value.map((v) => coerce(v, schema.items));
    return schema.maxItems ? arr.slice(0, schema.maxItems) : arr;
  }

  if ((schema.type === "integer" || schema.type === "number") && typeof value === "string") {
    // Only accept a string that actually IS a number. Stripping non-digits from
    // "High" leaves "", and Number("") is 0 — which would silently invent a
    // score of zero. Leave it unchanged so validation rejects it and the retry
    // gets a chance to fix it properly.
    const cleaned = value.trim().replace(/[^0-9.-]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return value;
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return value;
    return schema.type === "integer" ? Math.round(n) : n;
  }

  if (schema.enum && typeof value === "string") {
    const v = value.trim().toLowerCase();
    const exact = schema.enum.find((e) => String(e).toLowerCase() === v);
    if (exact) return exact;
    const prefix = schema.enum.find((e) => v.startsWith(String(e).toLowerCase()) || String(e).toLowerCase().startsWith(v));
    if (prefix) return prefix;
  }

  return value;
}

/* ------------------------------------------------------------- providers */

async function callOllama({ system, user, model, maxTokens }) {
  const res = await postJson(
    `${OLLAMA_HOST}/api/chat`,
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      format: "json",
      stream: false,
      options: {
        temperature: 0,
        num_predict: maxTokens,
        // Ollama defaults num_ctx to 2048. A long job description then pushes
        // the schema instructions (which sit at the END of the prompt) out of
        // the window, and the model returns a plausible-looking object missing
        // every required field. This is the single most confusing failure mode
        // when developing against a local model — it looks like the model is
        // too weak when it simply never saw the instruction.
        num_ctx: Number(process.env.OLLAMA_NUM_CTX || 8192),
      },
    },
    { timeout: Number(process.env.LLM_TIMEOUT_MS || 120_000) },
  );
  if (res.status !== "ok")
    throw new Error(`ollama: ${res.error || res.httpStatus}`);
  return res.data?.message?.content ?? "";
}

async function callOpenAiCompatible({
  system,
  user,
  model,
  maxTokens,
  baseUrl,
  apiKey,
}) {
  const res = await postJson(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    },
    {
      timeout: Number(process.env.LLM_TIMEOUT_MS || 120_000),
      headers: { authorization: `Bearer ${apiKey}` },
    },
  );
  if (res.status !== "ok") {
    const err = new Error(`${baseUrl}: ${res.error || res.httpStatus}`);
    // Hosted free tiers are tokens-per-minute capped. A 429 is not a failure,
    // it is a "wait" — surface it so the retry loop can honour retry-after
    // instead of burning an attempt immediately and reporting the job as errored.
    err.httpStatus = res.httpStatus;
    err.retryAfterMs = res.retryAfterMs ?? null;
    throw err;
  }
  return res.data?.choices?.[0]?.message?.content ?? "";
}

/**
 * Resolve the Anthropic key from the project's .env ahead of the environment.
 *
 * dotenv deliberately does not override a variable the shell already exported,
 * and that default is wrong here. A terminal that happens to carry its own
 * ANTHROPIC_API_KEY — an agent harness, a sourced profile, a CI runner — wins over
 * the project's own configuration, so every call bills a key the project never
 * chose. That is not hypothetical: it silently sent this pipeline's traffic to an
 * unrelated key with no credits while the configured key sat unused with $30 on
 * it, and the only symptom was a billing error naming an account the user had just
 * topped up.
 *
 * The file is the configuration. Read relative to this module so the answer does
 * not depend on the working directory the launcher happened to start in.
 */
let envFileKey;
function anthropicKey(explicit) {
  if (explicit) return explicit;
  if (envFileKey === undefined) {
    try {
      const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
      envFileKey = (/^ANTHROPIC_API_KEY=(.*)$/m.exec(text)?.[1] || "").trim() || null;
    } catch {
      envFileKey = null;
    }
    const ambient = process.env.ANTHROPIC_API_KEY;
    if (envFileKey && ambient && ambient !== envFileKey) {
      // Say that they differ, not what either one is. A key fragment in a log
      // is a key fragment in every log that copies it.
      console.warn(
        "  ⚠ ANTHROPIC_API_KEY: this shell exports a different key than .env. " +
          "Using .env, which is the project's configuration.",
      );
    }
  }
  return envFileKey || process.env.ANTHROPIC_API_KEY || null;
}

/**
 * Strip the JSON Schema keywords structured outputs does not accept.
 *
 * The API rejects the whole request rather than ignoring an unknown constraint:
 * a single `maxItems` returns a 400 and the resume is lost. Our own coerce()
 * still enforces these bounds after the fact, so dropping them here costs
 * nothing — the constraint moves from the request to the response check.
 *
 * Also sets additionalProperties:false on every nested object, which the API
 * requires and which is easy to set only at the top level and think it is done.
 */
const UNSUPPORTED = new Set([
  "maxItems",
  "minItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "default",
]);

export function toStructuredSchema(node) {
  if (Array.isArray(node)) return node.map(toStructuredSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED.has(k)) continue;
    out[k] = toStructuredSchema(v);
  }
  if (out.type === "object") {
    out.additionalProperties = false;
    // Structured outputs requires every declared property to be required.
    if (out.properties) out.required = Object.keys(out.properties);
  }
  return out;
}

/**
 * Anthropic, with prompt caching on the stable prefix.
 *
 * Caching is a prefix match, so it only pays off if the unchanging part of the
 * prompt comes FIRST. Two breakpoints are set here: one after the system prompt,
 * one after the leading `cachePrefix` the caller supplies. For tailoring that
 * prefix is the 40-bullet catalogue — about 2,500 tokens that are byte-identical
 * on every call in a run. Cache reads bill at a tenth of the input rate, so the
 * catalogue costs ~250 tokens instead of ~2,500 after the first call.
 *
 * The write itself costs 1.25x, so a single isolated call is slightly more
 * expensive. Break-even is the second call, and this pipeline never makes one
 * call in isolation.
 */
/* ---------------------------------------------------------- claude code */

/**
 * Claude Code in headless mode, billed to the Max subscription instead of per
 * token.
 *
 * Three details decide whether this actually uses the subscription. Each came
 * from reading `claude --help`, not from assuming:
 *
 *  - ANTHROPIC_API_KEY is removed from the child's environment. Claude Code
 *    prefers an API key over the OAuth login whenever one is present, and dotenv
 *    loads the key from .env for the rest of this pipeline — so leaving it in
 *    would quietly bill the very key this provider exists to stop using.
 *  - --safe-mode, not --bare. --bare looks like the minimal flag, but it makes
 *    auth "strictly ANTHROPIC_API_KEY ... OAuth and keychain are never read":
 *    the subscription cannot be used at all. --safe-mode drops CLAUDE.md, hooks,
 *    skills, plugins and MCP servers and leaves auth alone.
 *  - --system-prompt replaces Claude Code's own coding-agent prompt and
 *    --tools "" removes every tool, so a scoring call is one model turn with no
 *    way to read the filesystem.
 *
 * Runs in an empty directory so no project file can be picked up as context,
 * and with --no-session-persistence so hundreds of scoring calls do not fill
 * the user's session history.
 */
let claudeCodePausedUntil = 0;
let claudeCodePauseReason = null;

/** Tests only: clear a pause set by an earlier simulated failure. */
export function resetClaudeCodePause() {
  claudeCodePausedUntil = 0;
  claudeCodePauseReason = null;
}

export function claudeCodeStatus() {
  return {
    paused: Date.now() < claudeCodePausedUntil,
    until: claudeCodePausedUntil ? new Date(claudeCodePausedUntil) : null,
    reason: claudeCodePauseReason,
  };
}

async function callClaudeCode({ stage, system, user, model, schema, effort }) {
  // A logged-out CLI or an exhausted plan fails every call identically. Without
  // this, each of eight jobs a cycle burns three retries on an error that cannot
  // change, and the log fills with the same line.
  if (Date.now() < claudeCodePausedUntil) {
    throw new Error(`claude-code: paused until ${new Date(claudeCodePausedUntil).toLocaleTimeString()} (${claudeCodePauseReason})`);
  }

  const { spawn } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const cwd = join(tmpdir(), "job-hunt-claude-code");
  mkdirSync(cwd, { recursive: true });

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const bin = process.env.CLAUDE_CODE_BIN || "claude";
  const args = [
    "-p",
    "--safe-mode",
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "",
    "--model", model,
    // Per-stage override first. Scoring is ~8 bounded calls a cycle and medium
    // is plenty; bullet selection is one call per resume and is where extra
    // reasoning changes what a recruiter reads. On the Max plan effort costs
    // usage-limit headroom, not dollars, so spend it where it shows.
    "--effort",
    effort ||
      (stage && process.env[`CLAUDE_CODE_EFFORT_${String(stage).toUpperCase()}`]) ||
      process.env.CLAUDE_CODE_EFFORT ||
      "medium",
    "--system-prompt", system,
  ];
  if (schema) args.push("--json-schema", JSON.stringify(toStructuredSchema(schema)));

  const timeoutMs = Number(process.env.CLAUDE_CODE_TIMEOUT_MS || 180_000);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude-code: timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude-code: ${e.message}`)); });
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    // The prompt goes in on stdin: the bullet catalogue alone is ~2,600 tokens,
    // and argv is the wrong place for a payload that size.
    child.stdin.end(user);
  });

  let d;
  try {
    d = JSON.parse(out.stdout);
  } catch {
    throw new Error(`claude-code: unparseable output: ${(out.stderr || out.stdout).slice(0, 200)}`);
  }

  const usage = d.usage || {};
  // modelUsage lists every model the CLI called, and it makes a small call of
  // its own on Haiku next to the real one. Taking the first key logged real
  // Fable calls as Haiku. Record the requested model when it answered, else
  // whichever did the most work.
  const mu = d.modelUsage || {};
  const want = String(model).toLowerCase();
  const tokensOf = (k) => {
    const u = mu[k] || {};
    return (u.inputTokens || 0) + (u.cacheCreationInputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.outputTokens || 0);
  };
  const requested = Object.keys(mu).find(
    (k) => k.toLowerCase().includes(want) || String(mu[k]?.canonicalModel || "").toLowerCase().includes(want),
  );
  const heaviest = Object.keys(mu).sort((a, b) => tokensOf(b) - tokensOf(a))[0];
  const modelUsed = requested || heaviest || model;
  // The requested model has to be the one that answered. When it is absent the
  // CLI switched models (a model-specific usage cap does that), and a weaker
  // model's judgement must not pass for the one the pipeline asked for.
  const switched = Object.keys(mu).length > 0 && !requested;
  await recordUsage({
    stage,
    provider: "claude-code",
    model: modelUsed,
    usage: {
      input: usage.input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      output: usage.output_tokens,
    },
    ok: !d.is_error && !switched,
  });

  if (d.is_error) {
    const msg = String(d.result || d.subtype || "error");
    if (/authenticat|oauth|log ?in|not logged|credential/i.test(msg)) {
      claudeCodePausedUntil = Date.now() + 15 * 60_000;
      claudeCodePauseReason = "not logged in — run: claude auth login";
    } else if (/usage limit|session limit|weekly limit|hit your .*limit|limit reached|quota|rate.?limit/i.test(msg)) {
      claudeCodePausedUntil = Date.now() + 30 * 60_000;
      claudeCodePauseReason = "Max plan usage limit reached";
    }
    throw new Error(`claude-code: ${msg.slice(0, 200)}`);
  }

  if (switched) {
    claudeCodePausedUntil = Date.now() + 30 * 60_000;
    claudeCodePauseReason = `${model} did not answer (got ${Object.keys(mu).join(", ")}), likely its usage limit`;
    throw new Error(`claude-code: answered by ${Object.keys(mu).join(", ")}, not ${model}`);
  }

  if (d.structured_output != null) return JSON.stringify(d.structured_output);
  return String(d.result ?? "");
}

async function callAnthropic({
  system,
  user,
  model,
  maxTokens,
  cachePrefix,
  apiKey,
  schema,
  effort,
  thinking,
  thinkingDisabled,
  stage,
}) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // An explicit key lets a caller verify the key the launchers will actually
  // use, rather than whatever the surrounding shell happens to export.
  const key = anthropicKey(apiKey);
  const client = new Anthropic(key ? { apiKey: key } : {});

  // A prefix under the model minimum silently will not cache, so don't ask.
  const CACHE_MIN_CHARS = 4000; // ~1,100 tokens, over Sonnet's 1,024 floor
  const cacheable = cachePrefix && cachePrefix.length >= CACHE_MIN_CHARS;

  // Structured outputs constrain the response to the schema, so "model did not
  // return parseable JSON" stops being a possible outcome. Without it a verbose
  // rationale can run into max_tokens and the reply is cut mid-object — which is
  // exactly how the first paid run lost a resume.
  const outputConfig = {
    ...(schema
      ? { format: { type: "json_schema", schema: toStructuredSchema(schema) } }
      : {}),
    ...(effort ? { effort } : {}),
  };

  // Thinking is ON BY DEFAULT on Sonnet 5, and thinking tokens bill as output.
  // For a task that is pure selection — pick N ids from a fixed list — that is
  // roughly 1,200 tokens of reasoning per call on top of ~200 tokens of actual
  // JSON, and output is the largest line item in this pipeline's bill. Callers
  // that do not need deliberation can turn it off. Note `disabled` is only
  // accepted at effort `high` or below.
  const thinkingCfg = thinkingDisabled
    ? { type: "disabled" }
    : thinking
      ? thinking
      : undefined;

  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
    // A one-hour TTL, not the five-minute default.
    //
    // The scoring timer is SCORE_CYCLE_SECONDS=300 — exactly the default TTL —
    // so the catalogue expired at the moment the next cycle wanted it and the
    // measured hit rate sat at 35%. A 1h write costs 2x input instead of 1.25x
    // and is paid once; every call after it reads at 0.1x. The catalogue is
    // byte-identical across calls, so there is nothing to invalidate it.
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral", ttl: CACHE_TTL } },
    ],
    messages: [
      {
        role: "user",
        content: cacheable
          ? [
              {
                type: "text",
                text: cachePrefix,
                cache_control: { type: "ephemeral", ttl: CACHE_TTL },
              },
              { type: "text", text: user },
            ]
          : [{ type: "text", text: cachePrefix ? cachePrefix + user : user }],
      },
    ],
  });
  // Surface cache effectiveness. A cache that silently never reads is the whole
  // failure mode of prompt caching, and it is invisible without this.
  lastAnthropicUsage = {
    stopReason: msg.stop_reason,
    input: msg.usage?.input_tokens ?? 0,
    cacheWrite: msg.usage?.cache_creation_input_tokens ?? 0,
    cacheRead: msg.usage?.cache_read_input_tokens ?? 0,
    output: msg.usage?.output_tokens ?? 0,
  };

  // Ledger here, at the response, and before the refusal check. This is the
  // billing event: a refusal is generated and charged like any other reply, and
  // so is a response that fails schema validation upstream and sends the caller
  // round the retry loop. Recording at the successful return instead would omit
  // precisely the calls worth knowing about. Never throws — see ledger.js.
  await recordUsage({
    stage,
    provider: "anthropic",
    model,
    usage: lastAnthropicUsage,
    ok: msg.stop_reason !== "refusal",
  });

  if (msg.stop_reason === "refusal") throw new Error("anthropic: refusal");

  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Usage from the most recent Anthropic call, for cost reporting. */
export let lastAnthropicUsage = null;

/**
 * Deterministic offline provider. Returns a value derived from the input hash so
 * tests are reproducible and the pipeline can be exercised with no network.
 */
function callStub({ user, stubFactory }) {
  const seed = parseInt(sha256(user).slice(0, 8), 16);
  return JSON.stringify(stubFactory ? stubFactory(seed, user) : { seed });
}

/* ----------------------------------------------------------------- entry */

/**
 * Run `complete`, falling back to a second provider when the first is
 * rate-limited or unavailable.
 *
 * A free hosted tier will hit its quota — that is a normal operating state, not
 * an incident. Without a fallback the whole pipeline stops until the window
 * resets (observed: a 2243s retry-after mid-run). The local model is slower and
 * scores less sharply, but a usable answer now beats a better answer in 37
 * minutes for a pipeline whose entire value is freshness.
 */
export async function completeWithFallback(opts = {}) {
  try {
    return await complete(opts);
  } catch (err) {
    const fb = process.env.LLM_FALLBACK_PROVIDER;
    if (!fb || opts.provider === fb) throw err;
    const transient = /rate-limit|429|timeout|exhausted|budget/i.test(String(err?.message || ""));
    if (!transient) throw err;
    const res = await complete({
      ...opts,
      provider: fb,
      model: process.env.LLM_FALLBACK_MODEL || MODEL,
    });
    return { ...res, fellBackFrom: opts.provider || PROVIDER, fallbackReason: String(err.message).slice(0, 120) };
  }
}

export async function complete({
  system,
  user,
  schema,
  // The unchanging leading part of the user message. Providers that support
  // prompt caching cache up to here; the others just concatenate it, so callers
  // can pass it unconditionally.
  cachePrefix = null,
  apiKey = null,
  // Anthropic-only knobs. Ignored by the other providers.
  effort = null,
  thinking = null,
  thinkingDisabled = false,
  provider = PROVIDER,
  model = MODEL,
  maxTokens = 2048,
  retries = 2,
  // Which pipeline step this call belongs to, for the token ledger. Free-form;
  // "score" and "tailor" are the two that exist today.
  stage = "unknown",
  stubFactory,
}) {
  // Bound the whole call. Retry-after backoff is correct behaviour, but an
  // unbounded one means a rate-limited provider can hang a pipeline stage
  // indefinitely — which is exactly what a competing batch job caused: the
  // tailor step sat behind another script's 429s with no way to fail fast.
  const deadline = Date.now() + Number(process.env.LLM_MAX_WAIT_MS || 180_000);
  let lastErr = null;
  if (schema) {
    user = `${user}\n\nReturn ONLY this JSON shape, with exactly these types:\n${schemaHint(schema)}`;
  }

  // Only the Anthropic path can cache a prefix. Every other provider must still
  // SEE that content — for tailoring it is the bullet catalogue, without which
  // the selector has nothing to select from — so fold it into the user message.
  // Getting this wrong would not error; it would silently return zero bullets.
  const flatUser = cachePrefix ? cachePrefix + user : user;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let raw;
    try {
      switch (provider) {
        case "stub":
          raw = callStub({ user: flatUser, stubFactory });
          break;
        case "ollama":
          raw = await callOllama({
            system,
            user: flatUser,
            model,
            maxTokens,
          });
          break;
        case "groq":
          raw = await callOpenAiCompatible({
            system,
            user: flatUser,
            model,
            maxTokens,
            baseUrl: "https://api.groq.com/openai/v1",
            apiKey: process.env.GROQ_API_KEY,
          });
          break;
        case "openai":
          raw = await callOpenAiCompatible({
            system,
            user: flatUser,
            model,
            maxTokens,
            baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
            apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
          });
          break;
        case "claude-code":
          raw = await callClaudeCode({
            stage,
            system,
            // No prefix cache to split on; the catalogue has to be in the prompt.
            user: flatUser,
            model,
            schema,
            effort,
          });
          break;
        case "anthropic":
          raw = await callAnthropic({
            stage,
            system,
            user,
            model,
            maxTokens,
            cachePrefix,
            apiKey,
            schema,
            effort,
            thinking,
            thinkingDisabled,
          });
          break;
        default:
          throw new Error(`unknown provider: ${provider}`);
      }
    } catch (err) {
      lastErr = err;
      if (Date.now() > deadline) {
        throw new Error(`llm: exceeded LLM_MAX_WAIT_MS while retrying (${err?.message || err})`);
      }
      if (err?.httpStatus === 429 && attempt < retries) {
        // Respect the server's own hint when present; otherwise exponential.
        //
        // Clamp to the remaining budget. Groq answers a TPM overage with a
        // retry-after of minutes, and sleeping it whole blows straight past the
        // deadline — the check above only runs after the sleep returns, so an
        // unclamped wait makes LLM_MAX_WAIT_MS decorative. That is what made a
        // 90s-bounded tailor call hang for ten minutes.
        const remaining = deadline - Date.now();
        const want = err.retryAfterMs ?? Math.min(30_000, 2_000 * 2 ** attempt);
        if (want > remaining) {
          throw new Error(
            `llm: rate-limited, retry-after ${Math.round(want / 1000)}s exceeds remaining budget ${Math.round(remaining / 1000)}s`,
          );
        }
        await new Promise((r) => setTimeout(r, want));
      }
      continue;
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      lastErr = new Error("model did not return parseable JSON");
      continue;
    }

    const coerced = schema ? coerce(parsed, schema) : parsed;

    if (schema) {
      const errs = validate(coerced, schema);
      if (errs.length) {
        // Feed the failure back — small models usually fix it on the retry.
        lastErr = new Error(`schema violation: ${errs.slice(0, 3).join("; ")}`);
        user = `${user}\n\nYour previous reply was rejected: ${errs.slice(0, 3).join("; ")}\nReturn corrected JSON only.`;
        continue;
      }
    }

    return { data: coerced, provider, model, attempts: attempt + 1 };
  }

  throw lastErr || new Error("llm: exhausted retries");
}

export function describeProvider() {
  const key = {
    groq: "GROQ_API_KEY",
    openai: "LLM_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  }[PROVIDER];
  const has = key ? Boolean(process.env[key]) : true;
  return {
    provider: PROVIDER,
    model: MODEL,
    needsKey: key || null,
    keyPresent: has,
  };
}
