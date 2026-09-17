/**
 * Process the approved queue: tailor a resume, render it, fill the form.
 *
 *   node scripts/submit-queue.mjs                 # DRY RUN (default)
 *   node scripts/submit-queue.mjs --live          # actually submits
 *   node scripts/submit-queue.mjs --limit 5 --headed
 *
 * DRY RUN IS THE DEFAULT AND THAT IS DELIBERATE.
 *
 * A dry run does everything a live run does — tailors, renders the PDF, fills
 * every field, answers the work-authorization questions — then screenshots and
 * stops immediately before the submit control. So the exact thing that would be
 * sent is inspectable before anything irreversible happens.
 *
 * `--live` is the only way to submit, and it additionally requires
 * SUBMIT_LIVE_CONFIRM=i-understand in the environment. Two independent switches
 * because a mis-typed flag should not be able to fire 20 applications: an
 * application cannot be recalled, and a bad one burns that employer.
 */

import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { warmPathLine } from "../src/warm-path.js";
import { buildFormFacts } from "../src/form-ai.js";
import { tailorWithReview, formatReview } from "../src/resume-review.js";
import { readFile } from "node:fs/promises";
import { existsSync, readlinkSync } from "node:fs";
import { getDb, closeDb } from "../src/db.js";
import {
  loadBank,
  tailorForJob,
  verifyNoFabrication,
  selectionKey,
} from "../src/tailor.js";
import { renderPdf } from "../src/render-pdf.js";
import { applyToJob } from "../src/submit/index.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const limit = Number(arg("limit", 5));
const live = process.argv.includes("--live");
const headed = process.argv.includes("--headed");
// Hand-off: fill the form in a visible browser, then wait for you to finish the
// free-text questions and press submit yourself. The machine never submits in
// this mode, so it needs none of the --live guards.
const handoff = process.argv.includes("--handoff");

/**
 * Applicant-tracking systems with no anonymous application form.
 *
 * Workday requires an account with each employer tenant before an application
 * form exists at all: the apply URL is the job description, "Apply" leads to a
 * sign-in wall, and the page carries zero inputs and zero forms. Driving a
 * browser at it produces "could not reach an application form" every time, and
 * that is not a bug to fix — creating accounts and entering passwords is not
 * something this tool should do on someone's behalf.
 *
 * Amazon is the same shape by a different route: the apply button leads to a
 * page whose only unanswered required field is "Password". A sign-up wall is a
 * sign-up wall.
 *
 * BUT THE WALL IS ONLY THERE UNTIL YOU HAVE SIGNED IN ONCE.
 *
 * Step 3 drives a persistent browser profile, so a session established by hand
 * survives into every later run against that employer. Skipping these outright in
 * handoff mode would therefore be wrong: it would keep refusing jobs the browser
 * could now complete, and the person would have no way to discover that logging in
 * once had fixed it.
 *
 * So the skip applies to the unattended paths only. In handoff mode the browser
 * opens and the form is attempted; if a session exists it fills, and if it does not
 * the run reports no_form and the job goes to launcher 7 exactly as before. The
 * cost of trying is one page load. The cost of not trying is never applying to any
 * of them.
 *
 * The scale argument matters here too. This is not 1,642 accounts: only four
 * Workday employers currently have a job scoring 70 or better. Signing in four
 * times is a morning, and it is a morning that unlocks a third of the corpus.
 *
 * Either way they get a tailored resume, because a manual application is exactly
 * when the resume is needed.
 */
const NEEDS_ACCOUNT = new Set(["workday", "amazon", "amazon-sde", "amazon-swe"]);

/**
 * The URL that actually has the application form.
 *
 * Greenhouse lets employers wrap a job in their own careers site, so the stored
 * apply URL is a marketing page: pinterestcareers.com/jobs/?gh_jid=6816337 renders
 * via JavaScript, exposes one input and no form, and the filler reported "could
 * not reach an application form" — on the highest-scoring job in the queue.
 *
 * The form is there, in an iframe, served from
 * job-boards.greenhouse.io/embed/job_app. Watching the network on the branded page
 * shows that request carrying a per-load validityToken, which looked like it would
 * have to be scraped. It does not: the embed URL loads the full form with just the
 * board token and the job id, both of which are already in the database. Verified
 * on three — pinterest 27 inputs, samsara 46, roblox 39, each with two file inputs.
 *
 * Rewriting is limited to jobs already identified as Greenhouse. Guessing this
 * shape for an arbitrary host would send an application into a form belonging to
 * whoever happened to answer.
 */
