/**
 * Export the decision log to CSV.
 *
 *   node scripts/export-applications.mjs            applied + skipped
 *   node scripts/export-applications.mjs --applied  submitted only
 *
 * The database is the record, but it is not a record you can read in a hurry or
 * hand to anyone. Every identifier that matters is here: our own _id, the ATS's
 * own job id, and the clusterKey that is how a repost of the same role is
 * recognised as the same role.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getDb, closeDb } from "../src/db.js";

const appliedOnly = process.argv.includes("--applied");

const db = await getDb();
const rows = await db
  .collection("jobs")
  .find(
    appliedOnly
      ? { decision: "approved", submitStatus: "submitted" }
      : { decision: { $in: ["approved", "skipped"] } },
    {
      projection: {
        companyName: 1, companyToken: 1, title: 1, locations: 1, ats: 1,
        sourceJobId: 1, applyUrl: 1, clusterKey: 1, decision: 1, decidedAt: 1,
        decidedVia: 1, submitStatus: 1, submitAttemptAt: 1, lastRunOutcome: 1,
        resumePath: 1, llmScore: 1, postedAtClaimed: 1,
      },
    },
  )
  .sort({ decidedAt: -1 })
  .toArray();

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 19).replace("T", " ") : "");
// Quote everything: titles carry commas, and a company called "Foo, Inc." would
// otherwise silently shift every later column by one.
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

const COLS = [
  ["decided_at",     (r) => iso(r.decidedAt)],
  ["decision",       (r) => r.decision],
  ["outcome",        (r) => r.submitStatus ?? ""],
  ["company",        (r) => r.companyName || r.companyToken],
  ["title",          (r) => r.title],
  ["location",       (r) => (r.locations || [])[0] ?? ""],
  ["fit",            (r) => r.llmScore?.fit ?? ""],
  ["family",         (r) => r.llmScore?.family ?? ""],
  ["submitted_at",   (r) => iso(r.submitAttemptAt)],
  ["how",            (r) => r.lastRunOutcome ?? ""],
  ["apply_url",      (r) => r.applyUrl ?? ""],
  ["resume",         (r) => r.resumePath ?? ""],
  ["ats",            (r) => r.ats],
  ["company_token",  (r) => r.companyToken],
  ["ats_job_id",     (r) => r.sourceJobId ?? ""],
  ["internal_id",    (r) => String(r._id)],
  ["cluster_key",    (r) => String(r.clusterKey ?? "").slice(0, 16)],
  ["posted_at",      (r) => iso(r.postedAtClaimed)],
  ["decided_via",    (r) => r.decidedVia ?? ""],
];

const csv = [
  COLS.map(([h]) => q(h)).join(","),
  ...rows.map((r) => COLS.map(([, f]) => q(f(r))).join(",")),
].join("\n");

const out = appliedOnly ? "out/applied.csv" : "out/applications.csv";
writeFileSync(out, csv + "\n");

const by = {};
for (const r of rows) {
  const k = r.decision === "skipped" ? "skipped" : r.submitStatus || "no attempt yet";
  by[k] = (by[k] || 0) + 1;
}
console.log(`${rows.length} row(s) → ${out}\n`);
for (const [k, n] of Object.entries(by).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(22)}${n}`);
await closeDb();
