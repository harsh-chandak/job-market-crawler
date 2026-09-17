/**
 * The operational loop. One process, three independent clocks.
 *
 *   npm start                  # run until stopped
 *   npm start -- --once        # single pass, then exit
 *   npm start -- --minutes 60  # run for an hour
 *
 * Three things run on their own schedules rather than as one serial cycle:
 *
 *   poll     every CYCLE_SECONDS (180)        — check due boards for new reqs
 *   score    every SCORE_CYCLE_SECONDS (300)  — rank fresh jobs, then notify
 *   listen   continuously                     — handle Telegram button presses
 *
 * They are separate because they have different masters. Poll cadence IS the
 * product: a tier-S board must be checked every three minutes, and a posting
 * missed at 08:40 cannot be un-missed at 09:00. Scoring is bound by a hosted
 * free tier at roughly 36s per job and can always catch up later. Chaining them
 * let the slow, recoverable stage dictate the fast, unrecoverable one — the
 * first live run showed an 8.5-minute effective poll interval against a
 * 3-minute target.
 *
 * Each clock carries an in-flight guard, so a slow run is skipped rather than
 * overlapped, and each is individually try/caught: a Groq outage must never
 * stop polling.
 */

import "dotenv/config";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { ObjectId } from "mongodb";
import { getDb, closeDb } from "../src/db.js";
import { pollDue } from "../src/poller.js";
import { loadBank } from "../src/tailor.js";
import { scoreBatch, candidateProfile, scoreCacheKey } from "../src/scoring.js";
import { isBorderlineRejection, secondLook } from "../src/second-look.js";
import { PROVIDER, MODEL } from "../src/llm.js";
import { prerank, PRERANK_VERSION } from "../src/prerank.js";
import { hydrateWorkday } from "../src/adapters/workday.js";
import { hydrateSmartRecruiters } from "../src/adapters/smartrecruiters.js";
import { hydrateMicrosoft } from "../src/adapters/microsoft.js";

/**
 * Which ATS need a per-job call to get a body, and what fetches it.
 *
 * This was hard-coded to workday, so hydrateSmartRecruiters and hydrateMicrosoft
 * were imported by their one-shot backfill scripts and by nothing else. The
 * backfills would print a hydrated count, the fix would look done, and every
 * posting those boards returned from then on would land with an empty description
 * and be dropped by the scorer's 400-character filter — silently, forever, which
 * is the exact failure the hydrators were written to end.
 *
 * Measured before wiring: smartrecruiters 334 rows, 0 ever scored; microsoft 35
 * rows, 0 ever scored.
 */
const HYDRATORS = new Map([
  ["workday", hydrateWorkday],
  ["smartrecruiters", hydrateSmartRecruiters],
  ["microsoft", hydrateMicrosoft],
]);
import { checkLiveByAts, checkLive } from "../src/liveness.js";
import { loopStatus, clearStaleLock, LOCK } from "../src/lockfile.js";
import { screen } from "../src/filter.js";
import {
  send,
  renderCard,
  decisionKeyboard,
  getUpdates,
  answerCallback,
  editCard,
  esc,
  whoAmI,
} from "../src/telegram.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const once = process.argv.includes("--once");
const stopAfterMs = Number(arg("minutes", 0)) * 60_000;

const CYCLE_SECONDS = Number(process.env.CYCLE_SECONDS || 180);
const SCORE_PER_CYCLE = Number(process.env.SCORE_PER_CYCLE || 20);

/**
 * The only paid stage in this loop, and the only one with an off switch.
 *
 * Polling, hydration, screening, pre-ranking, liveness and notification are all
 * HTTP and local computation — they cost nothing no matter how long the loop runs.
 * Scoring calls Anthropic, and at the measured 1,583 input plus 180 output tokens
 * that is about half a cent each.
 *
 * SCORE_PER_CYCLE=0 previously did NOT mean zero: the value lane floors at
 * Math.max(1, SCORE_PER_CYCLE - FRESH_SCORE_SLOTS) and the fresh lane has its own
 * budget, so setting it to nothing still scored seven jobs a cycle. Anyone
 * reaching for that knob wanted spending to stop; it is now honoured literally.
 *
 * With it off the loop still does everything else, so the corpus keeps growing,
 * descriptions keep arriving and pre-ranks keep being computed. Nothing is lost —
 * the queue simply waits until scoring is turned back on or run in a batch.
 */
