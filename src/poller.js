/**
 * Tiered poller.
 *
 * Design notes:
 *  - `firstSeenAt` is OUR clock and is the only freshness ground truth. A board's
 *    claimed post date is recorded separately as `postedAtClaimed` and never trusted,
 *    because reposting an old req resets it.
 *  - `contentHash` catches those reposts: same company+title+body under a new req id
 *    means a stale posting wearing a fresh date, and it gets deprioritized.
 *  - `clusterKey` collapses one role posted across N locations into one card.
 *  - Conditional GETs mean most tier-S polls cost a 304 with no body.
 */

import { getDb } from "./db.js";
import { fetchBoard, htmlToText } from "./adapters/index.js";
import {
  clusterKey,
  contentHash,
  hostOf,
  normCompany,
} from "./util/normalize.js";
import { screen } from "./filter.js";

// Only postings that clear the deterministic screen are persisted. Storing the
// ~95% that don't would push a full sweep past 1.2M documents — far beyond the
// 512MB free tier — for data we never read. Rejections are still counted in
// poll_log, so coverage auditing is unaffected, and re-screening a board we
// already fetched is pure regex (no network), so nothing is lost by not caching it.
const STORE_SCREENED_OUT = process.env.STORE_SCREENED_OUT === "true";
// Enough JD text for downstream scoring; the signal is in the first ~1000 words.
const MAX_DESC_CHARS = Number(process.env.MAX_DESC_CHARS || 5000);

/**
 * Greenhouse and Amazon hand back HTML, and it was being stored raw and then cut
 * at MAX_DESC_CHARS. Sixteen percent of that budget went to tags and
 * `data-ccp-props` attribute blobs rather than prose, so on a long posting the
 * requirements section — the part that says which language and how many years —
 * fell off the end while "About the Company" boilerplate survived. Four Torc
 * Robotics postings stored exactly 5000 characters each and not one of them
 * reached the qualifications.
 *
 * Converting before the cut buys back that 16% inside the same budget, and every
 * downstream reader benefits: the year and work-authorization regexes get text
 * instead of markup, the pre-rank can see the required stack, and the paid
 * scoring call stops spending tokens on span tags.
 *
 * Conditional, not unconditional: some feeds return plain text that happens to
 * contain an angle bracket, and running the converter over those would eat
 * legitimate characters. Same guard bytedance.js already uses.
 */
const LOOKS_HTML = /<(p|div|span|li|ul|ol|br|strong|em|h[1-6])\b|<\/(p|div|span|li)>/i;

export function descriptionText(raw = "") {
  const s = String(raw || "");
  const text = LOOKS_HTML.test(s) ? htmlToText(s) : s;
  return text.slice(0, MAX_DESC_CHARS);
}

// Burst thresholds, expressed as rates so they mean the same thing at every
// poll cadence. BURST_HOURS is how long a bursting board stays on 3m.
const BURST_PER_HOUR = Number(process.env.BURST_PER_HOUR || 6);
const BURST_HOURS = Number(process.env.BURST_HOURS || 24);
const WARM_MAX_GAP_HOURS = Number(process.env.WARM_MAX_GAP_HOURS || 1.5);

/**
 * Should this board move to burst cadence?
 *
 * Thresholds are RATES, not counts. The same board gaining ten roles means two
 * different things depending on when it was last looked at: over six hours that
 * is ordinary hiring, over three minutes it is a batch drop and the only case
 * worth reacting to. Comparing raw deltas across tiers polled 3m and 6h apart
 * put 44 of 600 boards on burst cadence in a single sweep, nearly all of them
 * slow boards that had simply been unobserved for hours.
 *
 * Two ways to qualify:
 *   "rate" — a genuine batch drop. Counts as a burst event.
 *   "warm" — a single fresh posting on a recently-seen board. Reqs arrive in
 *            clusters, so this earns the faster cadence, but it is not a burst
 *            and is not reported as one. Gated on how recently the board was
 *            observed: "new since last poll" says nothing about clustering now
 *            if the last poll was six hours ago.
 *
 * A board's first successful poll never bursts — that sweep ingests a backlog.
 */
