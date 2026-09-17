/**
 * Discrimination test with negative controls.
 *
 *   node scripts/bench-controls.mjs --model qwen2.5:7b
 *
 * bench-llm.mjs only scores jobs that ALREADY passed the deterministic screen,
 * so every input is a plausible match. "verdict: good on all 12" is therefore
 * uninterpretable — it could be an honest read of a biased sample rather than a
 * model that cannot discriminate.
 *
 * This feeds known-good and known-bad postings together. A usable ranker must
 * separate them. If a registered nurse posting scores like a backend role, the
 * model is not reading the job.
 */

import "dotenv/config";
import { loadBank } from "../src/tailor.js";
import { scoreJob } from "../src/scoring.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const model = arg("model", process.env.LLM_MODEL || "claude-fable-5-1");
const provider = arg("provider", process.env.LLM_PROVIDER || "claude-code");

const CASES = [
  // ---- should score HIGH ----
  { label: "GOOD", title: "Software Engineer, Backend", company: "Databricks",
    locations: ["San Francisco, CA"],
    description: "Build distributed data systems in Python and Go. 2+ years experience. REST APIs, Kubernetes, AWS. We sponsor H-1B." },
  { label: "GOOD", title: "Full Stack Engineer", company: "Chime",
    locations: ["Remote, US"],
    description: "React/Next.js frontend and FastAPI backend. Docker, AWS, PostgreSQL. New grads welcome. 1-3 years." },
  { label: "GOOD", title: "AI Engineer, LLM Applications", company: "Scale AI",
    locations: ["San Jose, CA"],
    description: "Build RAG pipelines and multi-agent LLM workflows. LangGraph, prompt engineering, vector search, evaluation frameworks." },
  { label: "GOOD", title: "Forward Deployed Engineer", company: "Palantir",
    locations: ["New York, NY"],
    description: "Work directly with clients to deploy and integrate our platform. Python, TypeScript, customer-facing, production ownership." },

  // ---- should score LOW ----
  { label: "BAD", title: "Registered Nurse - ICU Night Shift", company: "HCA Healthcare",
    locations: ["Nashville, TN"],
    description: "Provide direct patient care in intensive care. BSN required. Active RN license. 12-hour night shifts." },
  { label: "BAD", title: "Senior Staff Machine Learning Engineer", company: "Netflix",
    locations: ["Los Gatos, CA"],
    description: "Lead ML platform strategy. 12+ years of experience required. Manage a team of 8. Define multi-year technical roadmap." },
  { label: "BAD", title: "Warehouse Associate - Night Sort", company: "Dollar Tree",
    locations: ["Chesapeake, VA"],
    description: "Load and unload trucks. Lift up to 50lbs. No experience necessary. Hourly position with overtime available." },
  { label: "BAD", title: "Embedded Firmware Engineer, RF Systems", company: "Raytheon",
    locations: ["Tucson, AZ"],
    description: "Develop firmware for radar systems in C and assembly. Active TS/SCI security clearance required. US citizenship mandatory. ITAR." },
  { label: "BAD", title: "Director of Enterprise Sales, West", company: "Oracle",
    locations: ["San Francisco, CA"],
    description: "Own $50M quota. Manage a team of 12 account executives. 15+ years enterprise software sales. Build C-suite relationships." },
  { label: "BAD", title: "Clinical Research Coordinator II", company: "Stanford Medicine",
    locations: ["Palo Alto, CA"],
    description: "Coordinate IRB submissions and patient enrollment for oncology trials. Life sciences degree. Wet lab experience preferred." },
];

const bank = await loadBank();

console.log(`discrimination test — ${provider} / ${model}\n`);
process.env.LLM_PROVIDER = provider;
process.env.LLM_MODEL = model;

const rows = [];
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  process.stdout.write(`\r  ${i + 1}/${CASES.length}`);
  try {
    const t0 = Date.now();
    const r = await scoreJob(c, bank, { llm: { model, provider } });
    rows.push({ ...c, ...r, ms: Date.now() - t0 });
  } catch (e) {
    rows.push({ ...c, fit: null, error: String(e.message || e) });
    console.log(`\n  ERR [${c.title.slice(0,40)}]: ${String(e.message || e).slice(0, 220)}`);
  }
}
process.stdout.write("\r");

const good = rows.filter((r) => r.label === "GOOD" && r.fit != null).map((r) => r.fit);
const bad = rows.filter((r) => r.label === "BAD" && r.fit != null).map((r) => r.fit);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

console.log("──────────── discrimination ────────────");
for (const r of rows) {
  const flag = r.label === "GOOD" ? "✓" : "✗";
  console.log(
    `  ${flag} ${String(r.fit ?? "err").padStart(3)}  ${String(r.verdict ?? "-").padEnd(8)} ${r.title.slice(0, 46)}`,
  );
}
console.log();
console.log(`  avg GOOD          ${avg(good).toFixed(1)}`);
console.log(`  avg BAD           ${avg(bad).toFixed(1)}`);
const sep = avg(good) - avg(bad);
console.log(`  separation        ${sep.toFixed(1)} points`);
const overlap = bad.filter((b) => b >= Math.min(...good)).length;
console.log(`  BAD scoring >= worst GOOD   ${overlap}/${bad.length}`);
console.log();
if (sep >= 25 && overlap === 0) console.log("  → usable: clean separation");
else if (sep >= 15) console.log("  → marginal: ranks, but bad roles leak into the good band");
else console.log("  → NOT usable as a ranker: cannot tell a nurse from a backend engineer");

const verdicts = rows.reduce((a, r) => ((a[r.verdict ?? "err"] = (a[r.verdict ?? "err"] || 0) + 1), a), {});
console.log(`  verdicts used     ${Object.entries(verdicts).map(([k, v]) => `${k}:${v}`).join("  ")}`);