const SCORING_ENABLED = SCORE_PER_CYCLE > 0;
// Slots per cycle reserved for the newest postings, ahead of pre-rank order.
const FRESH_SCORE_SLOTS = Number(process.env.FRESH_SCORE_SLOTS || 6);

/**
 * Do not spend a scoring call on a job the free signal already rates hopeless.
 *
 * Measured over 1,757 jobs that have both a pre-rank and a fit score, the pre-rank
 * predicts the outcome well enough to act on:
 *
 *   prerank 70+   43% reach fit 70
 *   prerank 60-70 32%
 *   prerank 55-60 20%
 *   prerank 50-55  9%
 *   below 50       8%
 *
 * Scoring everything is 1,757 calls to find 397 matches — 23% yield, so more than
 * three quarters of the budget buys nothing. A floor at 55 makes it 1,018 calls for
 * 338: 42% fewer calls for 15% fewer matches.
 *
 * That trade is only correct because the bottleneck has moved. 357 jobs already sit
 * above the bar with 233 of them unreviewed, so the marginal match is worth little
 * — there is no shortage of matches, there is a shortage of attention. If the
 * undecided queue ever empties, lower this.
 */
const SCORE_PRERANK_FLOOR = Number(process.env.SCORE_PRERANK_FLOOR || 55);
// Borderline screen rejections re-read by the model per cycle (see second-look.js).
const SECOND_LOOK_PER_CYCLE = Number(process.env.SECOND_LOOK_PER_CYCLE ?? 4);
// Fill budget the fresh and in-window lanes leave unused with older unscored jobs.
const SCORE_BACKLOG = process.env.SCORE_BACKLOG !== "false";

/**
 * The fresh lane gets a floor too — a lower one.
 *
 * It had none at all, and that was not a small leak. On 08-05 the loop made 245
 * scoring calls; 85 of them were on postings below the main floor, which only
 * the fresh lane can admit, and those 85 returned 1 of the 9 matches found that
 * day. The floor documented above as the headline saving was governing the
 * minority of the budget, because the other lane ignored it.
 *
 * 45 rather than 55 because the lanes want different things. The value lane is
 * draining a backlog and should spend on the best of it; the fresh lane exists
 * to make sure this morning's postings are seen this morning, and a slightly
 * weaker posting seen first is worth more than a stronger one seen late. What
 * the floor removes at 45 is the part of the distribution that yields 8%
 * whether it is fresh or not.
 */
const SCORE_FRESH_PRERANK_FLOOR = Number(
  process.env.SCORE_FRESH_PRERANK_FLOOR || 45,
);
const NOTIFY_PER_CYCLE = Number(process.env.NOTIFY_PER_CYCLE || 6);
const MIN_FIT = Number(process.env.MIN_FIT || 70);
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 72);
const DAILY_NOTIFY_CAP = Number(process.env.DAILY_NOTIFY_CAP || 40);
const NOTIFY_ENABLED = process.env.NOTIFY_ENABLED !== "false";

/* ------------------------------------------------------- single instance */
// launchd KeepAlive plus a manual `npm start` is an easy way to end up with two
// loops. That is not merely wasteful: both would poll the same boards, both
// would drain the same Telegram update queue (whichever reads an update first
// consumes it), and a job could be notified twice. One process, enforced.
// Single-instance lock. The liveness logic lives in src/lockfile.js so this and
// the dashboard cannot drift — and so both survive pid reuse, which a bare
// process.kill(pid, 0) does not.
const st = loopStatus();
if (st.running) {
  console.error(
    `already running as pid ${st.pid}. Stop it first, or:\n` +
      `  launchctl bootout gui/$(id -u)/com.harsh.jobhunt`,
  );
  process.exit(1);
}
if (st.reason === "dead" || st.reason === "pid_reused" || st.reason === "unreadable")
  clearStaleLock();
writeFileSync(LOCK, String(process.pid));
const releaseLock = () => {
  try {
    if (readFileSync(LOCK, "utf8").trim() === String(process.pid))
      unlinkSync(LOCK);
  } catch {}
};
process.on("exit", releaseLock);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);