export function burstVerdict({
  prevOpen,
  nowOpen,
  hoursSince,
  inserted = 0,
  perHourThreshold = BURST_PER_HOUR,
  warmMaxGapHours = WARM_MAX_GAP_HOURS,
}) {
  const isFirstSuccessfulPoll = prevOpen === null || prevOpen === undefined;
  if (isFirstSuccessfulPoll || hoursSince === null)
    return { burst: false, reason: "first_poll" };

  if (nowOpen > prevOpen) {
    const delta = nowOpen - prevOpen;
    const perHour = delta / hoursSince;
    const pctPerHour = (prevOpen > 0 ? delta / prevOpen : 1) / hoursSince;
    // Absolute and relative together, so small and large boards both qualify.
    if (delta >= 3 && (perHour >= perHourThreshold || pctPerHour >= 0.2))
      return { burst: true, reason: "rate", perHour, delta };
  }

  if (inserted > 0 && hoursSince <= warmMaxGapHours)
    return { burst: true, reason: "warm" };

  return { burst: false, reason: "quiet" };
}

const TIER_MINUTES = {
  S: Number(process.env.TIER_S_MINUTES || 3),
  A: Number(process.env.TIER_A_MINUTES || 15),
  B: Number(process.env.TIER_B_MINUTES || 60),
  C: Number(process.env.TIER_C_MINUTES || 360),
};

// A board that errors repeatedly gets exponentially colder, capped at 6h.
function backoffMinutes(consecutiveErrors) {
  return Math.min(5 * 2 ** Math.max(0, consecutiveErrors - 1), 360);
}

export function nextPollDelayMinutes(company) {
  if (company.consecutiveErrors > 0)
    return backoffMinutes(company.consecutiveErrors);
  // Burst-aware: a board that just posted gets watched closely for 24h.
  if (company.burstUntil && new Date(company.burstUntil) > new Date()) {
    return Math.min(
      TIER_MINUTES.S,
      TIER_MINUTES[company.tier] ?? TIER_MINUTES.C,
    );
  }
  return TIER_MINUTES[company.tier] ?? TIER_MINUTES.C;
}

/* ---------------------------------------------------------------- ingest */

