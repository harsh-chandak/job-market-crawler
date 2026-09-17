/**
 * Everything about one job in one place, for the prep, warm-path and
 * postmortem skills: the posting, the score's reasons and gaps, where the
 * application stands, the people attached, and the resume that was sent.
 *
 *   node scripts/job-info.mjs <job id | company> [--full]
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getDb, closeDb } from "../src/db.js";
import { findJobs } from "../src/job-lookup.js";

const full = process.argv.includes("--full");
const q = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .join(" ");
if (!q) {
  console.log("usage: node scripts/job-info.mjs <job id | company> [--full]");
  process.exit(1);
}
const db = await getDb();
const jobs = db.collection("jobs");
const rows = await findJobs(jobs, q, { limit: 10 });
if (!rows.length) {
  console.log(`no job matches "${q}"`);
  await closeDb();
  process.exit(1);
}
const d = (x) => (x ? new Date(x).toISOString().slice(0, 10) : "—");
const state = (j) =>
  j.submitStatus === "submitted"
    ? `applied ${d(j.submitAttemptAt)} · ${j.reply?.state || j.outcome || "no reply"}`
    : j.decision === "skipped"
      ? "skipped"
      : j.decision === "approved"
        ? `approved · ${j.submitStatus || "not sent"}`
        : j.status;

if (rows.length > 1) {
  console.log(
    `${rows.length} jobs match "${q}" (details for the first; pass an id for another):`,
  );
  for (const j of rows)
    console.log(
      `  ${String(j._id)}  fit ${j.llmScore?.fit ?? "?"}  ${j.title}  [${state(j)}]`,
    );
  console.log("");
}

const j = rows[0];
console.log(`${j.companyName || j.companyToken} — ${j.title}`);
console.log(
  `  id ${j._id} · ${state(j)} · ${(j.locations || []).slice(0, 3).join(" | ")}`,
);
if (j.applyUrl) console.log(`  ${j.applyUrl}`);
if (j.llmScore) {
  const s = j.llmScore;
  console.log(
    `\nSCORE ${s.fit} (${s.verdict}, ${s.family}) · seniority ${s.seniorityFit || "?"} · sponsorship in posting: ${s.sponsorshipSignal || "?"}`,
  );
  for (const r of s.reasons || []) console.log(`  + ${r}`);
  for (const g of s.gaps || []) console.log(`  - gap: ${g}`);
}
if (j.warmPath || j.referral) {
  console.log(`\nWARM PATH`);
  if (j.referral)
    console.log(
      `  referred${j.referral.by ? ` by ${j.referral.by}` : ""} on ${d(j.referral.at)}`,
    );
  if (j.warmPath) {
    console.log(
      `  ${j.warmPath.verdict} (checked ${d(j.warmPath.recordedAt)})`,
    );
    for (const p of j.warmPath.people || [])
      console.log(`    ${p.name}${p.title ? `, ${p.title}` : ""} (${p.rung})`);
  }
}
if (j.postmortem) {
  const p = j.postmortem;
  console.log(`\nPOSTMORTEM ${p.class} (${p.confidence}) at ${p.stage}`);
  console.log(`  stated: ${p.stated}`);
  if (p.inferred) console.log(`  inferred: ${p.inferred}`);
  if (p.fix) console.log(`  fix: ${p.fix}`);
}
if (j.outcomeSubject)
  console.log(`\nREJECTION / REPLY EMAIL SUBJECT: ${j.outcomeSubject}`);
if (j.resumeReview) {
  console.log(
    `\nRESUME REVIEW ${j.resumeReview.verdict}: ${j.resumeReview.note}`,
  );
  if (j.resumeReview.gaps?.length)
    console.log(
      `  posting asks, not claimed: ${j.resumeReview.gaps.join(", ")}`,
    );
}
const pdf = j.resumePath ? resolve(process.cwd(), j.resumePath) : null;
if (pdf && existsSync(pdf)) {
  console.log(`\nRESUME SENT (${j.resumePath})`);
  try {
    console.log(
      execFileSync("pdftotext", ["-layout", pdf, "-"])
        .toString()
        .replace(/\n{3,}/g, "\n\n"),
    );
  } catch {
    console.log("  (could not read the PDF)");
  }
} else console.log(`\nRESUME: none on file for this job`);
const desc = String(j.description || "");
console.log(
  `\nPOSTING${desc.length > 6000 && !full ? " (first 6,000 characters; --full for all)" : ""}`,
);
console.log(full ? desc : desc.slice(0, 6000) || "(no description stored)");
await closeDb();