const db = await getDb();
const jobs = db.collection("jobs");
const companies = db.collection("companies");
const bank = await loadBank();
const profile = candidateProfile(bank);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log(`${sig} — finishing cycle…`);
  if (!SCORING_ENABLED)
    log(
      "scoring is OFF (SCORE_PER_CYCLE=0). Polling, hydration, screening, " +
        "pre-rank and liveness still run and still cost nothing.",
    );
  });
}

/* ---------------------------------------------------------- telegram side */
// Runs continuously alongside the cycles so presses land immediately.
async function listenForDecisions() {
  // Start from 0 and PROCESS whatever is queued, rather than seeding the offset
  // past it.
  //
  // The previous version fetched pending updates on startup and jumped the
  // cursor beyond them, on the theory that stale updates should not be
  // replayed. That is exactly wrong here. A button press is a deliberate
  // decision by a human, Telegram queues those for 24 hours precisely so they
  // survive the consumer being down, and the consumer IS down routinely — the
  // laptop sleeps, the loop is restarted, Atlas rejects a changed IP. Every
  // approval made in those windows was silently discarded, which is why
  // pressing Apply appeared to do nothing.
  //
  // Re-processing an already-handled update cannot happen: Telegram drops an
  // update permanently once a higher offset is acknowledged, so anything still
  // queued is by definition unhandled.
  let offset = 0;
  let backlog = 0;

  while (!stopping) {
    let updates = [];
    try {
      updates = await getUpdates(offset, 20);
    } catch (e) {
      // A 409 will otherwise loop silently forever while presses go missing.
      if (/409/.test(String(e.message))) log(`telegram: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (updates.length && backlog === 0) {
      backlog = updates.filter((u) => u.callback_query).length;
      if (backlog)
        log(`picked up ${backlog} decision(s) made while the loop was down`);
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      const cq = u.callback_query;
      if (!cq?.data) continue;
      const [action, id] = String(cq.data).split(":");
      if (!id || !["a", "s"].includes(action)) continue;

      let job = null;
      try {
        job = await jobs.findOne({ _id: new ObjectId(id) });
      } catch {}
      if (!job) {
        await answerCallback(cq.id, "no longer queued");
        continue;
      }

      const decision = action === "a" ? "approved" : "skipped";
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            decision,
            decidedAt: new Date(),
            submitStatus: decision === "approved" ? "queued" : null,
          },
        },
      );
      await answerCallback(
        cq.id,
        decision === "approved" ? "queued to apply" : "skipped",
      );
      const mark = decision === "approved" ? "✅ QUEUED" : "⏭ SKIPPED";
      await editCard(
        cq.message.message_id,
        `${mark} · *${esc(String(job.llmScore?.fit ?? ""))}*\n${esc(job.title)}\n${esc(job.companyName || "")}`,
      ).catch(() => {});
      log(
        `  ${mark} ${String(job.companyName || "").slice(0, 22)} — ${job.title.slice(0, 40)}`,
      );
    }
  }
}

/* --------------------------------------------------------------- stages */
async function stagePoll() {
  const { polled, summary, results } = await pollDue({ limit: 600 });
  if (!polled) return { polled: 0 };
  const changed = (summary.ok || 0) + (summary.burst || 0);
  log(
    `poll   ${polled} boards · ${summary.not_modified || 0} unchanged · ${changed} changed · ${summary.inserted || 0} new · ${summary.screenedIn || 0} match`,
  );
  if (summary.burst) {
    // Name them. A count alone is a fact you cannot act on: knowing two boards
    // are dropping roles right now is only useful if you know which two, and
    // the tokens are already sitting in `results`.
    const who = (results || [])
      .filter((r) => r.outcome === "burst")
      .map((r) => String(r.company || "").split(":").slice(1).join(":"))
      .filter(Boolean);
    const shown = who.slice(0, 6).join(", ");
    const more = who.length > 6 ? ` +${who.length - 6} more` : "";
    log(
      `  ⚡ ${summary.burst} board(s) burst-posting — now on 3m cadence: ${shown}${more}`,
    );
  }
  return { polled, ...summary };
}

async function stagePrerank() {
  // New jobs arrive without a pre-rank, and an unranked job sorts last — it
  // would never be picked while a backlog exists. Cheap and deterministic, so
  // it runs inline before every scoring pass rather than as a separate job.
  //
  // Also re-ranks anything computed under an older PRERANK_VERSION. A pre-rank
  // rule is worthless if it only applies to jobs that arrive after it is
  // written: the floor is enforced against the STORED score, so the ~4,700 rows
  // already ranked would keep their old verdict and keep drawing scoring calls
  // the new rule was meant to stop. Re-ranking is a local function call and a
  // bulk write — the thing it protects is the paid one — and 500 per cycle
  // converges the whole corpus in a handful of cycles without a migration.
  const fresh = await jobs
    .find({
      status: "new",
      "screen.roleFamily": { $ne: null },
      $or: [
        { prerank: { $exists: false } },
        { "prerank.v": { $ne: PRERANK_VERSION } },
      ],
    })
    .limit(500)
    .toArray();
  if (!fresh.length) return { ranked: 0 };
  const keys = [...new Set(fresh.map((j) => `${j.ats}:${j.companyToken}`))];
  const cos = new Map(
    (
      await companies
        .find(
          {
            $or: keys.map((k) => ({
              ats: k.split(":")[0],
              token: k.split(":").slice(1).join(":"),
            })),
          },
          { projection: { ats: 1, token: 1, sponsorship: 1, isTarget: 1 } },
        )
        .toArray()
    ).map((c) => [`${c.ats}:${c.token}`, c]),
  );
  await jobs.bulkWrite(
    fresh.map((j) => ({
      updateOne: {
        filter: { _id: j._id },
        update: {
          $set: {
            prerank: prerank(j, cos.get(`${j.ats}:${j.companyToken}`) || {}),
          },
        },
      },
    })),
    { ordered: false },
  );
  return { ranked: fresh.length };
}

/**
 * Fetch the descriptions Workday withholds at poll time.
 *
 * Workday's list endpoint returns stubs; the body needs a call per job. The
 * poller correctly refuses to pay that — a board poll must stay one request —
 * but nothing downstream ever paid it either, so every one of the 1,642 Workday
 * rows ingested was screened, pre-ranked, then skipped by the scorer's
 * 400-character floor. A third of the corpus, silently invisible, and the third
 * where large enterprises host.
 *
 * TWO LANES, because pre-rank order alone starves today.
 *
 * Draining purely by pre-rank spends the whole budget on the best of the backlog,
 * and with 371 stubs queued that put this morning's Workday postings behind
 * roughly an hour of older ones. For a pipeline whose entire premise is being
 * early, ordering by quality and ignoring recency defeats the point: a role posted
 * two days ago that scores 84 is worth less than one posted an hour ago that
 * scores 76, because a hundred people have already applied to the first.
 *
 * So the budget splits. The fresh lane takes newest-first among postings from the
 * last 24 hours, so today always surfaces today. The value lane takes best
 * pre-rank from everything else, so the backlog still drains by worth rather than
 * by arrival. Hydration is only HTTP, but every row it fills becomes eligible for
 * the scorer, which is the part that costs money — so the free signal still
 * decides what the backlog spends its share on.
 *
 * Re-screens and re-ranks afterwards, because the first screen ran against an
 * empty body: work-authorisation and years-of-experience checks could only
 * return 'unknown', and skill overlap scored zero for every Workday job.
 */
async function stageHydrate() {
  const per = Number(process.env.HYDRATE_PER_CYCLE || 30);
  const freshShare = Number(process.env.HYDRATE_FRESH_SHARE || 0.6);
  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000);
  const fresh24 = new Date(Date.now() - 24 * 3600 * 1000);

  const base = {
    ats: { $in: [...HYDRATORS.keys()] },
    status: "new",
    llmScore: { $exists: false },
    hydrateFailed: { $ne: true },
    $expr: { $lte: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] },
    $or: [
      { claimedLagMs: { $ne: null, $lt: MAX_AGE_HOURS * 3600 * 1000 } },
      { claimedLagMs: null, firstSeenAt: { $gte: cutoff } },
    ],
  };

  const nFresh = Math.max(1, Math.round(per * freshShare));
  const freshLane = await jobs
    .find({ ...base, postedAtClaimed: { $gte: fresh24 } })
    .sort({ postedAtClaimed: -1 })
    .limit(nFresh)
    .toArray();

  const seen = new Set(freshLane.map((j) => String(j._id)));
  const valueLane = await jobs
    .find({ ...base, _id: { $nin: freshLane.map((j) => j._id) } })
    .sort({ "prerank.score": -1, firstSeenAt: -1 })
    .limit(per - freshLane.length)
    .toArray();

  const stubs = [
    ...freshLane,
    ...valueLane.filter((j) => !seen.has(String(j._id))),
  ];
  if (!stubs.length) return { hydrated: 0, failed: 0 };

  let hydrated = 0;
  let failed = 0;
  let stale = 0;
  for (const job of stubs) {
    // Re-screen the TITLE before paying for the body.
    //
    // `screen.pass` on a row is whatever filter.js decided the day it was
    // ingested, and filter.js keeps learning — the title rules that reject
    // unqualified "Systems Engineer" and industrial "Application Engineer" post-
    // date most of this queue. A stub's title is already known, so a title-only
    // rejection is free, while letting it through costs an HTTP fetch here and a
    // model call in stageScore. Measured against the 282 stubs queued right now:
    // 53 of them (18.8%) fail the current screen on title alone.
    //
    // Body-dependent checks cannot fire yet and must not: with an empty
    // description the work-auth and years-of-experience rules can only return
    // "unknown", so this deliberately re-screens the stub as it stands and acts
    // only when the verdict is already no. The full screen still runs below on
    // the hydrated body.
    const pre = screen(job);
    if (!pre.pass) {
      await jobs.updateOne(
        { _id: job._id },
        { $set: { screen: pre, status: "screened_out" } },
      );
      stale++;
      continue;
    }
    const company = await companies.findOne({
      ats: job.ats,
      token: job.companyToken,
    });
    if (!company) {
      failed++;
      continue;
    }
    const hydrate = HYDRATORS.get(job.ats);
    const r = await hydrate(job, company, { timeout: 20_000 });
    if (r.status !== "ok" || r.description.length <= 400) {
      // Mark it so a permanently bodyless posting is not refetched every cycle
      // forever, starving the queue behind it.
      await jobs.updateOne(
        { _id: job._id },
        { $set: { hydrateFailed: true, hydrateError: r.error || r.status } },
      );
      failed++;
      continue;
    }
    const withBody = { ...job, description: r.description };
    const sc = screen(withBody);
    await jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          description: r.description,
          hydratedAt: new Date(),
          screen: sc,
          prerank: prerank(withBody, company),
          ...(sc.pass ? {} : { status: "screened_out" }),
        },
      },
    );
    hydrated++;
  }
  return { hydrated, failed, stale, fresh: freshLane.length };
}

/**
 * Retire postings that have closed since we surfaced them.
 *
 * A closed job looks like a broken link from the reviewer's side and costs the
 * same: attention spent, a tab opened on a 404, sometimes a resume rendered. The
 * observed rate is about 1%, which is low enough that this runs as a slow
 * background sweep over the best of the queue rather than a gate on anything.
 *
 * Only "dead" acts. "unknown" — a bot wall, a timeout, a 5xx — is left alone,
 * because a flaky connection must never retire a live requisition.
 */
async function stageLiveness() {
  const per = Number(process.env.LIVENESS_PER_CYCLE || 25);
  const rows = await jobs
    .find(
      {
        status: "new",
        decision: { $exists: false },
        "llmScore.fit": { $gte: MIN_FIT },
        livenessCheckedAt: { $exists: false },
      },
      { projection: { ats: 1, companyToken: 1, sourceJobId: 1, applyUrl: 1 } },
    )
    .sort({ "llmScore.fit": -1 })
    .limit(per)
    .toArray();
  if (!rows.length) return { checked: 0, closed: 0 };

  const ashbyBoardCache = new Map();
  let closed = 0;
  for (const j of rows) {
    let r = await checkLiveByAts(j, { ashbyBoardCache });
    if (!r) r = await checkLive(j.applyUrl);
    const set = { livenessCheckedAt: new Date() };
    if (r.state === "dead") {
      set.status = "closed";
      set.closedDetectedAt = new Date();
      closed++;
    }
    await jobs.updateOne({ _id: j._id }, { $set: set });
  }
  return { checked: rows.length, closed };
}

/**
 * Re-read borderline screen rejections with the model. Only rejections whose
 * every reason is a near-limit years-of-experience read or an unrecognised
 * title qualify (isBorderlineRejection); a rescued job goes back to "new" and
 * is pre-ranked and scored like any other. Each job is looked at once.
 */
async function stageSecondLook() {
  if (!SECOND_LOOK_PER_CYCLE) return null;
  const rows = await jobs
    .find({
      status: "screened_out",
      "screen.secondLook": { $exists: false },
      firstSeenAt: { $gte: new Date(Date.now() - 7 * 864e5) },
      $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] },
    })
    .sort({ firstSeenAt: -1 })
    .limit(300)
    .toArray();
  const picks = rows.filter((j) => isBorderlineRejection(j.screen)).slice(0, SECOND_LOOK_PER_CYCLE);
  let rescued = 0;
  for (const j of picks) {
    const r = await secondLook(j, profile).catch(() => null);
    if (!r) continue; // provider paused or failed; try again next cycle
    const set = {
      "screen.secondLook": {
        rescue: r.rescue,
        requiredYears: r.requiredYears,
        family: r.family,
        reason: r.reason,
        model: r.model,
        at: new Date(),
      },
    };
    if (r.rescue) {
      rescued++;
      Object.assign(set, {
        status: "new",
        "screen.pass": true,
        "screen.roleFamily": j.screen?.roleFamily || r.family,
      });
    }
    await jobs.updateOne({ _id: j._id }, { $set: set });
  }
  return { looked: picks.length, rescued };
}

async function stageScore() {
  const hy = await stageHydrate().catch((e) => {
    log(`hydrate FAILED: ${String(e.message).slice(0, 100)}`);
    return null;
  });
  if (hy?.hydrated || hy?.failed || hy?.stale)
    log(
      `hydrate ${hy.hydrated} body(s) (${hy.fresh} fresh-lane) · ${hy.failed} failed` +
        (hy.stale
          ? ` · ${hy.stale} screened out on title before fetching`
          : ""),
    );
  const lv = await stageLiveness().catch(() => null);
  if (lv?.closed)
    log(
      `liveness: ${lv.closed} of ${lv.checked} had closed since we surfaced them`,
    );
  const pr = await stagePrerank().catch(() => null);
  if (pr?.ranked)
    log(
      `prerank ${pr.ranked} job(s) ranked or re-ranked at v${PRERANK_VERSION}`,
    );

  // The guard belongs HERE, not at the top of this function.
  //
  // stageScore also drives hydration, liveness and pre-ranking — all of them free —
  // so returning early skipped three unpaid stages to avoid one paid one. The
  // commit that added the switch claimed in its own message that the loop "still
  // ingests, hydrates, screens, pre-ranks" with scoring off; that was false the
  // moment it was written. Everything above this line runs regardless; only the
  // paid work below is skipped.
  if (!SCORING_ENABLED) return { scored: 0, skipped: "scoring disabled" };

  const sl = await stageSecondLook().catch((e) => {
    log(`second look FAILED: ${String(e.message).slice(0, 100)}`);
    return null;
  });
  if (sl?.looked) log(`second look: ${sl.rescued} of ${sl.looked} borderline rejection(s) rescued`);

  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000);
  const common = {
    status: "new",
    "screen.roleFamily": { $ne: null },
    llmScore: { $exists: false },
    $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] },
  };

  // THE FRESH LANE RUNS FIRST, and this ordering is the point.
  //
  // It used to run second, after the value lane had already been capped at
  // `SCORE_PER_CYCLE - FRESH_SCORE_SLOTS`. With SCORE_PER_CYCLE=8 in .env and
  // FRESH_SCORE_SLOTS defaulting to 6 that is a cap of two, and the reserved six
  // were only ever filled if six postings under 24 hours old happened to be
  // waiting. When they were not — which is most of the time, because the fresh
  // lane is by construction a trickle — the slots evaporated instead of falling
  // back to the backlog. Measured on 08-05: 51 of 79 scoring cycles scored two
  // jobs or fewer, the mode was exactly two, and the mean was 3.10 against a
  // configured budget of 8. The loop was running at 39% of its own throughput,
  // and on any backlog that is a 4x difference in drain rate.
  //
  // Asking the fresh lane what it actually wants first, then giving the rest to
  // the value lane, makes "reserved" mean reserved-if-needed. `FRESH_SCORE_SLOTS`
  // was also sized against the old code default of 20, not the configured 8, so
  // it is capped at half the budget rather than three quarters of it.
  const freshSlots = Math.max(
    0,
    Math.min(FRESH_SCORE_SLOTS, Math.floor(SCORE_PER_CYCLE / 2)),
  );
  const freshCandidates = freshSlots
    ? await jobs
        .find({
          ...common,
          postedAtClaimed: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
          "prerank.score": { $gte: SCORE_FRESH_PRERANK_FLOOR },
        })
        .sort({ postedAtClaimed: -1 })
        .limit(freshSlots)
        .toArray()
    : [];

  const candidates = await jobs
    .find({
      ...common,
      "prerank.score": { $gte: SCORE_PRERANK_FLOOR },
      _id: { $nin: freshCandidates.map((c) => c._id) },
      $or: [
        { claimedLagMs: { $ne: null, $lt: MAX_AGE_HOURS * 3600 * 1000 } },
        { claimedLagMs: null, firstSeenAt: { $gte: cutoff } },
      ],
    })
    // Pre-rank first, recency second. The order the queue is drained in decides
    // what actually gets seen, and sorting by recency alone spent the budget on
    // whatever arrived last regardless of whether it was worth scoring.
    .sort({ "prerank.score": -1, firstSeenAt: -1 })
    .limit(Math.max(1, SCORE_PER_CYCLE - freshCandidates.length))
    .toArray();
  // The backlog lane. Older unscored postings, best pre-rank first, but only in
  // budget the fresh and in-window lanes left unused, so a new posting never
  // waits behind an old one. Most of the backlog scores out as a poor fit; the
  // point is that it is judged rather than left sitting in the queue.
  const room = Math.max(0, SCORE_PER_CYCLE - candidates.length - freshCandidates.length);
  if (room && SCORE_BACKLOG) {
    const older = await jobs
      .find({
        ...common,
        "prerank.score": { $gte: SCORE_PRERANK_FLOOR },
        _id: { $nin: [...candidates, ...freshCandidates].map((c) => c._id) },
      })
      .sort({ "prerank.score": -1, firstSeenAt: -1 })
      .limit(room)
      .toArray();
    candidates.push(...older);
  }
  if (freshCandidates.length) candidates.push(...freshCandidates);

  if (!candidates.length) return { scored: 0 };

  let ok = 0;
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const b = pending;
    pending = [];
    await jobs.bulkWrite(b, { ordered: false });
  };

  await scoreBatch(candidates, bank, {
    concurrency: 2,
    profile,
    onResult: async (r) => {
      if (r?.error || !r?.score) return;
      ok++;
      pending.push({
        updateOne: {
          filter: { _id: r.job._id },
          update: {
            $set: {
              llmScore: r.score,
              llmScoreKey: scoreCacheKey(r.job),
              llmScoredAt: new Date(),
            },
          },
        },
      });
      if (pending.length >= 5) await flush();
    },
  });
  await flush();
  log(`score  ${ok}/${candidates.length} fresh jobs`);
  return { scored: ok };
}

async function stageNotify() {
  // Campus and corporate wifi drop the connection to api.telegram.org, and the
  // retry then fires every thirty seconds and buries every useful line in the
  // log. Preflight already reports the block clearly once; repeating it 120
  // times an hour tells you nothing new. NOTIFY_ENABLED=false skips the stage
  // outright rather than blanking the token, which would only swap a timeout
  // for a "token not set" throw at the same cadence — and would lose the token.
  if (!NOTIFY_ENABLED) return { sent: 0, skipped: "notifications off" };

  // Respect the daily cap. A queue nobody clears is worse than a short one.
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const sentToday = await jobs.countDocuments({ notifiedAt: { $gte: since } });
  const room = Math.max(0, DAILY_NOTIFY_CAP - sentToday);
  if (!room) return { sent: 0, capped: true };

  const picks = await jobs
    .find({
      llmScore: { $ne: null },
      "llmScore.fit": { $gte: MIN_FIT },
      decision: { $exists: false },
      notifiedAt: { $exists: false },
    })
    .sort({ "llmScore.fit": -1, firstSeenAt: -1 })
    .limit(Math.min(NOTIFY_PER_CYCLE, room))
    .toArray();

  if (!picks.length) return { sent: 0 };

  const keys = [...new Set(picks.map((p) => `${p.ats}:${p.companyToken}`))];
  const cos = await companies
    .find(
      {
        $or: keys.map((k) => ({
          ats: k.split(":")[0],
          token: k.split(":").slice(1).join(":"),
        })),
      },
      { projection: { ats: 1, token: 1, sponsorship: 1 } },
    )
    .toArray();
  const spBy = new Map(cos.map((c) => [`${c.ats}:${c.token}`, c.sponsorship]));

  let sent = 0;
  for (const job of picks) {
    job.sponsorship = spBy.get(`${job.ats}:${job.companyToken}`) || {};
    try {
      const msg = await send(renderCard(job), {
        keyboard: decisionKeyboard(job._id.toString()),
      });
      await jobs.updateOne(
        { _id: job._id },
        { $set: { notifiedAt: new Date(), tgMessageId: msg.message_id } },
      );
      sent++;
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      log(`  notify failed: ${String(e.message).slice(0, 90)}`);
    }
  }
  if (sent)
    log(
      `notify ${sent} card(s) sent · ${sentToday + sent}/${DAILY_NOTIFY_CAP} today`,
    );
  return { sent };
}

/* ----------------------------------------------------------------- loop */
const me = await whoAmI().catch(() => null);
log(
  `starting · cycle ${CYCLE_SECONDS}s · scoring on ${PROVIDER}/${MODEL} · notify cap ${DAILY_NOTIFY_CAP}/day · bot @${me?.username || "?"}`,
);
log(
  `tier S boards: ${await companies.countDocuments({ tier: "S" })} (${await companies.countDocuments({ isTarget: true })} pinned targets)`,
);

const listener = once ? null : listenForDecisions();
const startedAt = Date.now();

if (once) {
  await Promise.all([
    stagePoll().catch((e) =>
      log(`poll FAILED: ${String(e.message).slice(0, 120)}`),
    ),
    stageScore().catch((e) =>
      log(`score FAILED: ${String(e.message).slice(0, 120)}`),
    ),
  ]);
  await stageNotify().catch((e) =>
    log(`notify FAILED: ${String(e.message).slice(0, 120)}`),
  );
} else {
  // Independent timers, not one serial cycle.
  //
  // Polling is fast (~26s for 600 boards, mostly 304s) and its cadence IS the
  // product — a tier-S board must be checked every 3 minutes. Scoring is
  // rate-limited by a hosted free tier at ~36s/job and takes minutes. Chaining
  // them made the effective poll interval ~8.5 minutes, i.e. the one number
  // that cannot be recovered was being set by the one stage that can wait.
  //
  // Each timer carries an in-flight guard so a slow run is skipped rather than
  // overlapping itself.
  const SCORE_EVERY = Number(process.env.SCORE_CYCLE_SECONDS || 300);
  const tick = async (name, guardRef, fn) => {
    if (guardRef.busy || stopping) return;
    guardRef.busy = true;
    try {
      await fn();
    } catch (e) {
      log(`${name} FAILED: ${String(e.message).slice(0, 120)}`);
    } finally {
      guardRef.busy = false;
    }
  };

  const pollGuard = { busy: false };
  const scoreGuard = { busy: false };

  const pollTimer = setInterval(
    () => tick("poll", pollGuard, stagePoll),
    CYCLE_SECONDS * 1000,
  );
  const scoreTimer = setInterval(
    () =>
      tick("score", scoreGuard, async () => {
        await stageScore();
        await stageNotify();
      }),
    SCORE_EVERY * 1000,
  );

  // Fire both immediately rather than waiting a full interval on startup.
  tick("poll", pollGuard, stagePoll);
  tick("score", scoreGuard, async () => {
    await stageScore();
    await stageNotify();
  });

  while (!stopping) {
    if (stopAfterMs && Date.now() - startedAt >= stopAfterMs) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  clearInterval(pollTimer);
  clearInterval(scoreTimer);
}

stopping = true;
if (listener)
  await Promise.race([listener, new Promise((r) => setTimeout(r, 2000))]);
log("stopped");
await closeDb();
process.exit(0);