export async function ingestJobs(
  db,
  company,
  incoming,
  { now = new Date() } = {},
) {
  const jobs = db.collection("jobs");
  // The board's name, unless the posting names its own employer.
  //
  // Every adapter until now fetched one employer's board, so the company record
  // WAS the employer. An aggregator breaks that: The Muse returns roles from
  // thousands of companies through one feed, and taking the feed's name stored
  // 49 jobs — SpaceX Starlink roles among them — as "The Muse — Software
  // Engineering". The employer disappeared, the per-employer cap saw one giant
  // company, and a SpaceX posting could not be matched against SpaceX's own
  // board or against the export-control list.
  const boardName = company.name || company.token;

  if (!incoming.length) {
    return { seen: 0, inserted: 0, reposts: 0, screenedIn: 0, skippedRejects: 0, newJobs: [] };
  }

  const ids = incoming.map((j) => j.sourceJobId);
  const existing = await jobs
    .find(
      {
        ats: company.ats,
        companyToken: company.token,
        sourceJobId: { $in: ids },
      },
      { projection: { sourceJobId: 1 } },
    )
    .toArray();
  const existingIds = new Set(existing.map((e) => e.sourceJobId));

  const fresh = incoming.filter((j) => !existingIds.has(j.sourceJobId));

  // Repost detection: has this exact content appeared before under another id?
  const hashes = fresh.map((j) =>
    contentHash({
      company: j.companyName || boardName,
      title: j.title,
      description: j.description,
      locations: j.locations,
    }),
  );
  const priorByHash = new Map();
  if (hashes.length) {
    const priors = await jobs
      .find(
        { contentHash: { $in: hashes } },
        { projection: { contentHash: 1, firstSeenAt: 1, sourceJobId: 1 } },
      )
      .toArray();
    for (const p of priors) {
      const cur = priorByHash.get(p.contentHash);
      if (!cur || new Date(p.firstSeenAt) < new Date(cur.firstSeenAt))
        priorByHash.set(p.contentHash, p);
    }
  }

  let ops = [];
  let newJobs = [];
  let dupSkipped = 0;
  let reposts = 0;
  let screenedIn = 0;
  let skippedRejects = 0;

  fresh.forEach((j, i) => {
    const cHash = hashes[i];
    const prior = priorByHash.get(cHash);
    const isRepost = Boolean(prior && prior.sourceJobId !== j.sourceJobId);
    if (isRepost) reposts++;

    const verdict = screen({
      title: j.title,
      description: j.description,
      locations: j.locations,
    });
    if (verdict.pass) screenedIn++;

    const claimed = j.postedAtClaimed ? new Date(j.postedAtClaimed) : null;
    const claimedValid =
      claimed && !Number.isNaN(claimed.getTime()) ? claimed : null;

    const doc = {
      ats: company.ats,
      companyToken: company.token,
      companyName: j.companyName || boardName,
      companyNorm: normCompany(j.companyName || boardName),
      sourceJobId: j.sourceJobId,

      title: j.title,
      description: descriptionText(j.description),
      locations: j.locations || [],
      applyUrl: j.applyUrl || "",
      applyHost: hostOf(j.applyUrl || ""),

      // freshness
      firstSeenAt: now,
      lastSeenAt: now,
      postedAtClaimed: claimedValid,
      // how far behind the board's own claimed date we were. Negative or huge
      // values are the signal that a source is re-serving stale listings.
      claimedLagMs: claimedValid
        ? now.getTime() - claimedValid.getTime()
        : null,

      // identity
      contentHash: cHash,
      clusterKey: clusterKey({
        // The employer, so a role reaching us from both its own board and an
        // aggregator collapses into one cluster instead of two.
        company: j.companyName || boardName,
        title: j.title,
        applyUrl: j.applyUrl,
      }),
      isRepost,
      repostOfFirstSeenAt: isRepost ? prior.firstSeenAt : null,

      // deterministic screen
      screen: verdict,
      tier: company.tier,
      status: verdict.pass ? "new" : "screened_out",
    };

    if (verdict.pass || STORE_SCREENED_OUT) {
      ops.push({ insertOne: { document: doc } });
    } else {
      skippedRejects++;
    }
    if (verdict.pass && !isRepost) newJobs.push(doc);
  });

  // Cross-company duplicate guard.
  //
  // The insert path keys on (ats, companyToken, sourceJobId), which is correct
  // for a single board but not for the proprietary adapters: Amazon is polled
  // as five pseudo-companies (amazon-sde, amazon-swe, amazon-ml, ...) whose
  // search results overlap, so one requisition arrives under several tokens and
  // inserts several times. Same clusterKey, same contentHash, same applyUrl.
  //
  // Wasted scoring is the mild consequence. The real one is two applications to
  // the same requisition, which reads as careless to the recruiter who receives
  // both.
  const wantKeys = ops
    .filter((o) => o.insertOne)
    .map((o) => o.insertOne.document.clusterKey)
    .filter(Boolean);
  if (wantKeys.length) {
    const taken = new Set(
      (
        await jobs
          .find({ clusterKey: { $in: wantKeys } }, { projection: { clusterKey: 1 } })
          .toArray()
      ).map((d) => d.clusterKey),
    );
    const seenThisBatch = new Set();
    ops = ops.filter((o) => {
      if (!o.insertOne) return true;
      const k = o.insertOne.document.clusterKey;
      if (!k) return true;
      if (taken.has(k) || seenThisBatch.has(k)) {
        dupSkipped++;
        return false;
      }
      seenThisBatch.add(k);
      return true;
    });
    const kept = new Set(
      ops.filter((o) => o.insertOne).map((o) => o.insertOne.document.clusterKey),
    );
    newJobs = newJobs.filter((d) => !d.clusterKey || kept.has(d.clusterKey));
  }

  // Touch everything we saw so we can detect closures later.
  if (existingIds.size) {
    ops.push({
      updateMany: {
        filter: {
          ats: company.ats,
          companyToken: company.token,
          sourceJobId: { $in: [...existingIds] },
        },
        update: { $set: { lastSeenAt: now } },
      },
    });
  }

  let inserted = 0;
  if (ops.length) {
    try {
      const res = await jobs.bulkWrite(ops, { ordered: false });
      inserted = res.insertedCount || 0;
    } catch (err) {
      // Duplicate-key races are expected when two pollers overlap; everything
      // else should surface.
      if (
        err?.code !== 11000 &&
        !err?.writeErrors?.every((e) => e.code === 11000)
      )
        throw err;
      inserted = err?.result?.insertedCount ?? 0;
    }
  }

  return { seen: incoming.length, inserted, reposts, screenedIn, skippedRejects, dupSkipped, newJobs };
}

/* ------------------------------------------------------------- poll one */

