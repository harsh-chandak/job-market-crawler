/**
 * Token ledger — one line per billed API response.
 *
 * llm.js has always captured input, cache-read, cache-write and output counts
 * and then thrown them away on the next call, so the only honest answer to
 * "what did today cost?" was an estimate. This appends them instead.
 *
 * Append-only JSONL rather than a table in Mongo: it is written from the hot
 * path of every model call, it must never fail the call it is measuring, and
 * the questions asked of it are all "sum this over a date range" — which `wc`,
 * `grep` and a twenty-line reader answer fine. A failed write is swallowed on
 * purpose. Losing a ledger line is a rounding error; losing a scored job
 * because the accountant threw is not.
 */
import { appendFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_PATH = process.env.TOKEN_LEDGER_PATH || resolve(ROOT, "logs/tokens.jsonl");

/**
 * USD per million tokens.
 *
 * Cache writes cost 1.25x input and cache reads 0.1x — that ratio is what makes
 * caching worth having, and folding it in here is the only way the ledger can
 * show whether it is actually paying off.
 *
 * Sonnet 5 is on introductory pricing through 2026-08-31, after which input
 * goes $2.00 -> $3.00 and output $10.00 -> $15.00. Both cards are here and the
 * date picks between them, so the ledger does not quietly under-report itself
 * by a third the morning the intro period ends.
 */
const INTRO_ENDS = Date.parse("2026-09-01T00:00:00Z");
const RATES = {
  "claude-sonnet-5": { intro: [2.0, 10.0], list: [3.0, 15.0] },
  "claude-sonnet-4-6": { list: [3.0, 15.0] },
  "claude-opus-5": { list: [5.0, 25.0] },
  "claude-opus-4-8": { list: [5.0, 25.0] },
  "claude-haiku-4-5": { list: [1.0, 5.0] },
};

/** Per-million rates for a model at a point in time, or null if not billed here. */
export function ratesFor(model, at = Date.now()) {
  const r = RATES[model];
  if (!r) return null;
  const [input, output] = r.intro && at < INTRO_ENDS ? r.intro : r.list;
  return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 };
}

/** USD for one response. Returns 0 for providers we are not billed for. */
export function costOf(model, usage = {}, at = Date.now()) {
  const r = ratesFor(model, at);
  if (!r) return 0;
  const m = (n, rate) => ((Number(n) || 0) / 1e6) * rate;
  return (
    m(usage.input, r.input) +
    m(usage.cacheWrite, r.cacheWrite) +
    m(usage.cacheRead, r.cacheRead) +
    m(usage.output, r.output)
  );
}

/**
 * Append one response to the ledger. Never throws.
 *
 * `at` and `path` are injectable so tests depend on neither the clock nor the
 * real ledger — without the latter, a test asserting that an unwritable path is
 * survivable writes its junk row into the file it was meant to leave alone.
 */
export async function record({ stage, provider, model, usage, ok = true, at = Date.now(), path = LEDGER_PATH }) {
  try {
    const u = usage || {};
    const row = {
      ts: new Date(at).toISOString(),
      stage: stage || "unknown",
      provider: provider || "unknown",
      model: model || "unknown",
      input: Number(u.input) || 0,
      cacheWrite: Number(u.cacheWrite) || 0,
      cacheRead: Number(u.cacheRead) || 0,
      output: Number(u.output) || 0,
      ok: Boolean(ok),
      // The subscription is not billed per token. The counts are still worth
      // keeping — they show what the plan is absorbing — but a dollar figure
      // here would overstate spend by exactly the amount the switch saves.
      usd: provider === "claude-code" ? 0 : Number(costOf(model, u, at).toFixed(6)),
    };
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await appendFile(path, `${JSON.stringify(row)}\n`);
    return row;
  } catch {
    return null;
  }
}

/** Read the ledger. A truncated final line is skipped, not fatal. */
export async function readLedger({ sinceDays = null, path = LEDGER_PATH } = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const cutoff = sinceDays == null ? null : Date.now() - sinceDays * 864e5;
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (cutoff != null && Date.parse(r.ts) < cutoff) continue;
    rows.push(r);
  }
  return rows;
}

const blank = () => ({ calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, usd: 0, failed: 0 });
const add = (acc, r) => {
  acc.calls++;
  acc.input += r.input;
  acc.cacheWrite += r.cacheWrite;
  acc.cacheRead += r.cacheRead;
  acc.output += r.output;
  acc.usd += r.usd;
  if (!r.ok) acc.failed++;
  return acc;
};

/**
 * Totals overall and grouped by day, stage and model.
 *
 * cacheHitRate is cache reads over everything that could have been a cache read
 * — reads plus writes plus uncached input. A prefix that is written every call
 * and never read is the silent failure mode of prompt caching, and it shows up
 * here as a rate near zero rather than as nothing at all.
 */
export function summarize(rows) {
  const total = blank();
  const byDay = {}, byStage = {}, byModel = {};
  for (const r of rows) {
    add(total, r);
    add((byDay[r.ts.slice(0, 10)] ??= blank()), r);
    add((byStage[r.stage] ??= blank()), r);
    add((byModel[r.model] ??= blank()), r);
  }
  const cacheable = total.cacheRead + total.cacheWrite + total.input;
  total.cacheHitRate = cacheable ? total.cacheRead / cacheable : 0;
  return { total, byDay, byStage, byModel };
}