export function formUrl(job) {
  if (job.ats !== "greenhouse" || !job.companyToken || !job.sourceJobId)
    return job.applyUrl;
  // Already canonical — leave it alone.
  if (/job-boards\.greenhouse\.io\/[^/]+\/jobs\//.test(job.applyUrl || ""))
    return job.applyUrl;
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(job.companyToken)}&token=${encodeURIComponent(job.sourceJobId)}`;
}

// Session cookies for job boards live here, so it is gitignored and 0700.
const BROWSER_PROFILE = ".browser-profile";

/** Ask a yes/no question and block on the answer. */
function askYesNo(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(/^\s*y/i.test(String(d)));
    });
  });
}

if (live && process.env.SUBMIT_LIVE_CONFIRM !== "i-understand") {
  console.error(
    "--live requires SUBMIT_LIVE_CONFIRM=i-understand in the environment.\n" +
      "Applications cannot be recalled; two switches are required on purpose.",
  );
  process.exit(1);
}

const OUT = "out";
await mkdir(OUT, { recursive: true });

const db = await getDb();
const jobs = db.collection("jobs");
const bank = await loadBank();
const answers = YAML.parse(await readFile("data/answers.yaml", "utf8"));

const queue = await jobs
  .find({ decision: "approved", submitStatus: "queued" })
  .sort({ "llmScore.fit": -1 })
  .limit(limit)
  .toArray();

if (!queue.length) {
  console.log("nothing queued. approve jobs in Telegram first.");
  await closeDb();
  process.exit(0);
}

console.log(
  // "DRY RUN" is accurate but reads wrong under the APPLY WITH ME banner, where
  // the point is that a real browser opens and the user submits by hand.
  `${live ? "*** LIVE ***" : handoff ? "HANDOFF — you press submit" : "DRY RUN"} — ${queue.length} queued job(s)\n`,
);

// Warm the persistent profile before the first job. Creating a Chromium profile
// from scratch takes long enough to time out the first navigation, which cost a
// real job an "error" status on its first run.
/**
 * Refuse to start if another Chromium already holds the browser profile.
 *
 * Chromium allows exactly one process per user-data-dir. When a previous run's
 * browser is still alive, launchPersistentContext throws for EVERY job — and
 * because the outer catch treats a launch failure like a submission failure, a
 * single stale browser burned one of four retry attempts on all twelve queued
 * jobs before anyone could read the message. Three more runs and the whole queue
 * would have parked itself over a window nobody closed.
 *
 * The lock is a symlink naming the owning pid, so the cause is knowable up front.
 * Check once, name the process, and exit before the queue is touched.
 */
function profileLockOwner() {
  try {
    const target = readlinkSync(join(BROWSER_PROFILE, "SingletonLock"));
    const pid = Number(String(target).split("-").pop());
    if (!Number.isFinite(pid)) return null;
    try {
      process.kill(pid, 0); // signal 0 tests existence without touching it
      return pid;
    } catch {
      return null; // stale symlink, no live owner — Chromium will clean it up
    }
  } catch {
    return null;
  }
}

if (handoff) {
  const owner = profileLockOwner();
  if (owner) {
    console.log(`  ✗ the browser profile is already open in another process (pid ${owner}).`);
    console.log(`\n    Chromium permits one process per profile, so every job would fail`);
    console.log(`    and burn a retry attempt. Nothing has been touched.`);
    console.log(`\n    Close that browser window, or if it is a leftover with nothing in it:`);
    console.log(`      kill ${owner}`);
    console.log(`\n    Then run this again.`);
    process.exit(1);
  }
}

if (handoff && !existsSync(BROWSER_PROFILE)) {
  process.stdout.write("  preparing browser profile (first run only)… ");
  const { chromium } = await import("playwright");
  const ctx = await chromium.launchPersistentContext(BROWSER_PROFILE, { headless: true });
  await ctx.close();
  console.log("done\n");
}

let ok = 0;
for (const job of queue) {
  const tag = `${job.companyName || job.companyToken}`.slice(0, 28);
  console.log(`▸ ${tag} — ${job.title.slice(0, 52)}`);
  const wpLine = warmPathLine(job);
  if (wpLine) console.log(wpLine);

  let handoffSubmitted = false;
  try {
    // 1. tailor from the bank (selection only — no generated prose)
    // Reuse the stored selection when posting, bank, prompt and model are all
    // unchanged. Without this every run re-called the model for every job — and
    // because these runs were FAILING, the same nine jobs were re-tailored on
    // each retry, paying for a selection that had not changed and a form that
    // was never reachable.
    const selKey = selectionKey(job, bank);
    const cachedSel =
      job.selectionKey === selKey && job.selection ? job.selection : null;
    // With review on, a fresh selection is reviewed and, on a "fix" verdict,
    // revised once (resume-review.js). A cached selection already carries its
    // review and any exclusions, so it costs no model call.
    const reviewOn = process.env.RESUME_REVIEW !== "false";
    const priorReview = job.resumeReview?.selectionKey === selKey ? job.resumeReview : null;
    const tailored =
      reviewOn && !(cachedSel && priorReview)
        ? await tailorWithReview(job, bank, { cachedSelection: cachedSel })
        : { ...(await tailorForJob(job, bank, { cachedSelection: cachedSel })), review: priorReview };
    const check = verifyNoFabrication(tailored.rendered ?? tailored, bank);
    if (!check.ok) {
      // Hard stop. Never send a document containing text that is not in the bank.
      console.log(
        `  ✗ FABRICATION CHECK FAILED — ${check.violations.length} violation(s), skipping`,
      );
      for (const v of check.violations.slice(0, 3))
        console.log(`      ${v.field}: ${v.text}`);
      await jobs.updateOne(
        { _id: job._id },
        { $set: { submitStatus: "blocked_fabrication" } },
      );
      continue;
    }

    // 2. render to a one-page PDF
    const safe = `${job.companyToken}-${job._id}`.replace(/[^a-z0-9-]/gi, "_");
    const pdfPath = join(OUT, `${safe}.pdf`);
    const pdf = await renderPdf(tailored.rendered ?? tailored, pdfPath);
    console.log(`  resume: ${pdf.pages}p, ${pdf.trims} trims -> ${pdfPath}`);

    // 2a. The recruiter's read of the page (it can move between bank lines, never write one).
    if (tailored.review) {
      if (tailored.revised)
        console.log(`  review said fix: revised once, ${tailored.firstReview.weakLines.length} weak line(s) swapped out`);
      for (const l of formatReview(tailored.review)) console.log(l);
      if (tailored.review !== priorReview)
        await jobs.updateOne(
          { _id: job._id },
          { $set: { resumeReview: { ...tailored.review, selectionKey: selKey, revised: !!tailored.revised } } },
        );
    }

    // 2b. Stop here for account-gated systems. The resume is rendered and stored
    // above because the application will be made by hand and that is when it is
    // needed; opening a browser at a sign-in wall only produces a failure, a
    // retry, and another model call on the next run.
    if (NEEDS_ACCOUNT.has(job.ats) && !handoff) {
      console.log(
        `  status: needs_account  |  ${job.ats} needs a signed-in session`,
      );
      console.log(`    apply by hand: ${job.applyUrl}`);
      console.log(
        `    or sign in once at that employer in step 3, and this becomes fillable`,
      );
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            submitStatus: "needs_manual_account",
            resumePath: pdfPath,
            selection: tailored.selection,
            selectionKey: selKey,
            submitNotes: [
              `${job.ats} requires an account with this employer before an application form exists — apply by hand with the resume above`,
            ],
          },
          $unset: { submitAttempts: "" },
        },
      );
      console.log();
      continue;
    }

    // 3. fill the form
    const shot = join(OUT, `${safe}.png`);
    const target = formUrl(job);
    if (target !== job.applyUrl)
      console.log(`  form: using the Greenhouse embed rather than the branded page`);
    const res = await applyToJob({
      applyUrl: target,
      answers,
      ai: {
        job: { company: job.companyName || job.companyToken, title: job.title, location: (job.locations || [])[0] },
        facts: buildFormFacts(answers, tailored.rendered ?? tailored),
      },
      resumePath: pdfPath,
      dryRun: !live,
      screenshotPath: shot,
      headless: handoff ? false : !headed,
      profileDir: handoff ? BROWSER_PROFILE : null,
      onHandoff: handoff
        ? async ({ filled, unfilled }) => {
            console.log(`  filled: ${filled.map((f) => f.field).join(", ") || "none"}`);
            for (const f of filled.filter((x) => x.how === "ai"))
              console.log(`  AI answered "${f.field.slice(3)}": ${f.value}  (check it)`);
            if (unfilled.length) {
              console.log("  YOU need to answer these before submitting:");
              for (const u of unfilled.slice(0, 8))
                console.log(`    · ${String(u.label || u).slice(0, 88)}`);
            }
            console.log(`  resume attached: ${pdfPath}`);
            // Ask, rather than assume. Handing the browser over is not evidence
            // that anything was sent — the form may need an account, the essay
            // answers may take longer than this sitting, the window may have
            // been unusable. Assuming success silently dequeued jobs that were
            // never applied to.
            const done = await askYesNo(
              "\n  Did you SUBMIT this application? [y/N] → ",
            );
            handoffSubmitted = done;
            if (!done) console.log("  keeping it queued for later");
          }
        : null,
    });

    const fields = res.filled.map((f) => f.field).join(", ") || "none";
    console.log(`  status: ${res.status}  |  filled: ${fields}`);
    for (const n of res.notes) console.log(`    note: ${n}`);
    if (res.screenshot) console.log(`  screenshot: ${res.screenshot}`);

    // A DRY RUN MUST NOT DEQUEUE. It is a preview; the application has not been
    // made. Writing dry_run_ok here removed 11 approved jobs from the queue that
    // step 3 reads, so they silently became unreachable without ever having been
    // applied to. The dry-run outcome is recorded separately instead.
    const status =
      res.status === "dry_run"
        ? "queued"
        : res.status === "handoff"
          ? handoffSubmitted
            ? "submitted"
            : "queued"
          : res.status === "submitted"
            ? "submitted"
            : res.status === "captcha"
              ? "needs_manual_captcha"
              : `failed_${res.status}`;

    await jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          submitStatus: status,
          submitAttemptAt: new Date(),
          lastRunOutcome: res.status,
          submitFilled: res.filled,
          submitNotes: res.notes,
          resumePath: pdfPath,
          selection: tailored.selection,
          selectionKey: selKey,
        },
      },
    );
    if (res.status === "submitted" || res.status === "dry_run") ok++;
  } catch (e) {
    console.log(`  ✗ ${String(e.message).slice(0, 160)}`);
    // A crash is not a decision. Writing a terminal status here dequeued jobs
    // for transient reasons — a slow page, a first-run browser-profile
    // initialisation, a dropped connection — and the application was never
    // made. Stay queued and count attempts, so a genuinely broken posting
    // eventually stops being retried while a flaky one gets another chance.
    const attempts = (job.submitAttempts || 0) + 1;
    await jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          submitStatus: attempts >= 4 ? "error_giving_up" : "queued",
          submitAttempts: attempts,
          submitNotes: [String(e.message).slice(0, 300)],
        },
      },
    );
    if (attempts >= 4)
      console.log("    4 failed attempts — parking it, apply to this one by hand");
    else console.log(`    kept queued (attempt ${attempts}/4)`);
  }
  console.log();
}

console.log(`${ok}/${queue.length} ${live ? "submitted" : "dry-run clean"}`);
if (!live)
  console.log(
    "review out/*.png, then re-run with --live and SUBMIT_LIVE_CONFIRM=i-understand",
  );
await closeDb();
