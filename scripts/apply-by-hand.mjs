/**
 * Walk through the applications the automation cannot make.
 *
 *   node scripts/apply-by-hand.mjs
 *
 * Workday and Amazon require an account with the employer before a form exists;
 * some Greenhouse jobs sit behind branded careers pages the filler cannot reach.
 * Those all end up correctly marked and then sit there, because the queue that
 * tracks them is not a thing you can work through — the URL is in a database and
 * the resume is a hashed filename in out/.
 *
 * This opens each one: the posting in your browser, the tailored PDF in Preview,
 * and your standard answers on the clipboard. You fill the form; it records what
 * happened so the job leaves the queue either way.
 *
 * Generates the resume if it is missing, so a job that never reached the render
 * step is not a dead end.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { warmPathLine } from "../src/warm-path.js";
import { tailorWithReview, formatReview } from "../src/resume-review.js";
import { getDb, closeDb } from "../src/db.js";
import { loadBank, tailorForJob, verifyNoFabrication, selectionKey } from "../src/tailor.js";
import { renderPdf } from "../src/render-pdf.js";

const run = promisify(execFile);
const open = (target) => run("open", [target]).catch(() => {});
const copy = async (text) => {
  try {
    const p = (await import("node:child_process")).spawn("pbcopy");
    p.stdin.write(text);
    p.stdin.end();
  } catch {}
};

const MANUAL = [
  "needs_manual_account",
  "failed_no_form",
  "failed_error",
  "needs_manual_captcha",
  "error_giving_up",
];

await mkdir("out", { recursive: true });
const db = await getDb();
const jobs = db.collection("jobs");
const bank = await loadBank();
const answers = YAML.parse(await readFile("data/answers.yaml", "utf8"));

const queue = await jobs
  .find({ decision: "approved", submitStatus: { $in: MANUAL } })
  .sort({ "llmScore.fit": -1 })
  .toArray();

if (!queue.length) {
  console.log("nothing needs a manual application right now.");
  await closeDb();
  process.exit(0);
}

console.log(`${queue.length} application(s) to make by hand\n`);

const rl = createInterface({ input: stdin, output: stdout });
let done = 0;

for (const [i, job] of queue.entries()) {
  const co = job.companyName || job.companyToken;
  console.log("──────────────────────────────────────────────");
  console.log(`${i + 1}/${queue.length}  ${co} — ${job.title}`);
  console.log(`  fit ${job.llmScore?.fit ?? "?"}   ${(job.locations || [])[0] || ""}`);
  const wpLine = warmPathLine(job);
  if (wpLine) console.log(wpLine);
  if (job.submitNotes?.length) console.log(`  why by hand: ${String(job.submitNotes[0]).slice(0, 90)}`);

  // Render the resume if it is missing. A job that failed before the render step
  // would otherwise be the one case with no document to attach.
  let pdfPath = job.resumePath;
  if (!pdfPath || !existsSync(pdfPath)) {
    process.stdout.write("  generating resume... ");
    const key = selectionKey(job, bank);
    const cached = job.selectionKey === key && job.selection ? job.selection : null;
    const t =
      process.env.RESUME_REVIEW !== "false"
        ? await tailorWithReview(job, bank, { cachedSelection: cached })
        : await tailorForJob(job, bank, { cachedSelection: cached });
    const check = verifyNoFabrication(t.rendered ?? t, bank);
    if (!check.ok) {
      console.log("FABRICATION CHECK FAILED — skipping this one");
      continue;
    }
    const safe = `${job.companyToken}-${job._id}`.replace(/[^a-z0-9-]/gi, "_");
    pdfPath = join("out", `${safe}.pdf`);
    const pdf = await renderPdf(t.rendered ?? t, pdfPath);
    await jobs.updateOne(
      { _id: job._id },
      { $set: { resumePath: pdfPath, selection: t.selection, selectionKey: key } },
    );
    console.log(`${pdf.pages}p${cached ? " (cached selection, no model call)" : ""}`);
    if (t.review) {
      if (t.revised) console.log(`  review said fix: revised once`);
      for (const l of formatReview(t.review)) console.log(l);
      await jobs.updateOne(
        { _id: job._id },
        { $set: { resumeReview: { ...t.review, selectionKey: key, revised: !!t.revised } } },
      );
    }
  }

  console.log(`  resume: ${pdfPath}`);
  console.log(`  form  : ${job.applyUrl}`);

  // answers.yaml is grouped (identity / work_authorization / …), not flat. Read
  // it the way it is actually shaped rather than the way it would be convenient.
  const id = answers.identity || {};
  const wa = answers.work_authorization || {};
  await copy(
    [
      `Name: ${id.full_name ?? ""}`,
      `Email: ${id.email ?? ""}`,
      `Phone: ${id.phone ?? ""}`,
      `Location: ${id.location ?? ""}`,
      id.linkedin ? `LinkedIn: ${id.linkedin}` : null,
      id.website ? `Website: ${id.website}` : null,
      id.github ? `GitHub: ${id.github}` : null,
      `Authorized to work in the US: ${wa.authorized_to_work_us ?? ""}`,
      `Will require sponsorship: ${wa.requires_sponsorship ?? ""}`,
      wa.visa_status ? `Visa status: ${wa.visa_status}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  console.log("  (your standard answers are on the clipboard)");

  await open(job.applyUrl);
  await open(pdfPath);

  const a = (await rl.question("\n  [enter]=applied   s=skip   q=quit  > ")).trim().toLowerCase();
  if (a === "q") break;

  if (a === "s") {
    await jobs.updateOne(
      { _id: job._id },
      { $set: { submitStatus: "skipped_manual", submitAttemptAt: new Date() } },
    );
    console.log("  marked skipped\n");
  } else {
    await jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          submitStatus: "submitted",
          submitAttemptAt: new Date(),
          lastRunOutcome: "by_hand",
        },
        $unset: { submitAttempts: "" },
      },
    );
    done++;
    console.log("  marked submitted\n");
  }
}

rl.close();
console.log(`\n${done} application(s) recorded as submitted`);
await closeDb();