export async function pollCompany(db, company, { now = new Date() } = {}) {
  const startedAt = Date.now();
  const res = await fetchBoard(company);
  const elapsedMs = Date.now() - startedAt;

  const companies = db.collection("companies");
  const set = {
    lastPolledAt: now,
    lastPollMs: elapsedMs,
    lastHttpStatus: res.httpStatus ?? 0,
  };
  let outcome = res.status;
  let ingest = { seen: 0, inserted: 0, reposts: 0, screenedIn: 0, skippedRejects: 0, newJobs: [] };

  if (res.status === "not_modified") {
    set.consecutiveErrors = 0;
    set.lastNotModifiedAt = now;
  } else if (res.status === "ok") {
    set.consecutiveErrors = 0;
    if (res.etag) set.etag = res.etag;
    if (res.lastModified) set.lastModified = res.lastModified;

    ingest = await ingestJobs(db, company, res.jobs, { now });

    const prevOpen = company.openRoles ?? null;
    const nowOpen = res.jobs.length;
    set.openRoles = nowOpen;
    set.lastChangedAt =
      ingest.inserted > 0 ? now : (company.lastChangedAt ?? null);

    const hoursSince = company.lastPolledAt
      ? Math.max((now - new Date(company.lastPolledAt)) / 3_600_000, 1 / 60)
      : null;
    const verdict = burstVerdict({
      prevOpen,
      nowOpen,
      hoursSince,
      inserted: ingest.inserted,
    });
    if (verdict.burst) {
      set.burstUntil = new Date(now.getTime() + BURST_HOURS * 3_600_000);
      if (verdict.reason === "rate") {
        set.lastBurst = {
          at: now,
          from: prevOpen,
          to: nowOpen,
          delta: nowOpen - prevOpen,
          perHour: verdict.perHour,
        };
        outcome = "burst";
      }
    }
  } else {
    set.consecutiveErrors = (company.consecutiveErrors || 0) + 1;
    set.lastError = String(res.error || `http_${res.httpStatus}`).slice(0, 500);
    set.lastErrorAt = now;
  }

  const merged = { ...company, ...set };
  const delayMin = nextPollDelayMinutes(merged);
  // Aggregator feeds are paginated and thousands of pages deep. Remember where
  // this sweep stopped, or every poll re-reads page 1 and the source contributes
  // its first twenty jobs once and nothing ever again.
  if (res.nextPage) set.musePage = res.nextPage;

  set.nextPollAt = new Date(now.getTime() + delayMin * 60_000);

  await companies.updateOne({ _id: company._id }, { $set: set });

  await db.collection("poll_log").insertOne({
    companyKey: `${company.ats}:${company.token}`,
    ats: company.ats,
    token: company.token,
    tier: company.tier,
    startedAt: now,
    elapsedMs,
    outcome,
    httpStatus: res.httpStatus ?? 0,
    partial: res.partial ?? false,
    seen: ingest.seen,
    inserted: ingest.inserted,
    reposts: ingest.reposts,
    screenedIn: ingest.screenedIn,
    skippedRejects: ingest.skippedRejects,
    error: res.error || null,
  });

  return {
    company: `${company.ats}:${company.token}`,
    outcome,
    elapsedMs,
    ...ingest,
    newJobs: ingest.newJobs,
  };
}

/* ------------------------------------------------------------ poll batch */

async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await worker(items[idx]);
        } catch (err) {
          out[idx] = {
            company: `${items[idx].ats}:${items[idx].token}`,
            outcome: "throw",
            error: String(err?.message || err),
          };
        }
      }
    }),
  );
  return out;
}

/**
 * Poll every board that is currently due, most overdue first.
 */
export async function pollDue({
  limit = 500,
  concurrency = Number(process.env.POLL_CONCURRENCY || 12),
} = {}) {
  const db = await getDb();
  const now = new Date();

  const due = await db
    .collection("companies")
    .find({ enabled: { $ne: false }, nextPollAt: { $lte: now } })
    .sort({ nextPollAt: 1 })
    .limit(limit)
    .toArray();

  if (!due.length) return { polled: 0, results: [], startedAt: now };

  const results = await pool(due, concurrency, (c) =>
    pollCompany(db, c, { now: new Date() }),
  );

  const summary = results.reduce(
    (a, r) => {
      a[r.outcome] = (a[r.outcome] || 0) + 1;
      a.inserted += r.inserted || 0;
      a.screenedIn += r.screenedIn || 0;
      a.reposts += r.reposts || 0;
      return a;
    },
    { inserted: 0, screenedIn: 0, reposts: 0 },
  );

  return { polled: due.length, summary, results, startedAt: now };
}
