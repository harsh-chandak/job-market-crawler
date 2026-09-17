#!/usr/bin/env node
/**
 * What the pipeline actually spent. node scripts/tokens.mjs [--days N]
 *
 * Reads the ledger only — no database, no network, no model.
 */
import "dotenv/config";
import { readLedger, summarize, ratesFor, LEDGER_PATH } from "../src/ledger.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const DAYS = arg("--days", 30);

const usd = (n) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const bar = (frac, w = 22) => "█".repeat(Math.max(0, Math.round(frac * w))).padEnd(w);

const rows = await readLedger({ sinceDays: DAYS });
if (!rows.length) {
  console.log(`\n  No calls recorded yet.\n  Ledger: ${LEDGER_PATH}`);
  console.log("  It fills as the loop scores and tailors — nothing to show before the first paid call.\n");
  process.exit(0);
}

const s = summarize(rows);
const days = Object.keys(s.byDay).sort();
const spanDays = Math.max(1, days.length);

console.log(`\n  TOKEN LEDGER — last ${DAYS} days (${rows.length} calls over ${spanDays} day${spanDays === 1 ? "" : "s"})\n`);
console.log(`  Total            ${usd(s.total.usd)}`);
console.log(`  Per day          ${usd(s.total.usd / spanDays)}      projected month ${usd((s.total.usd / spanDays) * 30)}`);
if (s.total.failed) console.log(`  Billed failures  ${s.total.failed}   (refusals and unparseable replies still cost)`);

console.log(`\n  ── where it goes ──`);
const stages = Object.entries(s.byStage).sort((a, b) => b[1].usd - a[1].usd);
for (const [name, v] of stages) {
  console.log(
    `  ${name.padEnd(9)} ${usd(v.usd).padStart(9)}  ${bar(v.usd / (s.total.usd || 1))} ` +
      `${String(v.calls).padStart(5)} call${v.calls === 1 ? " " : "s"}  ${usd(v.usd / (v.calls || 1))}/call`,
  );
}

console.log(`\n  ── prompt caching ──`);
const cacheable = s.total.cacheRead + s.total.cacheWrite + s.total.input;
console.log(`  Cache reads      ${k(s.total.cacheRead).padStart(7)}   ${(s.total.cacheHitRate * 100).toFixed(1)}% of ${k(cacheable)} cacheable input`);
console.log(`  Cache writes     ${k(s.total.cacheWrite).padStart(7)}   (billed at 1.25x input)`);
console.log(`  Uncached input   ${k(s.total.input).padStart(7)}`);
console.log(`  Output           ${k(s.total.output).padStart(7)}   (the expensive one)`);
// What those reads saved: they were billed at 0.1x instead of 1x.
const model = Object.entries(s.byModel).sort((a, b) => b[1].usd - a[1].usd)[0]?.[0];
const r = ratesFor(model);
if (r && s.total.cacheRead) {
  const saved = (s.total.cacheRead / 1e6) * (r.input - r.cacheRead);
  console.log(`  Caching saved    ${usd(saved).padStart(7)}   vs paying full input rate for those reads`);
}

console.log(`\n  ── by day ──`);
const peak = Math.max(...days.map((d) => s.byDay[d].usd));
for (const d of days.slice(-14)) {
  const v = s.byDay[d];
  console.log(`  ${d}  ${usd(v.usd).padStart(9)}  ${bar(v.usd / (peak || 1))} ${String(v.calls).padStart(5)} call${v.calls === 1 ? "" : "s"}`);
}

console.log(`\n  ── by model ──`);
for (const [m, v] of Object.entries(s.byModel).sort((a, b) => b[1].usd - a[1].usd)) {
  const rr = ratesFor(m);
  console.log(`  ${m.padEnd(22)} ${usd(v.usd).padStart(9)}  ${String(v.calls).padStart(5)} call${v.calls === 1 ? "" : "s"}` + (rr ? "" : "   (not billed here)"));
}
console.log(`\n  Ledger: ${LEDGER_PATH}\n`);
