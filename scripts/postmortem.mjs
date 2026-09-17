/**
 * Postmortems for lost applications, and the objection log they build.
 *
 *   node scripts/postmortem.mjs [--limit 200] [--company X] [--redo] [--model claude-sonnet-5] [--concurrency 3] [--dry-run]
 *   node scripts/postmortem.mjs record <job id> --class <class> [--stage interview] [--stated ".."] [--inferred ".."] [--confidence medium] [--fix ".."]
 *
 * The first form classifies rejected applications that have no postmortem yet,
 * one model call each with no tools (src/postmortem.js), and stores the result
 * on the job. The second records one by hand, for a loss after a screen or an
 * interview where what happened in the room matters more than the posting.
 * Stops cleanly if the Max plan pauses; run again later to continue.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { findJobs } from "../src/job-lookup.js";
import { attachedAtApply, jobCompanyKeys } from "../src/warm-path.js";
import {
  postmortemJob,
  objectionPatterns,
  POSTMORTEM_MODEL,
  CLASSES,
  STAGES,
  CONFIDENCE,
} from "../src/postmortem.js";

const VALUE_FLAGS = new Set([
  "limit",
  "company",
  "model",
  "concurrency",
  "stage",
  "class",
  "stated",
  "inferred",
  "confidence",
  "fix",
]);
const argv = process.argv.slice(2);
const opts = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    opts[k] = VALUE_FLAGS.has(k) ? argv[++i] : true;
  } else args.push(a);
}

const db = await getDb();
const jobs = db.collection("jobs");
const contacts = await db.collection("contacts").find({}).toArray();
const byKey = new Map();
for (const c of contacts) {
  if (!byKey.has(c.companyKey)) byKey.set(c.companyKey, []);
  byKey.get(c.companyKey).push(c);
}
const contactsFor = (job) =>
  jobCompanyKeys(job).flatMap((k) => byKey.get(k) || []);
const coName = (j) => j.companyName || j.companyToken;
const REJECTED = {
  submitStatus: "submitted",
  $or: [{ "reply.state": "rejected" }, { outcome: "rejected" }],
};

async function fail(msg) {
  console.error(`  ✗ ${msg}`);
  await closeDb();
  process.exit(1);
}

async function printLog() {
  const done = await jobs
    .find(
      { submitStatus: "submitted", postmortem: { $exists: true } },
      { projection: { postmortem: 1 } },
    )
    .toArray();
  const { byClass, patterns, unknownOrLow } = objectionPatterns(
    done.map((j) => j.postmortem),
  );
  console.log(`\nOBJECTION LOG: ${done.length} postmortem(s)`);
  for (const c of CLASSES)
    if (byClass[c]) console.log(`  ${c.padEnd(22)} ${byClass[c]}`);
  if (unknownOrLow)
    console.log(`  ${"unknown or low confidence".padEnd(22)} ${unknownOrLow}`);
  for (const p of patterns)
    console.log(
      `  ⚠ ${p.n} × ${p.class}: three of a kind is a positioning problem, not luck`,
    );
  console.log(`\n  full funnel: node scripts/funnel.mjs`);
}

if (args[0] === "record") {
  const id = args[1];
  if (!/^[a-f0-9]{24}$/i.test(id || ""))
    await fail("record needs a job id (24 hex)");
  if (!CLASSES.includes(opts.class))
    await fail(`--class must be one of: ${CLASSES.join(", ")}`);
  const stage = opts.stage || "application";
  if (!STAGES.includes(stage))
    await fail(`--stage must be one of: ${STAGES.join(", ")}`);
  const confidence = opts.confidence || "medium";
  if (!CONFIDENCE.includes(confidence))
    await fail(`--confidence must be one of: ${CONFIDENCE.join(", ")}`);
  const job = (await findJobs(jobs, id, { filter: REJECTED }))[0];
  if (!job)
    await fail(
      `${id} is not a sent application marked rejected. Mark it first: node scripts/outcome.mjs <company> rejected`,
    );
  const pm = {
    stated: opts.stated || "none given",
    inferred: opts.inferred || "",
    class: opts.class,
    confidence,
    evidence: "",
    evidenceVerified: false,
    fix: opts.fix || "",
    stage,
    personAttached: attachedAtApply(job, contactsFor(job)),
    daysToRejection: null,
    model: null,
    source: "manual",
    at: new Date(),
  };
  await jobs.updateOne(
    { _id: job._id },
    { $set: { postmortem: pm, pipelineStage: stage } },
  );
  console.log(
    `  recorded: ${coName(job)} — ${job.title}: ${pm.class} (${pm.confidence}) at ${stage}`,
  );
  await printLog();
  await closeDb();
  process.exit(0);
}

const limit = Number(opts.limit ?? 200);
const model = opts.model || POSTMORTEM_MODEL;
const concurrency = Math.max(1, Number(opts.concurrency ?? 3));
const filter = opts.redo
  ? REJECTED
  : { ...REJECTED, postmortem: { $exists: false } };
const queue = opts.company
  ? await findJobs(jobs, opts.company, { filter, limit })
  : await jobs
      .find(filter)
      .sort({ submitAttemptAt: -1 })
      .limit(limit)
      .toArray();

console.log(
  `postmortem with ${model}: ${queue.length} rejection(s)${opts["dry-run"] ? " (dry run, nothing saved)" : ""}`,
);
let next = 0;
let paused = null;
async function worker() {
  while (next < queue.length && !paused) {
    const job = queue[next++];
    let pm;
    try {
      pm = await postmortemJob(job, {
        attached: attachedAtApply(job, contactsFor(job)),
        model,
      });
    } catch (e) {
      if (
        /paused|usage limit|session limit|did not answer/i.test(
          String(e.message),
        )
      )
        paused = e.message;
      else
        console.log(`  ✗ ${coName(job)}: ${String(e.message).slice(0, 100)}`);
      continue;
    }
    if (!opts["dry-run"])
      await jobs.updateOne({ _id: job._id }, { $set: { postmortem: pm } });
    console.log(
      `  ${coName(job).slice(0, 18).padEnd(18)} ${job.title.slice(0, 38).padEnd(38)} ${pm.class} (${pm.confidence})` +
        `${pm.daysToRejection != null ? ` · ${pm.daysToRejection}d` : ""}${pm.evidenceVerified ? ` · "${pm.evidence.slice(0, 60)}"` : ""}`,
    );
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
if (paused)
  console.log(
    `\n  stopped early: ${paused.slice(0, 100)}. Run again later to continue.`,
  );
await printLog();
await closeDb();
