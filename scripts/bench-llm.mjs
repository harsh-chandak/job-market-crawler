/**
 * Benchmark a model on the scoring task.
 *
 *   node scripts/bench-llm.mjs --model qwen2.5-coder:3b
 *   node scripts/bench-llm.mjs --model qwen2.5:7b
 *   node scripts/bench-llm.mjs --provider groq --model llama-3.3-70b-versatile
 *
 * Measures what actually went wrong with the 3B model rather than eyeballing:
 *
 *   compliance  did it produce valid JSON on the first attempt
 *   spread      stdev of scores. A model that rates everything 80-85 is not
 *               ranking, it is agreeing — and a ranker that cannot separate is
 *               useless even if every individual score looks plausible
 *   family      agreement with the deterministic screen's title-based family.
 *               The screen is not ground truth, but large disagreement means
 *               the model is ignoring the title
 *   discrimination  does it ever say "poor"/"stretch"? All-good is a red flag
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { loadBank } from "../src/tailor.js";
import { scoreJob, candidateProfile } from "../src/scoring.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const model = arg("model", null);
const provider = arg("provider", null);
const limit = Number(arg("limit", 12));
const llm = { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

const db = await getDb();
const bank = await loadBank();
const profile = candidateProfile(bank);

// A fixed, deterministic sample so runs are comparable across models.
const jobs = await db
  .collection("jobs")
  .find({
    status: "new",
    "screen.roleFamily": { $ne: null },
    $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 600] },
  })
  .sort({ _id: 1 })
  .limit(limit)
  .toArray();

console.log(
  `benchmarking ${provider || "claude-code"} / ${model || "(default)"} on ${jobs.length} jobs\n`,
);

const rows = [];
const t0 = Date.now();
for (const [i, job] of jobs.entries()) {
  process.stdout.write(`\r  ${i + 1}/${jobs.length}`);
  const started = Date.now();
  try {
    const s = await scoreJob(job, bank, { profile, llm });
    rows.push({
      job,
      score: s,
      ms: Date.now() - started,
      attempts: s._meta.attempts,
    });
  } catch (err) {
    rows.push({
      job,
      error: String(err?.message || err),
      ms: Date.now() - started,
    });
  }
}
process.stdout.write("\r");

const okRows = rows.filter((r) => r.score);
const fits = okRows.map((r) => r.score.fit);
const firstTry = okRows.filter((r) => r.attempts === 1).length;
const famAgree = okRows.filter(
  (r) => r.score.family === r.job.screen.roleFamily,
).length;
const verdicts = okRows.reduce(
  (a, r) => ((a[r.score.verdict] = (a[r.score.verdict] || 0) + 1), a),
  {},
);
const totalMs = Date.now() - t0;

console.log("──────────── benchmark ────────────");
console.log(
  `  model              ${provider || "claude-code"} / ${model || "(default)"}`,
);
console.log(`  scored             ${okRows.length}/${jobs.length}`);
console.log(
  `  valid on 1st try   ${firstTry}/${okRows.length || 1}   ← schema compliance`,
);
console.log(
  `  avg latency        ${(totalMs / jobs.length / 1000).toFixed(1)}s per job`,
);
console.log(
  `  fit range          ${fits.length ? `${Math.min(...fits)}–${Math.max(...fits)}` : "—"}`,
);
console.log(
  `  fit stdev          ${stdev(fits).toFixed(1)}   ← <5 means it is not really ranking`,
);
console.log(
  `  family agreement   ${famAgree}/${okRows.length || 1} vs deterministic screen`,
);
console.log(
  `  verdict spread     ${
    Object.entries(verdicts)
      .map(([k, v]) => `${k}:${v}`)
      .join("  ") || "—"
  }`,
);

const distinctFamilies = new Set(okRows.map((r) => r.score.family));
console.log(`  families used      ${[...distinctFamilies].join(", ") || "—"}`);

console.log("\n  per-job:");
for (const r of rows) {
  if (r.error) {
    console.log(
      `    ERR  ${r.job.title.slice(0, 44).padEnd(44)} ${r.error.slice(0, 40)}`,
    );
    continue;
  }
  const agree = r.score.family === r.job.screen.roleFamily ? " " : "≠";
  console.log(
    `    ${String(r.score.fit).padStart(3)} ${r.score.verdict.padEnd(7)} ${r.score.family.padEnd(4)}${agree} ` +
      `${(r.job.companyName || "").slice(0, 16).padEnd(16)} ${r.job.title.slice(0, 40)}`,
  );
}

await closeDb();
