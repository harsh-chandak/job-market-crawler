/**
 * Local approval page. No external services, no Telegram, no internet.
 *
 *   node scripts/review-server.mjs           this Mac only
 *   node scripts/review-server.mjs --lan     also reachable from your phone
 *
 * Exists because the approval channel should not be the single point of failure
 * for the whole pipeline. ASU campus wifi drops TCP 443 to api.telegram.org, so
 * on that network the loop polls and scores perfectly and nothing can be
 * approved — the one manual step in the system, blocked by a firewall rule
 * nobody here controls.
 *
 * Default binding is 127.0.0.1, so no packet leaves the machine and it works
 * identically on campus wifi, a hotspot, or a plane. --lan trades that for phone
 * access and is token-gated; see the note above LAN below.
 *
 * It writes exactly the fields the Telegram handler writes — decision,
 * decidedAt, submitStatus — so the two are interchangeable and the submit queue
 * cannot tell which one made a call.
 *
 * Nothing here calls a model. Every number on every page is already in the
 * database, including the resume preview, so a long review session costs nothing.
 */

import "dotenv/config";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep, basename } from "node:path";
import { ObjectId } from "mongodb";
import { getDb } from "../src/db.js";
import { loadBank, renderResume } from "../src/tailor.js";
import { addDays, capsStatus, jobCompanyKeys, ladderTerms, searchLinks } from "../src/warm-path.js";

const PORT = Number(process.env.REVIEW_PORT || 7777);

/* ------------------------------------------------------------ LAN exposure */
// --lan binds to 0.0.0.0 so a phone on the same wifi can reach the page.
//
// That turns a loopback-only page into one reachable by every other device on
// the network, and the page can approve job applications. On home wifi that is
// a handful of trusted devices. On campus wifi it is thousands of strangers.
// So LAN mode requires a token: 24 random bytes, persisted so the URL stays
// stable across restarts, checked on every request including the POST.
//
// This is not real authentication and is not pretending to be. It is enough
// that a passer-by scanning the subnet cannot silently approve or bin the
// candidate's applications, which is the actual risk being managed.
const LAN = process.argv.includes("--lan");
const HOST = LAN ? "0.0.0.0" : "127.0.0.1";

const TOKEN_FILE = ".review-token";
let TOKEN = null;
if (LAN) {
  if (existsSync(TOKEN_FILE)) TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
  if (!TOKEN || TOKEN.length < 20) {
    TOKEN = randomBytes(18).toString("base64url");
    writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
  }
}

/** First non-internal IPv4 — the address a phone on the same wifi can reach. */
function lanAddress() {
  for (const list of Object.values(networkInterfaces()))
    for (const n of list || [])
      if (n.family === "IPv4" && !n.internal) return n.address;
  return null;
}

/**
 * Requests from this machine are always allowed.
 *
 * The token exists to stop other devices on the wifi from approving job
 * applications. It was never meant to gate the Mac the server runs on — anyone
 * with a shell here can read .review-token, so demanding it from loopback buys
 * nothing and costs the obvious thing: step 1 enables --lan whenever Telegram is
 * blocked, so opening plain localhost:7777 returned "forbidden" and the page
 * looked broken while 313 scored jobs sat behind it waiting to be reviewed.
 */
function isLoopback(req) {
  const a = req.socket?.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** Token check. Loopback is exempt; ?k= then a cookie for everything else. */
function authorized(req, url) {
  if (!LAN) return true;
  if (isLoopback(req)) return true;
  if (url.searchParams.get("k") === TOKEN) return true;
  const cookie = req.headers.cookie || "";
  return cookie.split(";").some((c) => c.trim() === `rk=${TOKEN}`);
}
const MIN_FIT = Number(process.env.REVIEW_MIN_FIT || process.env.MIN_FIT || 70);

const db = await getDb();
const jobs = db.collection("jobs");
const companies = db.collection("companies");

// The bullet bank, loaded once. Used only by /preview, which renders it against a
// posting with pure functions — no model call, no cost, no network.
let BANK = null;
try {
  BANK = await loadBank();
} catch (err) {
  console.error(`  resume bank unavailable, preview disabled: ${err.message}`);
}

/**
 * Is the E-Verify gate actually checkable right now?
 *
 * STEM OPT's 24-month extension is only available at an E-Verify employer, so
 * this is not a tiebreaker — an employer who sponsors H-1B but is not enrolled
 * quietly costs two years of runway. scripts/enrich-sponsorship.mjs fills
 * sponsorship.eVerify only when data/everify.csv is present, and sets it to null
 * otherwise (see its lines 119-122).
 *
 * Measured on this database: eVerify is null on all 3,539 company rows, because
 * that file has never been supplied. The old card printed "· E-Verify" when the
 * flag was truthy and nothing when it was not, so a gate that has never once
 * been evaluated looked exactly like a gate every employer failed. Counting the
 * rows at boot turns that silence into a banner that says what is missing and
 * how to fix it.
 */
const eVerifyKnownCount = await companies.countDocuments({
  "sponsorship.eVerify": { $ne: null },
});
const companyCount = await companies.estimatedDocumentCount();

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const age = (ms) =>
  ms == null
    ? "age unknown"
    : ms < 3600_000
      ? `${Math.round(ms / 60000)}m old`
      : ms < 86400_000
        ? `${(ms / 3600_000).toFixed(1)}h old`
        : `${Math.round(ms / 86400_000)}d old`;

const shortAge = (ms) =>
  ms == null
    ? "?"
    : ms < 3600_000
      ? `${Math.round(ms / 60000)}m`
      : ms < 86400_000
        ? `${Math.round(ms / 3600_000)}h`
        : `${Math.round(ms / 86400_000)}d`;

/**
 * Two clocks, and only one of them is ours.
 *
 * firstSeenAt is when THIS poller saw the posting. src/poller.js:5-7 calls it
 * "OUR clock and the only freshness ground truth". postedAtClaimed is whatever
 * the board says, and the boards are wildly unreliable about it — median claimed
 * lag by source, measured: Ashby 138 days, Lever 377, SmartRecruiters 2,493,
 * Greenhouse 21.
 *
 * The page used to compute a single age from postedAtClaimed and then make
 * judgements with it. On the live queue that put a red "probably a requisition
 * nobody closed" warning on 23 pending jobs, every one of which this poller had
 * first seen within the previous four days, and every one of them from Ashby. So
 * both are reported, each labelled with its source, and no warning fires on the
 * board's number alone.
 */
const seenAgeMs = (j) =>
  j.firstSeenAt ? Date.now() - new Date(j.firstSeenAt).getTime() : null;
const claimedAgeMs = (j) =>
  j.postedAtClaimed ? Date.now() - new Date(j.postedAtClaimed).getTime() : null;

/**
 * The visa gate, stated in the vocabulary the data actually uses.
 *
 * classifySponsorship (src/sponsorship.js) emits exactly four statuses:
 * 'strong', 'yes', 'cap_exempt', 'none'. This page tested for "yes" and "no".
 * "no" is not a value that function can ever return, so everything except a bare
 * 'yes' fell through to the final branch and rendered as "sponsorship unknown".
 *
 * Measured on the live pending queue: 200 of 263 jobs (76%) were labelled
 * "sponsorship unknown" while having a known federal record — 126 from 'strong'
 * employers (recent, five or more approvals: the best case available) and 74
 * from 'none' employers (no record at all: the worst). The one hard filter in
 * this pipeline could not distinguish its best case from its worst, and showed
 * both as "we didn't check".
 *
 * level drives colour and the ?visa= filter:
 *   ok      sponsored recently and at volume, or cap-exempt
 *   weak    sponsored at some point, but not lately
 *   bad     no federal record found
 *   unknown never enriched
 */
function visa(sp = {}) {
  const n = sp.h1bApprovals || 0;
  const yrs = (sp.years || []).slice(-2).join("/");
  if (sp.status === "cap_exempt")
    return {
      level: "ok",
      short: "cap-exempt",
      long: `cap-exempt employer — files H-1B year-round, no lottery${n ? ` · ${n} approvals` : ""}`,
    };
  if (sp.status === "strong")
    return {
      level: "ok",
      short: `sponsors · ${n}`,
      long: `sponsors H-1B — ${n} approvals, most recently FY${(sp.years || []).slice(-1)[0] || "?"}`,
    };
  if (sp.status === "yes")
    return {
      level: "weak",
      short: `sponsored · ${n}`,
      long: `sponsored before — ${n} approval${n === 1 ? "" : "s"}${yrs ? ` (FY${yrs})` : ""}${sp.confidence === "stale" ? ", nothing recent" : ""}`,
    };
  if (sp.status === "none")
    return {
      level: "bad",
      short: "no H-1B record",
      // The dataset genuinely ends at FY2023 and small or new employers are
      // legitimately absent from it, which classifySponsorship documents. Saying
      // "will not sponsor" would be a stronger claim than the data supports and
      // would bin real opportunities.
      long: "no H-1B record in USCIS data through FY2023 — not proof they refuse, but unverified",
    };
  return {
    level: "unknown",
    short: "not checked",
    long: "sponsorship not checked for this employer",
  };
}

/** E-Verify as three states, because "unknown" is the one it is always in. */
function everify(sp = {}) {
  if (sp.eVerify === true) return { level: "ok", text: "E-Verify ✓" };
  if (sp.eVerify === false) return { level: "bad", text: "not E-Verify" };
  return { level: "unknown", text: "E-Verify unknown" };
}

/**
 * Score bands, calibrated to the scores that exist.
 *
 * The old thresholds were fit >= 84 for the green band and >= 76 for amber. The
 * highest fit anywhere in the pending queue is 82, so the green band had never
 * once rendered and 150 of 263 jobs sat in the undifferentiated bottom band —
 * including all 54 that scored exactly at the floor. A band that never fires and
 * a band holding well over half the queue both cost the same thing: the colour
 * stops carrying information.
 *
 * Live distribution: 70:54  72:42  73:1  74:53  76:39  78:30  80:20  82:24.
 */
const BAND_HI = Number(process.env.REVIEW_BAND_HI || 80);
const BAND_MID = Number(process.env.REVIEW_BAND_MID || 74);
const bandOf = (fit) =>
  fit == null ? "new" : fit >= BAND_HI ? "hi" : fit >= BAND_MID ? "mid" : "lo";

/* ------------------------------------------------------------------- sorts */
// Three orderings, because the two signals genuinely compete: the best match may
// be four days old and already have 200 applicants, and the freshest posting may
// be a poor fit. "balanced" is the one to live in — it is best-match with an age
// penalty, which is the actual decision being made.
const SORTS = {
  match: {
    label: "Best match",
    mongo: { "llmScore.fit": -1, firstSeenAt: -1 },
  },
  // Freshest ignores the fit floor. It has to: the floor only admits jobs the
  // scorer has already reached, so asking for the newest postings and getting
  // two-day-old ones was the honest consequence of a dishonest label. A posting
  // from an hour ago that has not been scored yet is exactly what "freshest"
  // means, and being early is the entire advantage this pipeline exists to buy.
  fresh: {
    label: "Newest found",
    // firstSeenAt, not postedAtClaimed. Sorting the "freshest" view by the
    // board's own date meant the four newest discoveries on the page were not
    // the four newest rows: VIOME (ingested 22:43 today, board says April) and
    // both mistral.ai roles (ingested 19:28 today, board says July) ranked below
    // three postings from two days earlier whose boards happened to date them
    // today. The head start is measured on our clock or it is not measured.
    mongo: { firstSeenAt: -1, "prerank.score": -1 },
    ignoreFitFloor: true,
  },
  balanced: { label: "Balanced", mongo: null },
};
const DEFAULT_SORT = "balanced";

/* ----------------------------------------------------------------- filters */
// Narrowing the queue is not a convenience here. 263 undecided jobs is a week of
// evenings at the rate a card page permits, and the reviewer's answer to "does
// this employer sponsor" changes whether the row is worth ANY attention. So the
// filters that exist are the ones that change the decision: the visa gate, the
// role family, and the score band.
const VISA_FILTERS = {
  all: { label: "All", statuses: null },
  ok: { label: "Sponsors", statuses: ["strong", "yes", "cap_exempt"] },
  strong: { label: "Sponsors a lot", statuses: ["strong", "cap_exempt"] },
  unverified: { label: "Unverified", statuses: ["none", null] },
};
const FAMILIES = { all: "All roles", swe: "SWE", ai: "AI/ML" };

function parseFilters(url) {
  const p = url.searchParams;
  const visaKey = VISA_FILTERS[p.get("visa")] ? p.get("visa") : "all";
  const fam = FAMILIES[p.get("fam")] ? p.get("fam") : "all";
  const minFit = Number(p.get("min")) || 0;
  // Narrowing to one employer. Reached from the burst page, where the useful
  // next question after "this board is dropping roles" is "show me them".
  const co = (p.get("co") || "").trim().slice(0, 64) || null;
  return { visa: visaKey, fam, minFit, co };
}

/**
 * Build a URL from a path, the filter state, and the LAN token.
 *
 * Assembling this by hand produced `/triage&k=…` for every link whose filters
 * were all at their defaults — the "All" and "All roles" reset buttons, which are
 * exactly the ones you press when a filter turns out to be too narrow. There is
 * no `?`, so the whole thing is a path and the server 404s it. One function that
 * owns the separator cannot get that wrong.
 */
/**
 * Carry the token on in-page links in LAN mode.
 *
 * The cookie normally covers it, but a link that only works after the cookie
 * exists is a link that breaks the first time someone shares or bookmarks it. The
 * rule is "the request arrived with ?k=, so keep it" — on loopback no token is
 * needed at all, and stamping one into a page served to this Mac only widens
 * where it can be read from.
 */
const linkToken = (url) =>
  LAN && url.searchParams.get("k") === TOKEN ? TOKEN : "";

function href(path, filters = {}, token = "") {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters))
    if (v != null && v !== "" && v !== "all" && v !== 0) p.set(k, String(v));
  if (token) p.set("k", token);
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * The pending queue, plus the numbers needed to say honestly how much is left.
 *
 * Returns { rows, matching, afterCap, bands } where `matching` is every
 * undecided job the filters admit and `afterCap` is how many survive the
 * per-employer cap. The page used to print rows.length and call it the queue.
 * On the live database /triage rendered 120 rows out of 263 undecided — 125 held
 * behind the 3-per-employer cap and 18 past the page limit — so the header read
 * "120 left", the reviewer cleared it, the counter reached zero and 143 jobs were
 * still undecided with nothing on screen saying so. Progress feedback that
 * undercounts the work is worse than none, because finishing feels like finishing.
 */
async function pending(sort = DEFAULT_SORT, limit = 60, filters = {}) {
  const def = SORTS[sort] || SORTS[DEFAULT_SORT];
  const f = { visa: "all", fam: "all", minFit: 0, ...filters };

  const fitFloor = Math.max(MIN_FIT, f.minFit || 0);
  const match = {
    status: "new",
    decision: { $exists: false },
    // Every optional clause below is an $or, and a JS object literal keeps only
    // the LAST key of a repeated name — so spreading two of them silently threw
    // the first away. Narrowing to one employer discarded the fit floor and the
    // page showed 120 rows where 16 qualified; picking a role family would have
    // done the same. They go in $and, which is what was meant all along.
    $and: [
      def.ignoreFitFloor
        ? {
            // Either it cleared the bar, or it has not been judged yet. Exclude
            // only what was scored and found wanting — showing a fresh 30 would
            // waste the reviewer's attention, but hiding a fresh unscored
            // posting wastes the head start.
            $or: [
              { "llmScore.fit": { $gte: fitFloor } },
              { llmScore: { $exists: false } },
            ],
          }
        : { "llmScore.fit": { $gte: fitFloor } },
      // One employer, by board token or by display name — the burst page knows
      // a token, a person reading the page knows the name.
      ...(f.co ? [{ $or: [{ companyToken: f.co }, { companyNorm: f.co }] }] : []),
      // llmScore.family is the scorer's judgement and screen.roleFamily the
      // cheap keyword one. Either counts: the scorer is absent on unscored rows,
      // and disagreement between them is not a reason to hide a job.
      ...(f.fam !== "all"
        ? [{ $or: [{ "llmScore.family": f.fam }, { "screen.roleFamily": f.fam }] }]
        : []),
    ],
  };
  const projection = {
    title: 1,
    companyName: 1,
    companyToken: 1,
    ats: 1,
    locations: 1,
    applyUrl: 1,
    postedAtClaimed: 1,
    shownAt: 1,
    firstSeenAt: 1,
    llmScore: 1,
    screen: 1,
    prerank: 1,
    description: 1,
    hydratedAt: 1,
    companyNorm: 1,
    resumePath: 1,
  };

  let rows;
  // Over-fetch so the per-company cap still fills the page after trimming, and
  // so the "how much is really left" counters are computed over the whole queue
  // rather than over one page of it.
  const fetchLimit = Math.max(limit * 8, 600);
  if (sort === "balanced") {
    // fit minus an age penalty, capped at 20 points so a strong old match still
    // beats a weak new one. 2 points a day means a week costs 14 — enough to
    // reorder near-ties, not enough to bury a 90 behind a 72.
    //
    // The penalty is measured from firstSeenAt, not from the board's claimed
    // date. 91 of 263 pending jobs claim to be over 45 days old and 23 claim
    // over a year, almost all from Ashby and Lever, whose claimed dates run
    // hundreds of days behind reality — so ranking on that field silently
    // charged the full 20-point penalty to every posting from those boards
    // regardless of when it was actually found. Days-since-we-found-it is also
    // the more useful quantity for a review queue: it surfaces what has been
    // sitting undecided longest.
    rows = await jobs
      .aggregate([
        { $match: match },
        {
          $addFields: {
            _posted: { $ifNull: ["$firstSeenAt", "$postedAtClaimed"] },
          },
        },
        {
          $addFields: {
            _rank: {
              $subtract: [
                "$llmScore.fit",
                {
                  $min: [
                    20,
                    {
                      $multiply: [
                        2,
                        {
                          $divide: [
                            { $subtract: ["$$NOW", "$_posted"] },
                            86400000,
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
        { $sort: { _rank: -1 } },
        { $limit: fetchLimit },
        { $project: projection },
      ])
      .toArray();
  } else {
    rows = await jobs
      .find(match, { projection })
      .sort(def.mongo)
      .limit(fetchLimit)
      .toArray();
  }

  // Sponsorship joins on before the visa filter, because the filter is defined
  // over the company record and not over the job.
  const keys = [...new Set(rows.map((r) => `${r.ats}:${r.companyToken}`))];
  const cos = keys.length
    ? await companies
        .find(
          {
            $or: keys.map((k) => ({
              ats: k.split(":")[0],
              token: k.split(":").slice(1).join(":"),
            })),
          },
          { projection: { ats: 1, token: 1, sponsorship: 1 } },
        )
        .toArray()
    : [];
  const spBy = new Map(
    cos.map((c) => [`${c.ats}:${c.token}`, c.sponsorship || {}]),
  );
  for (const r of rows) {
    r.sponsorship = spBy.get(`${r.ats}:${r.companyToken}`) || {};
    r.visa = visa(r.sponsorship);
    r.everify = everify(r.sponsorship);
  }

  // Band counts over everything the other filters admit, so the visa buttons can
  // show what choosing them would cost. Computed before the visa filter is
  // applied, for the same reason.
  const bands = { all: rows.length, ok: 0, strong: 0, unverified: 0 };
  for (const r of rows) {
    if (r.visa.level === "ok") {
      bands.ok++;
      bands.strong++;
    } else if (r.visa.level === "weak") bands.ok++;
    else bands.unverified++;
  }

  const wanted = VISA_FILTERS[f.visa]?.statuses;
  if (wanted)
    rows = rows.filter((r) => wanted.includes(r.sponsorship?.status ?? null));

  // Count against the database, not the fetched page. rows has already been
  // clamped by fetchLimit, so "matching" was really min(matching, 600) — the
  // header and the progress bar both understated the queue whenever it was
  // deeper than one fetch.
  const matching = await jobs.countDocuments(match);

  // Jobs you have already looked at sink below jobs you have not.
  //
  // Nothing here was duplicated — the cap works and the titles are distinct roles
  // at distinct employers. The complaint was that opening the page shows the same
  // list every time, and that is exactly right: an undecided job stays undecided,
  // so with 247 of them above the bar the same best 120 lead every visit. Six
  // different employers all calling the role "Forward Deployed Engineer" makes one
  // more pass feel like the same pass.
  //
  // Sorting unseen ahead of seen makes each visit surface material the previous
  // visit did not reach, without hiding anything: a seen job still appears, just
  // below the new ones, and still carries its score and sort position within its
  // group.
  rows.sort((a, b) => (a.shownAt ? 1 : 0) - (b.shownAt ? 1 : 0));

  // Collapse the same employer posting the same title twice.
  //
  // Amazon is polled as several pseudo-companies (amazon-sde, amazon-swe,
  // amazon-data-eng), and the same requisition surfaces under more than one of
  // them with a different sourceJobId, so clusterKey does not catch it —
  // "Software Development Engineer, Conversational Ads Experience" appeared twice
  // in one screenful.
  //
  // EXACT titles only, after case and punctuation normalisation. A looser rule is
  // tempting and wrong: an earlier attempt stripped any trailing segment after a
  // comma, which collapsed "Software Engineer, Integrity Foundations" into
  // "Software Engineer, Data Platform" and would have hidden 36 genuinely
  // different jobs while claiming to remove duplicates.
  const titleKey = (r) =>
    `${r.companyNorm || r.companyToken || ""}|${String(r.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()}`;
  const keptTitles = new Set();
  rows = rows.filter((r) => {
    const k = titleKey(r);
    if (keptTitles.has(k)) return false;
    keptTitles.add(k);
    return true;
  });

  // Cap how many openings one employer can occupy.
  //
  // OpenAI alone held 41 of the qualifying jobs, Amazon 37, Ramp 16. They are
  // genuinely distinct postings, so no dedup rule catches them — but nobody
  // applies to 41 roles at one company, and a page that is four-fifths one
  // employer reads as broken and is exhausting to work through. Showing that
  // employer's best few and holding the rest back until those are decided keeps
  // the same jobs available without spending the whole page on one logo.
  // Asking for one employer and then capping that employer at three is the page
  // arguing with the filter. The cap exists to stop one logo eating a mixed
  // page; on a single-employer view there is no mix to protect.
  const perCo = filters.co ? 0 : Number(process.env.REVIEW_MAX_PER_COMPANY || 3);
  let held = 0;
  if (perCo > 0) {
    const seen = new Map();
    rows = rows.filter((r) => {
      // Key on the normalised NAME, not the board token. Amazon is polled as
      // several pseudo-companies (amazon-sde, amazon-swe, amazon-data-eng …), so
      // a token-keyed cap gave each of them its own allowance and Amazon still
      // took eleven of the sixty slots. One employer is one employer regardless
      // of how many boards it runs.
      const k =
        r.companyNorm ||
        String(r.companyName || r.companyToken || "?")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .replace(/(inc|llc|corp|corporation|ltd|limited)$/, "");
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if (n > perCo) held++;
      return n <= perCo;
    });
  }

  return {
    rows: rows.slice(0, limit),
    matching, // undecided jobs the filters admit, uncapped
    afterCap: rows.length,
    held, // withheld by the per-employer cap, not decided
    bands,
    perCo,
  };
}

/**
 * Everything already decided, grouped by what it needs from you now.
 *
 * The pending list answers "should I apply to this"; it says nothing about the
 * applications that followed. After a handoff run the only record was terminal
 * output that scrolled away, so a job the form-filler could not complete looked
 * exactly like one that went through — and four of them sat unnoticed while the
 * remaining URLs were only recoverable by querying the database by hand.
 */
const STAGE = {
  attention: {
    title: "Needs you by hand",
    note: "The filler could not complete these. Open the posting and apply yourself.",
    statuses: [
      "failed_no_form",
      "failed_error",
      "needs_manual_captcha",
      "needs_manual_account",
      "error_giving_up",
      "blocked_fabrication",
    ],
  },
  queued: {
    title: "Waiting in the queue",
    note: "Step 3 will open each of these with the form filled and your resume attached.",
    statuses: ["queued"],
  },
  // "Submitted" held every application that ever went out, live and closed
  // together, so a rejection sat next to something still being considered and
  // the list said nothing about where things stand. Split by outcome.
  live: {
    title: "Live — no reply yet",
    note: "Sent, and the employer has not written back. Nothing here is older than a fortnight, so silence is not yet a signal.",
    statuses: ["submitted"],
    outcomes: [null, "acknowledged"],
  },
  closed: {
    title: "Closed",
    note: "The employer answered and the answer was no.",
    statuses: ["submitted"],
    outcomes: ["rejected"],
  },
  moving: {
    title: "Moving forward",
    note: "Interview, assessment or offer. These are the ones to act on today.",
    statuses: ["submitted"],
    outcomes: ["interview", "assessment", "offer"],
  },
};

/**
 * Boards the poller has moved to a 3-minute cadence because they are dropping
 * roles right now.
 *
 * The loop logs this once per board as it flips and the line scrolls away, so a
 * board that went fast an hour ago is invisible while still being the best place
 * to look. burstUntil lives on the company record; this reads it and pairs each
 * board with what it has actually posted, so the page shows evidence and not a
 * claim.
 */
async function bursts() {
  const now = new Date();
  const co = await companies
    .find({ burstUntil: { $gt: now } },
          { projection: { token: 1, ats: 1, tier: 1, burstUntil: 1, isTarget: 1 } })
    .toArray();
  if (!co.length) return [];
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const agg = await jobs.aggregate([
    { $match: { companyToken: { $in: co.map((c) => c.token) }, firstSeenAt: { $gte: since } } },
    { $group: { _id: "$companyToken", n: { $sum: 1 }, best: { $max: "$llmScore.fit" },
                open: { $sum: { $cond: [{ $eq: [{ $type: "$decision" }, "missing"] }, 1, 0] } } } },
  ]).toArray();
  const by = new Map(agg.map((r) => [r._id, r]));
  return co
    .map((c) => ({ ...c, ...(by.get(c.token) || { n: 0, best: null, open: 0 }),
                   mins: Math.round((new Date(c.burstUntil) - now) / 60000) }))
    .sort((a, b) => b.n - a.n || (b.best ?? -1) - (a.best ?? -1));
}

/**
 * What came back, and what has been out long enough for silence to mean
 * something.
 *
 * The pipeline recorded everything up to the moment of sending and nothing
 * after it, so the one question that matters — is this resume working — had
 * no data behind it. Answered and ripe are kept apart deliberately: an
 * application sent yesterday has not ghosted you, it has not answered yet,
 * and mixing the two produces a "response rate" that only measures how
 * recently you applied.
 */
const RIPE_DAYS = Number(process.env.TRACKER_RIPE_DAYS || 21);

/**
 * Narrow the tracker.
 *
 * 173 rows on one page is a list you scroll past rather than read. The useful
 * questions are all subsets — what is still live, what went quiet, which
 * employer, which role family — so each is a filter rather than a separate page.
 */
const TRACKER_FILTERS = {
  all: { label: "All", match: () => true },
  live: { label: "No reply yet", match: (r) => !r.reply?.state },
  answered: { label: "Answered", match: (r) => !!r.reply?.state },
  rejected: { label: "Rejected", match: (r) => r.reply?.state === "rejected" },
  moving: { label: "Interview / offer", match: (r) => ["interview", "offer"].includes(r.reply?.state) },
  // "Gone quiet" needs an age, not just silence: nothing sent this week has
  // gone quiet, it simply has not answered yet.
  quiet: { label: `Quiet ${RIPE_DAYS}d+`, match: (r) => !r.reply?.state && r.days != null && r.days >= RIPE_DAYS },
};

async function tracker(filters = {}) {
  const rows = await jobs
    .find(
      { submitStatus: { $in: ["submitted"] } },
      {
        projection: {
          companyName: 1, companyToken: 1, companyNorm: 1, title: 1, applyUrl: 1,
          submitAttemptAt: 1, reply: 1, outcome: 1,
          "llmScore.fit": 1, "llmScore.family": 1,
        },
      },
    )
    .sort({ submitAttemptAt: -1 })
    .toArray();

  const now = Date.now();
  const withAge = rows.map((r) => ({
    ...r,
    days: r.submitAttemptAt ? Math.floor((now - new Date(r.submitAttemptAt)) / 864e5) : null,
  }));
  // Stats describe the whole campaign; the table shows the slice you asked for.
  // Recomputing the headline numbers per filter would make "6 answered" change
  // every time you clicked something, which is the opposite of a tracker.
  const def = TRACKER_FILTERS[filters.view] || TRACKER_FILTERS.all;
  const shown = withAge
    .filter(def.match)
    .filter((r) => !filters.co || (r.companyNorm || r.companyToken || "") === filters.co)
    .filter((r) => !filters.fam || (r.llmScore?.family || "?") === filters.fam);

  const answered = withAge.filter((r) => r.reply?.state);
  const ripe = withAge.filter((r) => r.days != null && r.days >= RIPE_DAYS);
  const byState = {};
  for (const r of answered) byState[r.reply.state] = (byState[r.reply.state] || 0) + 1;
  const byFamily = {};
  for (const r of withAge) {
    const f = r.llmScore?.family || "?";
    (byFamily[f] ??= { sent: 0, rejected: 0 }).sent++;
    if (r.reply?.state === "rejected") byFamily[f].rejected++;
  }
  return {
    rows: shown,
    total: withAge.length,
    view: filters.view || "all",
    filters,
    counts: Object.fromEntries(
      Object.entries(TRACKER_FILTERS).map(([k, d]) => [k, withAge.filter(d.match).length]),
    ),
    companies: [...new Set(withAge.map((r) => r.companyNorm || r.companyToken).filter(Boolean))].sort(),
    answered, ripe, byState, byFamily,
    ripeAnswered: ripe.filter((r) => r.reply?.state).length,
  };
}

async function applications() {
  const rows = await jobs
    .find(
      // Scoped by what happened, not by what was decided. Keying on
      // decision:"approved" alone lost any application whose decision later
      // changed — a Scout Motors role that had already been submitted vanished
      // from the list the moment it was marked skipped for asking 8+ years.
      // What went out went out; a later change of mind does not unsend it.
      {
        $or: [
          { decision: "approved" },
          { submitStatus: { $exists: true, $ne: null } },
        ],
      },
      {
        projection: {
          title: 1,
          companyName: 1,
          companyToken: 1,
          applyUrl: 1,
          locations: 1,
          submitStatus: 1,
          submitAttemptAt: 1,
          outcome: 1,
          outcomeAt: 1,
          outcomeSubject: 1,
          submitAttempts: 1,
          submitNotes: 1,
          resumePath: 1,
          llmScore: 1,
        },
      },
    )
    .sort({ submitAttemptAt: -1 })
    .toArray();

  const out = {};
  for (const [key, def] of Object.entries(STAGE))
    out[key] = rows.filter(
      (r) =>
        def.statuses.includes(r.submitStatus) &&
        // A group may also narrow by outcome. null means "no reply yet".
        (!def.outcomes || def.outcomes.includes(r.outcome ?? null)),
    );
  // Anything with a status no group claims still has to be visible, or the page
  // quietly under-reports and is worse than the terminal it replaced.
  const claimed = new Set(Object.values(STAGE).flatMap((d) => d.statuses));
  const shown = new Set(Object.values(out).flat().map((r) => String(r._id)));
  out.other = rows.filter(
    (r) => !claimed.has(r.submitStatus) || !shown.has(String(r._id)),
  );
  return out;
}

function appRow(j, stage) {
  const s = j.llmScore || {};
  const when = j.submitAttemptAt
    ? new Date(j.submitAttemptAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const resume = j.resumePath
    ? `/file?p=${encodeURIComponent(j.resumePath)}`
    : null;
  return `
<tr>
  <td class="fitc">${esc(s.fit ?? "?")}</td>
  <td>
    <div class="co2">${esc(j.companyName || j.companyToken)}</div>
    <div class="ti2">${esc(j.title)}</div>
    ${j.submitNotes?.length && stage === "attention" ? `<div class="why2">${esc(String(j.submitNotes[0]).slice(0, 160))}</div>` : ""}
    ${j.outcome ? `<div class="oc oc-${esc(j.outcome)}">${esc(j.outcome)}${
      j.outcomeAt ? ` · ${new Date(j.outcomeAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""
    }${j.outcomeSubject ? ` — ${esc(String(j.outcomeSubject).slice(0, 70))}` : ""}</div>` : ""}
  </td>
  <td class="acts2">
    <a href="${esc(j.applyUrl || "#")}" target="_blank" rel="noreferrer">posting ↗</a>
    ${resume ? `<a href="${resume}" target="_blank">resume ↗</a>` : `<span class="dim">no resume</span>`}
  </td>
  <td class="whenc">${when ? esc(when) : ""}${j.submitAttempts ? `<div class="dim">${j.submitAttempts} failed</div>` : ""}</td>
</tr>`;
}

const BURSTS_PAGE = (rows, token) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Posting now — ${rows.length} board(s)</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:20px;
      max-width:960px;margin-inline:auto;background:Canvas;color:CanvasText}
 header{display:flex;justify-content:space-between;align-items:baseline;
        border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);
        padding-bottom:10px;margin-bottom:6px}
 h1{font-size:17px;margin:0}
 .filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:10px 0}
 .fbtn{font-size:12.5px;padding:4px 10px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .fbtn.on{background:CanvasText;color:Canvas;border-color:CanvasText}
 .fbtn .c{opacity:.55;font-variant-numeric:tabular-nums}
 .fbtn.on .c{opacity:.7}
 .sel{font:inherit;font-size:12.5px;padding:4px 8px;border-radius:8px;background:Canvas;color:CanvasText;
      border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .showing{font-size:12px;opacity:.6}
 a.nav{font-size:12.5px;padding:5px 11px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .note{font-size:12.5px;opacity:.6;margin:6px 0 14px}
 table{width:100%;border-collapse:collapse}
 th{text-align:left;font:600 11.5px/1 -apple-system,system-ui,sans-serif;opacity:.55;
    text-transform:uppercase;letter-spacing:.04em;padding:0 8px 7px}
 td{padding:9px 8px;border-bottom:1px solid color-mix(in srgb,CanvasText 9%,transparent)}
 .n{font:600 15px/1 ui-monospace,monospace;width:4ch}
 .board{font-weight:600;color:inherit;text-decoration:none;border-bottom:1.5px solid color-mix(in srgb,CanvasText 30%,transparent)}
 .board:hover{border-bottom-color:CanvasText}
 tr:has(.n:empty){opacity:.5}
 .ats{font-size:12px;opacity:.6}
 .pin{font-size:11px;opacity:.75} .dim{opacity:.45}
 .empty{opacity:.6;padding:40px 0;text-align:center}
</style>
<header>
  <h1>⚡ Posting right now</h1>
  <a class="nav" href="${href("/triage", {}, token)}">← triage</a>
</header>
<p class="note">Boards the poller moved to a 3-minute cadence because they are dropping
roles. "New" counts what arrived in the last 24 hours; "open" is how many of those you
have not decided on yet. Click a board to triage just that employer. These are the
postings you can reach before anyone else.</p>
${rows.length === 0 ? `<p class="empty">No board is burst-posting right now.</p>` : `
<table>
<tr><th>Board</th><th>Tier</th><th>New 24h</th><th>Open</th><th>Best fit</th><th>Fast for</th></tr>
${rows.map((r) => `<tr>
  <td><a class="board" href="${href("/triage", { co: r.token, sort: "fresh" }, token)}">${esc(r.token)}</a>${r.isTarget ? ` <span class="pin">★ pinned</span>` : ""}
      <div class="ats">${esc(r.ats)}</div></td>
  <td class="dim">${esc(r.tier || "?")}</td>
  <td class="n">${r.n}</td>
  <td class="n">${r.open || 0}</td>
  <td class="n${r.best == null ? " dim" : ""}">${r.best ?? "—"}</td>
  <td class="dim">${r.mins > 90 ? Math.round(r.mins / 60) + "h" : r.mins + "m"}</td>
</tr>`).join("")}
</table>`}
`;

/* ------------------------------------------------------------- warm path */
// Jobs worth a person, from the same queries as `scripts/warm-path.mjs list`:
// strong jobs not applied to yet, and strong applications under 21 days old
// with no reply. The page finds nobody itself; the search links are for the
// candidate to open, and people are recorded through the warm-path skill.
async function warmRows() {
  const now = new Date();
  const proj = {
    companyName: 1, companyToken: 1, companyNorm: 1, title: 1, applyUrl: 1,
    "llmScore.fit": 1, submitStatus: 1, submitAttemptAt: 1, warmPath: 1, referral: 1,
  };
  const [pendingJobs, sentJobs, people] = await Promise.all([
    jobs
      .find({ status: "new", decision: { $ne: "skipped" }, submitStatus: { $ne: "submitted" }, "llmScore.fit": { $gte: 70 } }, { projection: proj })
      .sort({ "llmScore.fit": -1 }).limit(40).toArray(),
    jobs
      .find({ submitStatus: "submitted", "reply.state": { $exists: false }, outcome: { $ne: "rejected" },
              submitAttemptAt: { $gte: addDays(now, -21) }, "llmScore.fit": { $gte: 70 } }, { projection: proj })
      .sort({ "llmScore.fit": -1 }).limit(40).toArray(),
    db.collection("contacts")
      .find({}, { projection: { name: 1, title: 1, companyKey: 1, status: 1, rung: 1, firstTouchAt: 1, lastTouchAt: 1 } })
      .toArray(),
  ]);
  const terms = BANK ? ladderTerms(BANK) : { schools: [], employers: [] };
  const shape = (j) => {
    const keys = new Set(jobCompanyKeys(j));
    const company = j.companyName || j.companyToken;
    return {
      ...j,
      company,
      known: people.filter((p) => keys.has(p.companyKey)),
      links: searchLinks(company, terms),
      days: j.submitAttemptAt ? Math.floor((now - new Date(j.submitAttemptAt)) / 864e5) : null,
    };
  };
  return { pending: pendingJobs.map(shape), sent: sentJobs.map(shape), caps: capsStatus(people, now) };
}

const warmVerdict = (j) => {
  if (j.referral) return `<span class="wv warm">referred${j.referral.by ? ` by ${esc(j.referral.by)}` : ""}</span>`;
  if (!j.warmPath) return `<span class="wv none">not checked</span>`;
  const cls = j.warmPath.verdict === "cold" ? "cold" : "warm";
  const who = (j.warmPath.people || []).map((p) => esc(p.name)).join(", ");
  return `<span class="wv ${cls}">${esc(j.warmPath.verdict.replace("_", " "))}</span>${who ? `<div class="who">${who}</div>` : ""}`;
};
const linkShort = (l) =>
  l.url.includes("google.com") ? "Google"
    : l.rung === "recruiter" ? "recruiters"
      : l.rung === "alumni" ? l.label.split(" alumni")[0].split(/\s+/).map((w) => w[0]).join("")
        : l.label.replace(/^former /, "").split(" ")[0];

const WARM_PAGE = (w, token) => {
  const table = (rows, applied) => rows.length === 0 ? `<p class="empty">None right now.</p>` : `
<table>
<tr><th>Fit</th><th>Role</th><th>Warm path</th><th>Known there</th><th>Find someone</th></tr>
${rows.map((j) => `<tr>
  <td class="n">${j.llmScore?.fit ?? "?"}</td>
  <td><a class="board" href="${esc(j.applyUrl || "#")}" target="_blank" rel="noreferrer">${esc(j.company)}</a>
      <div class="ats">${esc(j.title)}${applied ? ` · applied ${j.days}d ago` : ""}</div></td>
  <td>${warmVerdict(j)}</td>
  <td>${j.known.length ? j.known.map((p) => `<div class="who">${esc(p.name)}${p.title ? ` · ${esc(p.title)}` : ""}</div>`).join("") : `<span class="dim">—</span>`}</td>
  <td class="links">${j.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer" title="${esc(l.label)}">${esc(linkShort(l))}</a>`).join(" ")}</td>
</tr>`).join("")}
</table>`;
  const c = w.caps;
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Warm path — ${w.pending.length + w.sent.length} job(s)</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:20px;
      max-width:1040px;margin-inline:auto;background:Canvas;color:CanvasText}
 header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;
        border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding-bottom:10px;margin-bottom:6px}
 h1{font-size:17px;margin:0} h2{font-size:14px;margin:22px 0 6px}
 a.nav{font-size:12.5px;padding:5px 11px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .note{font-size:12.5px;opacity:.7;margin:6px 0 10px}
 .caps{font-size:12.5px;margin:0 0 8px;font-variant-numeric:tabular-nums}
 table{width:100%;border-collapse:collapse}
 th{text-align:left;font:600 11.5px/1 -apple-system,system-ui,sans-serif;opacity:.55;text-transform:uppercase;letter-spacing:.04em;padding:0 8px 7px}
 td{padding:9px 8px;border-bottom:1px solid color-mix(in srgb,CanvasText 9%,transparent);vertical-align:top}
 .n{font:600 15px/1 ui-monospace,monospace;width:4ch}
 .board{font-weight:600;color:inherit;text-decoration:none;border-bottom:1.5px solid color-mix(in srgb,CanvasText 30%,transparent)}
 .ats,.who{font-size:12px;opacity:.7}
 .wv{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);white-space:nowrap}
 .wv.warm{border-color:#15803d;color:#15803d;font-weight:600} .wv.cold{opacity:.6} .wv.none{opacity:.5}
 .links a{font-size:12px;color:inherit;margin-right:6px}
 .dim{opacity:.45} .empty{opacity:.6;padding:14px 0}
</style>
<header>
  <h1>🤝 Warm path</h1>
  <span><a class="nav" href="${href("/tracker", {}, token)}">tracker</a> <a class="nav" href="${href("/triage", {}, token)}">← triage</a></span>
</header>
<p class="note">Applications with a person attached get read. For a row below, run <code>/warm-path &lt;company&gt;</code>
in Claude Code: it walks connections, alumni, former colleagues, the recruiter and the hiring manager, and records who it found.
The links are searches you open yourself. Nothing on this page sends anything.</p>
<p class="caps">New people messaged: <b>${c.newToday}/${c.perDay}</b> today · <b>${c.newThisWeek}/${c.perWeek}</b> this week · ${c.openThreads.length} open thread(s)</p>
<h2>Not applied yet · fit 70+</h2>
${table(w.pending, false)}
<h2>Applied under 21 days ago, no reply · a person can still pull these out of the pile</h2>
${table(w.sent, true)}
`;
};

const REPLY_STATES = ["rejected", "interview", "offer", "ghosted"];

const TRACKER_PAGE = (t, token) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tracker — ${t.answered.length}/${t.total} answered</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:20px;
      max-width:1040px;margin-inline:auto;background:Canvas;color:CanvasText}
 header{display:flex;justify-content:space-between;align-items:baseline;
        border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);
        padding-bottom:10px;margin-bottom:14px}
 h1{font-size:17px;margin:0}
 .filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:10px 0}
 .fbtn{font-size:12.5px;padding:4px 10px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .fbtn.on{background:CanvasText;color:Canvas;border-color:CanvasText}
 .fbtn .c{opacity:.55;font-variant-numeric:tabular-nums}
 .fbtn.on .c{opacity:.7}
 .sel{font:inherit;font-size:12.5px;padding:4px 8px;border-radius:8px;background:Canvas;color:CanvasText;
      border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .showing{font-size:12px;opacity:.6}
 a.nav{font-size:12.5px;padding:5px 11px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px}
 .card{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:10px;
       padding:9px 13px;min-width:104px}
 .card b{display:block;font:600 20px/1.2 ui-monospace,monospace}
 .card span{font-size:11.5px;opacity:.6}
 .note{font-size:12.5px;opacity:.62;margin:6px 0 16px}
 table{width:100%;border-collapse:collapse}
 th{text-align:left;font:600 11.5px/1 -apple-system,system-ui,sans-serif;opacity:.55;
    text-transform:uppercase;letter-spacing:.04em;padding:0 8px 7px}
 td{padding:8px;border-bottom:1px solid color-mix(in srgb,CanvasText 9%,transparent);vertical-align:middle}
 .co{font-weight:600} .ti{font-size:12.5px;opacity:.72}
 .fit{font:600 14px/1 ui-monospace,monospace;width:3ch}
 .age{font:12px/1 ui-monospace,monospace;opacity:.6;white-space:nowrap}
 .ripe{color:#c2410c;font-weight:600}
 .btn{font-size:11.5px;padding:3px 8px;border-radius:6px;cursor:pointer;
      border:1px solid color-mix(in srgb,CanvasText 22%,transparent);background:transparent;color:inherit}
 .btn:hover{background:color-mix(in srgb,CanvasText 8%,transparent)}
 .on{background:color-mix(in srgb,CanvasText 16%,transparent);font-weight:600}
 .state{font-size:11.5px;font-weight:600}
 .rejected{color:#b91c1c}.interview{color:#047857}.offer{color:#047857}.ghosted{opacity:.5}
</style>
<header>
  <h1>Application tracker</h1>
  <div><a class="nav" href="${href("/applications", {}, token)}">applications</a>
       <a class="nav" href="${href("/triage", {}, token)}">← triage</a></div>
</header>

<div class="cards">
  <div class="card"><b>${t.rows.length}</b><span>sent</span></div>
  <div class="card"><b>${t.answered.length}</b><span>answered</span></div>
  <div class="card"><b>${t.ripe.length}</b><span>${RIPE_DAYS}+ days old</span></div>
  <div class="card"><b>${t.ripe.length ? Math.round((t.ripeAnswered / t.ripe.length) * 100) + "%" : "—"}</b><span>reply rate (ripe)</span></div>
  ${Object.entries(t.byState).map(([k, v]) => `<div class="card"><b>${v}</b><span>${esc(k)}</span></div>`).join("")}
</div>

<p class="note">Reply rate counts only applications at least ${RIPE_DAYS} days old — anything younger has not
gone quiet, it just has not answered yet. Rate over everything sent would mostly measure how recently you applied.</p>
<nav class="filters">
  ${Object.entries(TRACKER_FILTERS).map(([k, d]) =>
    `<a class="fbtn ${t.view === k ? "on" : ""}" href="${href("/tracker", { ...t.filters, view: k === "all" ? null : k }, token)}">${esc(d.label)} <span class="c">${t.counts[k]}</span></a>`
  ).join("")}
</nav>
<nav class="filters">
  ${["swe", "ai"].map((f) =>
    `<a class="fbtn ${t.filters.fam === f ? "on" : ""}" href="${href("/tracker", { ...t.filters, fam: t.filters.fam === f ? null : f }, token)}">${f}</a>`
  ).join("")}
  <select class="sel" onchange="location.href=this.value">
    <option value="${href("/tracker", { ...t.filters, co: null }, token)}">every employer</option>
    ${t.companies.map((c) =>
      `<option value="${href("/tracker", { ...t.filters, co: c }, token)}"${t.filters.co === c ? " selected" : ""}>${esc(c)}</option>`
    ).join("")}
  </select>
  ${t.rows.length !== t.total ? `<span class="showing">showing ${t.rows.length} of ${t.total}</span>` : ""}
</nav>

<table>
<tr><th>Fit</th><th>Role</th><th>Sent</th><th>Outcome</th></tr>
${t.rows.map((r) => `<tr id="r${r._id}">
  <td class="fit">${esc(r.llmScore?.fit ?? "—")}</td>
  <td>
    <div class="co">${esc(r.companyName || r.companyToken)}</div>
    <div class="ti">${r.applyUrl ? `<a href="${esc(r.applyUrl)}" target="_blank" rel="noopener" style="color:inherit">${esc(r.title)}</a>` : esc(r.title)}</div>
  </td>
  <td class="age ${r.days != null && r.days >= RIPE_DAYS && !r.reply?.state ? "ripe" : ""}">${r.days == null ? "—" : r.days + "d ago"}</td>
  <td>
    ${r.reply?.state ? `<span class="state ${esc(r.reply.state)}">${esc(r.reply.state)}</span> ` : ""}
    ${REPLY_STATES.map((st) => `<button class="btn ${r.reply?.state === st ? "on" : ""}" onclick="mark('${r._id}','${st}')">${st[0].toUpperCase()}</button>`).join("")}
    <button class="btn" onclick="mark('${r._id}','clear')" title="clear">×</button>
  </td>
</tr>`).join("")}
</table>

<script>
async function mark(id, state) {
  const res = await fetch('/reply', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({ id, state }),
  });
  if (res.ok) location.reload();
  else alert('could not record: ' + await res.text());
}
</script>
`;

const APPS_PAGE = (g, token) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Applications — ${g.moving.length} moving, ${g.live.length} live</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:20px;
      max-width:960px;margin-inline:auto;background:Canvas;color:CanvasText}
 header{display:flex;justify-content:space-between;align-items:baseline;
        border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);
        padding-bottom:10px;margin-bottom:6px}
 h1{font-size:17px;margin:0}
 .filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:10px 0}
 .fbtn{font-size:12.5px;padding:4px 10px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .fbtn.on{background:CanvasText;color:Canvas;border-color:CanvasText}
 .fbtn .c{opacity:.55;font-variant-numeric:tabular-nums}
 .fbtn.on .c{opacity:.7}
 .sel{font:inherit;font-size:12.5px;padding:4px 8px;border-radius:8px;background:Canvas;color:CanvasText;
      border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 .showing{font-size:12px;opacity:.6}
 a.nav{font-size:12.5px;padding:5px 11px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
 h2{font-size:14px;margin:26px 0 2px} .note{font-size:12.5px;opacity:.6;margin:0 0 8px}
 table{width:100%;border-collapse:collapse}
 td{padding:9px 8px;border-bottom:1px solid color-mix(in srgb,CanvasText 9%,transparent);vertical-align:top}
 .fitc{font:600 15px/1 ui-monospace,monospace;width:3ch;padding-top:12px}
 .oc{display:inline-block;margin-top:4px;font-size:11.5px;padding:1px 7px;border-radius:99px;
     border:1px solid color-mix(in srgb,CanvasText 22%,transparent);opacity:.85}
 .oc-rejected{border-color:#c2410c;color:#c2410c}
 .oc-interview,.oc-offer{border-color:#15803d;color:#15803d;font-weight:600}
 .oc-assessment{border-color:#a16207;color:#a16207}
 .silent{font-size:12.5px;opacity:.6;margin:4px 0 0}
 .co2{font-size:13.5px;font-weight:600} .ti2{font-size:13px;opacity:.75}
 .why2{font-size:12px;color:#c0392b;margin-top:3px}
 .acts2{white-space:nowrap;width:1%} .acts2 a{font-size:12.5px;margin-right:10px}
 .whenc{font-size:12px;opacity:.6;white-space:nowrap;width:1%;text-align:right}
 .dim{opacity:.5;font-size:11.5px}
 .att h2{color:#c0392b}
 .empty{opacity:.5;font-size:13px;padding:6px 0}
</style>
<header>
  <div><h1>Applications</h1></div>
  <a class="nav" href="${href("/warm", {}, token)}">🤝 warm path</a>
  <a class="nav" href="${href("/bursts", {}, token)}">⚡ posting now</a>
  <a class="nav" href="${href("/", {}, token)}">← pending review</a>
</header>
${["moving", "attention", "queued", "live", "closed", "other"]
  .filter((k) => g[k]?.length || k === "attention")
  .map((k) => {
    const def = STAGE[k] || {
      title: "Other",
      note: "Statuses not covered above.",
    };
    const rows = g[k] || [];
    return `<section class="${k === "attention" ? "att" : ""}">
  <h2>${def.title} — ${rows.length}</h2>
  <p class="note">${def.note}</p>
  ${rows.length ? `<table>${rows.map((r) => appRow(r, k)).join("")}</table>` : `<p class="empty">Nothing here.</p>`}
</section>`;
  })
  .join("")}
`;

/* ------------------------------------------------------- shared UI fragments */

/**
 * The banner that says an entire gate is unmeasured.
 *
 * Shown only when no company row has an E-Verify value at all, which is the
 * current state and was completely invisible before. It names the missing file
 * and the command that consumes it, because "unknown" without a remedy is just
 * noise on a page the reviewer sees a hundred times.
 */
const everifyBanner = () =>
  eVerifyKnownCount > 0
    ? ""
    : `<div class="gate">
  <b>E-Verify is unchecked for every employer.</b> The STEM OPT extension requires an
  E-Verify employer, so this is a hard gate, and nothing on this page can currently
  evaluate it — <code>data/everify.csv</code> is missing, so
  <code>scripts/enrich-sponsorship.mjs</code> leaves the flag null on all
  ${companyCount.toLocaleString()} company rows. H-1B history below is real; E-Verify
  enrolment is simply not known. Drop the E-Verify participating-employer list at
  <code>data/everify.csv</code> and re-run that script to close it.
</div>`;

const GATE_CSS = `
 .gate{border:1px solid #b8860b;background:color-mix(in srgb,#b8860b 10%,transparent);
       border-radius:8px;padding:9px 12px;margin:0 0 14px;font-size:12.5px;line-height:1.5}
 .gate code{font:11.5px ui-monospace,monospace;background:color-mix(in srgb,CanvasText 10%,transparent);
            padding:1px 4px;border-radius:3px}
 .v{font-weight:600}
 .v.ok{color:#2e9e4f} .v.weak{color:#b8860b} .v.bad{color:#c0392b} .v.unknown{opacity:.6}
 .ev.ok{color:#2e9e4f} .ev.bad{color:#c0392b} .ev.unknown{opacity:.55}
`;

/**
 * Keyboard triage.
 *
 * The card view is right for deciding one job carefully and wrong for deciding two
 * hundred. 357 jobs cleared the bar and 233 sat undecided, which is not a shortage
 * of matches — it is a review rate problem, and a page that shows one job per
 * screen-height guarantees it never clears.
 *
 * One line per job, the cursor moves with j/k, a approves and s skips, and the
 * decision posts without a reload so the next job is already under the cursor.
 * Everything needed to judge is on the line: score, employer, title, age,
 * sponsorship, and the single strongest reason and gap. `w` opens the full
 * scoring rationale in place and `r` opens the resume this posting would get,
 * both from data already in the page or already in the database — no model call
 * either way.
 */
const TRIAGE_PAGE = (q, sort, filters, token) => {
  const { rows, matching, afterCap, held, bands, perCo } = q;
  const base = {
    sort: sort === DEFAULT_SORT ? null : sort,
    visa: filters.visa,
    fam: filters.fam,
    min: filters.minFit,
    // Carried through every sort and filter link. Left out, changing the sort
    // while narrowed to one employer silently widened the page back to all of
    // them, which reads as the filter having failed.
    co: filters.co,
  };
  const link = (over) => href("/triage", { ...base, ...over }, token);
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Triage — ${rows.length} of ${matching}</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:16px 20px 60px;
      max-width:1100px;margin-inline:auto;background:Canvas;color:CanvasText}
 header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;
        border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding-bottom:8px}
 h1{font-size:16px;margin:0}
 .keys{font-size:12px;opacity:.65}
 kbd{font:11px ui-monospace,monospace;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);
     border-radius:4px;padding:1px 5px;margin:0 1px}
 ol{list-style:none;margin:10px 0 0;padding:0}
 li{display:grid;grid-template-columns:2.6ch 1fr auto;gap:12px;padding:7px 10px;border-radius:7px;
    border:1px solid transparent;align-items:baseline}
 li.on{border-color:color-mix(in srgb,CanvasText 35%,transparent);background:color-mix(in srgb,CanvasText 7%,transparent)}
 li.gone{opacity:.35}
 li[data-novisa]{border-left:3px solid #c0392b}
 .f{font:600 14px/1 ui-monospace,monospace;text-align:right}
 .f.hi{color:#2e9e4f} .f.mid{color:#b8860b} .f.lo{opacity:.75}
 .t{font-weight:600} .c{opacity:.75}
 .m{font-size:12px;opacity:.6;margin-top:2px}
 .g{font-size:12px;color:#b8860b}
 .r{font-size:12px;white-space:nowrap;opacity:.6;text-align:right}
 .done{font-size:12px;font-weight:600}
 .done.a{color:#2e9e4f} .done.s{opacity:.5} .done.x{color:#c0392b}
 .why{display:none;grid-column:2/4;margin:6px 0 2px;font-size:12.5px;
      border-left:2px solid color-mix(in srgb,CanvasText 20%,transparent);padding-left:10px}
 li.open .why{display:block}
 .why b{font-weight:600;opacity:.8}
 .why ul{margin:2px 0 6px;padding-left:16px} .why li{display:list-item;padding:0;border:0}
 .chips{display:flex;flex-wrap:wrap;gap:4px;margin:3px 0 6px}
 .chip{font:11px ui-monospace,monospace;border:1px solid color-mix(in srgb,#2e9e4f 45%,transparent);
       border-radius:99px;padding:1px 7px;color:#2e9e4f}
 .chip.gap{border-color:color-mix(in srgb,#b8860b 50%,transparent);color:#b8860b}
${GATE_CSS}
 .filters{display:flex;gap:5px;flex-wrap:wrap;margin:12px 0 0}
 .fbtn{font-size:12px;padding:4px 10px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent);opacity:.7}
 .fbtn.on{opacity:1;font-weight:600;background:color-mix(in srgb,CanvasText 12%,transparent);
          border-color:color-mix(in srgb,CanvasText 45%,transparent)}
 .fsep{width:1px;background:color-mix(in srgb,CanvasText 18%,transparent);margin:2px 5px}
 .bar{position:fixed;left:0;right:0;bottom:0;background:color-mix(in srgb,Canvas 92%,CanvasText);
      border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding:7px 20px;
      font-size:12.5px;display:flex;gap:14px;align-items:center;justify-content:space-between}
 .track{flex:1;height:6px;border-radius:99px;background:color-mix(in srgb,CanvasText 12%,transparent);overflow:hidden;max-width:420px}
 .fill{height:100%;width:0;background:#2e9e4f;transition:width .2s}
 .eta{opacity:.65;white-space:nowrap}
 footer{margin-top:14px;font-size:12.5px;opacity:.7}
 a{color:inherit}
 #bulk{display:none;margin-top:20px;padding:14px;border:1px dashed color-mix(in srgb,CanvasText 30%,transparent);
       border-radius:8px;font-size:13px}
</style>
<header>
  <h1>Triage — <span id="left">${rows.length}</span> on this page${
    filters.co
      ? ` <span style="font-weight:400;opacity:.65">· ${esc(filters.co)}</span> <a style="font-size:12px;font-weight:400" href="${href("/triage", { ...base, co: null }, token)}">clear</a>`
      : ""
  }</h1>
  <div class="keys"><kbd>j</kbd><kbd>k</kbd> move · <kbd>a</kbd> apply · <kbd>s</kbd> skip ·
     <kbd>w</kbd> why · <kbd>r</kbd> resume · <kbd>o</kbd> open · <kbd>u</kbd> undo ·
     <a href="${href("/warm", {}, token)}">🤝 warm path</a> ·
     <a href="${href("/bursts", {}, token)}">⚡ posting now</a> ·
     <a href="${href("/tracker", {}, token)}">tracker</a> ·
     <a href="${href("/", base, token)}">cards →</a></div>
</header>
${everifyBanner()}
<div class="filters">
  ${Object.entries(VISA_FILTERS)
    .map(
      ([k, v]) =>
        `<a class="fbtn${filters.visa === k ? " on" : ""}" href="${link({ visa: k })}">${v.label}${
          bands[k] != null && k !== "all"
            ? ` ${bands[k]}`
            : k === "all"
              ? ` ${bands.all}`
              : ""
        }</a>`,
    )
    .join("")}
  <span class="fsep"></span>
  ${Object.entries(FAMILIES)
    .map(
      ([k, v]) =>
        `<a class="fbtn${filters.fam === k ? " on" : ""}" href="${link({ fam: k })}">${v}</a>`,
    )
    .join("")}
  <span class="fsep"></span>
  ${[0, BAND_MID, BAND_HI]
    .map(
      (m) =>
        `<a class="fbtn${(filters.minFit || 0) === m ? " on" : ""}" href="${link({ min: m })}">${m ? `${m}+` : `${MIN_FIT}+`}</a>`,
    )
    .join("")}
  <span class="fsep"></span>
  ${Object.entries(SORTS)
    .map(
      ([k, v]) =>
        `<a class="fbtn${sort === k ? " on" : ""}" href="${link({ sort: k })}">${v.label}</a>`,
    )
    .join("")}
</div>
<ol id="list">
${rows
  .map((j, i) => {
    const s = j.llmScore || {};
    const v = j.visa;
    const ev = j.everify;
    const seen = seenAgeMs(j);
    const claimed = claimedAgeMs(j);
    const band = bandOf(s.fit);
    const pr = j.prerank?.signals || {};
    const why = [
      s.reasons?.length
        ? `<b>why ${s.fit}</b><ul>${s.reasons
            .slice(0, 4)
            .map((r) => `<li>${esc(r)}</li>`)
            .join("")}</ul>`
        : "",
      s.matched?.length
        ? `<b>matched</b><div class="chips">${s.matched
            .slice(0, 10)
            .map((m) => `<span class="chip">${esc(m)}</span>`)
            .join("")}</div>`
        : "",
      s.gaps?.length
        ? `<b>gaps</b><div class="chips">${s.gaps
            .slice(0, 6)
            .map(
              (m) =>
                `<span class="chip gap">${esc(String(m).slice(0, 60))}</span>`,
            )
            .join("")}</div>`
        : "",
      `<b>visa</b> ${esc(v.long)} · <span class="ev ${ev.level}">${esc(ev.text)}</span>`,
      `<br><b>signals</b> triage ${esc(j.prerank?.score ?? "?")}${
        pr.overlap != null
          ? ` · stack overlap ${Math.round(pr.overlap * 100)}%`
          : ""
      }${pr.yearsRequired != null ? ` · asks ${pr.yearsRequired}y` : ""}${
        s.seniorityFit ? ` · seniority ${esc(s.seniorityFit)}` : ""
      }${s.sponsorshipSignal ? ` · JD is ${esc(s.sponsorshipSignal)} on work auth` : ""} · seen ${esc(shortAge(seen))} ago · board dates it ${esc(shortAge(claimed))} ago · ${esc(j.ats)}`,
      (j.locations || []).length > 1
        ? `<br><b>also</b> ${esc(j.locations.slice(1, 4).join(" · "))}`
        : "",
    ]
      .filter(Boolean)
      .join("");
    return `<li data-id="${j._id}" data-url="${esc(j.applyUrl)}"${
      i === 0 ? ' class="on"' : ""
    }${v.level === "bad" ? " data-novisa=1" : ""}>
  <span class="f ${band}">${esc(s.fit ?? "·")}</span>
  <span>
    <span class="t">${esc(j.title)}</span> <span class="c">· ${esc(j.companyName || j.companyToken)}</span>
    <div class="m"><span class="v ${v.level}">${esc(v.short)}</span> · <span class="ev ${ev.level}">${esc(ev.text)}</span> · ${esc(
      (j.locations || [])[0] || "location unknown",
    )}${s.reasons?.[0] ? ` · ${esc(String(s.reasons[0]).slice(0, 70))}` : ""}</div>
    ${s.gaps?.[0] ? `<div class="g">⚠ ${esc(String(s.gaps[0]).slice(0, 88))}</div>` : ""}
  </span>
  <span class="r">${esc(shortAge(seen))}<span class="done"></span></span>
  <div class="why">${why}</div>
</li>`;
  })
  .join("")}
</ol>
<div id="bulk">
  <b>Page cleared.</b>
  <span id="bulkmsg"></span>
</div>
<footer>Decisions save as you go. Approved jobs appear in step 3; nothing is sent from here.
Nothing on this page calls a model — the resume preview included.</footer>
<div class="bar">
  <span id="count">0 decided</span>
  <span class="track"><span class="fill" id="fill"></span></span>
  <span class="eta" id="eta"></span>
</div>
<script>
const TOTALS = { page:${rows.length}, matching:${matching}, afterCap:${afterCap}, held:${held}, perCo:${perCo} };
const list=document.getElementById('list');
const items=[...list.children];
let i=0, last=null, decided=0;
const t0=Date.now();
const show=()=>{items.forEach((el,n)=>el.classList.toggle('on',n===i));
  items[i]?.scrollIntoView({block:'center',behavior:'smooth'});};
const nextLive=(from,dir)=>{let n=from;while(n>=0&&n<items.length){if(!items[n].classList.contains('gone'))return n;n+=dir;}return from;};
/* After a decision "next" means the next row that still needs one - forward
   first, then wrapping to anything left above the cursor.

   Without the wrap the cursor walks off the bottom, parks on a row that is
   already decided, and every further keystroke is a no-op because decide()
   returns early on a gone row. Any row the cursor had scrolled past with j
   became permanently unreachable: measured on a five-row page, pressing s seven
   times decided four rows and left the first one undecided forever, with the
   counter stuck at "1 on page" and the cleared panel never shown. A page that
   cannot be finished is the exact failure the progress bar exists to rule out. */
const nextPending=(from)=>{
  for(let n=from;n<items.length;n++) if(!items[n].classList.contains('gone')) return n;
  for(let n=0;n<items.length;n++) if(!items[n].classList.contains('gone')) return n;
  return from;
};

/* Progress that counts the queue, not the page.
   The old header printed the row count and called it "left". This shows what was
   decided, what is left on this page, and — the part that was missing — how many
   undecided jobs exist behind the per-employer cap, so clearing the page does not
   read as clearing the queue. */
function progress(){
  const left=items.filter(x=>!x.classList.contains('gone')).length;
  document.getElementById('left').textContent=left;
  const pct=TOTALS.page? (decided/TOTALS.page*100):0;
  document.getElementById('fill').style.width=pct.toFixed(1)+'%';
  const rate=decided? (Date.now()-t0)/decided : 0;
  const remainingQueue = TOTALS.matching - decided;
  document.getElementById('count').textContent =
    decided+' decided · '+left+' on page · '+remainingQueue+' undecided in queue';
  document.getElementById('eta').textContent =
    decided>2 && left ? Math.ceil(rate*left/60000)+' min to finish this page · '+Math.ceil(rate*remainingQueue/60000)+' min for the whole queue'
    : decided>2 ? 'page done' : '';
  if(!left) finish();
}
function finish(){
  const b=document.getElementById('bulk');
  const still=TOTALS.matching-decided;
  document.getElementById('bulkmsg').innerHTML = still>0
    ? still+' job'+(still===1?'':'s')+' still undecided'+
      (TOTALS.held? ' — '+TOTALS.held+(TOTALS.held===1?' of them was':' of them were')+
        ' held back by the '+TOTALS.perCo+'-per-employer cap, so no single company could fill the page' : '')+
      '. <a href="">Reload for the next batch</a>.'
    : 'The whole queue is decided. Leave the loop running and come back.';
  b.style.display='block';
  b.scrollIntoView({block:'center',behavior:'smooth'});
}
async function decide(el,d){
  if(!el||el.classList.contains('gone'))return;
  const tag=el.querySelector('.done');
  el.classList.add('gone');
  tag.textContent = d==='approved' ? '  ✓ applying' : '  skipped';
  tag.className='done '+(d==='approved'?'a':'s');
  last={el,d}; decided++; progress();
  /* A rejected write must not look like an accepted one. The page is rendered
     once and worked for a long session, so a job can be approved and submitted
     from Telegram in the meantime; the server refuses to re-queue anything
     already sent and returns 409, and the row says so instead of silently
     claiming success. */
  try{
    const res=await fetch('/decide',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:el.dataset.id,decision:d})});
    if(!res.ok){
      const msg=await res.text().catch(()=>'failed');
      tag.textContent='  ⚠ '+msg.slice(0,40); tag.className='done x';
      if(res.status===409) last=null;
    }
  }catch(e){ tag.textContent='  ⚠ not saved'; tag.className='done x'; }
}
addEventListener('keydown',async e=>{
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const k=e.key.toLowerCase();
  if(k==='j'){e.preventDefault();i=nextLive(Math.min(i+1,items.length-1),1);show();}
  else if(k==='k'){e.preventDefault();i=nextLive(Math.max(i-1,0),-1);show();}
  else if(k==='a'||k==='s'){e.preventDefault();
    /* Fire the write, do not wait for it.
       This awaited the POST before advancing the cursor, so the index still
       pointed at the row being decided for the whole round trip, and any key
       pressed during
       it acted on that row — decide() sees it already marked gone and returns
       silently. Measured with synthetic keystrokes: five presses on a five-row
       page decided four rows and dropped one, with no error anywhere. Triage
       exists to be typed at speed, so a handler that drops input under speed is
       broken at the one thing it is for. decide() marks the row and updates the
       counters synchronously before it awaits, so advancing immediately is safe
       and a failed write still lands its warning on the right row. */
    decide(items[i],k==='a'?'approved':'skipped');
    i=nextPending(Math.min(i+1,items.length-1));show();}
  else if(k==='o'){e.preventDefault();window.open(items[i]?.dataset.url,'_blank','noreferrer');}
  else if(k==='w'){e.preventDefault();items[i]?.classList.toggle('open');
    items[i]?.scrollIntoView({block:'center',behavior:'smooth'});}
  else if(k==='r'){e.preventDefault();
    /* The resume this posting would get. Rendered from resume/bullets.yaml
       ranked against the posting text — deterministic, no model, no cost. */
    if(items[i]) window.open('/preview?id='+items[i].dataset.id,'_blank');}
  else if(k==='u'&&last){e.preventDefault();
    /* Claim the undo synchronously for the same reason: two quick presses of u
       would otherwise both read the same saved row and post the undo twice. */
    const el=last.el; last=null;
    el.classList.remove('gone');el.querySelector('.done').textContent='';
    decided=Math.max(0,decided-1); progress();
    const res=await fetch('/decide',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id:el.dataset.id,decision:'undo'})}).catch(()=>null);
    if(res&&!res.ok){const m=await res.text().catch(()=>'failed');
      el.querySelector('.done').textContent='  ⚠ '+m.slice(0,40);
      el.querySelector('.done').className='done x';}}
});
show();progress();
</script>`;
};

function card(j) {
  const s = j.llmScore || {};
  const v = j.visa;
  const ev = j.everify;
  const unscored = s.fit == null;
  // Workday and SmartRecruiters return listings without bodies, so an unhydrated
  // stub was pre-ranked against an empty string: this Truist FDE scored 43 with
  // the reasons "little stack overlap" and "thin description", and the same job
  // jumps to the eighties once its body arrives. Printing 43 would be worse than
  // printing nothing, because a number reads as a measurement.
  const stub = (j.description || "").length <= 400;
  const band = unscored ? "new" : bandOf(s.fit);
  // Age tiers, because "old" means two different things — and because only one of
  // the two available dates is ours.
  //
  // An earlier version called anything over 60 days "likely a dead requisition".
  // That was wrong and would have been expensive: OpenAI's FDE NYC req is
  // genuinely 271 days old and actively hired, because a large employer running
  // a volume pipeline leaves the posting published and reviews in rolling
  // batches. Long-open is not dead. What it does mean is that being early — the
  // entire premise of this system — is no longer available on that req.
  //
  // The second correction is whose clock decides. Judging staleness on
  // postedAtClaimed alone put the red warning on 23 pending jobs that this poller
  // had first seen within four days, every one from Ashby, whose claimed dates
  // run a median 138 days behind. So the warning now needs both signals to agree:
  // the board says it is ancient AND we have been watching it sit there. A board
  // date with no corroboration is reported as what it is — the board's opinion.
  const seen = seenAgeMs(j);
  const claimed = claimedAgeMs(j);
  const seenDays = seen == null ? null : seen / 86400_000;
  const claimedDays = claimed == null ? null : claimed / 86400_000;
  const tier =
    claimedDays != null &&
    claimedDays > 365 &&
    seenDays != null &&
    seenDays > 30
      ? "old"
      : seenDays != null && seenDays > 21
        ? "sitting"
        : claimedDays != null && claimedDays > 45
          ? "claimold"
          : null;
  return `
<article class="card ${band}${v.level === "bad" ? " novisa" : ""}" id="j${j._id}">
  <div class="row">
    <span class="fit">${unscored ? `<span class="pre">${stub ? "·" : esc(j.prerank?.score ?? "·")}</span>` : esc(s.fit)}</span>
    <div class="who">
      <h2>${esc(j.title)}</h2>
      <p class="co">${esc(j.companyName || j.companyToken)} · ${esc((j.locations || [])[0] || "location unknown")}${j.screen?.location?.phoenix ? " · 📍PHX" : ""}</p>
      <p class="visa"><span class="v ${v.level}">${esc(v.long)}</span> · <span class="ev ${ev.level}">${esc(ev.text)}</span></p>
      <p class="meta">${
        unscored
          ? `<span class="unscored">${stub ? "awaiting description" : `triage ${esc(j.prerank?.score ?? "?")}, not scored yet`}</span>` +
            (j.screen?.roleFamily ? ` · ${esc(j.screen.roleFamily)}` : "")
          : `${esc(s.verdict || "")} · ${esc(s.family || "")}${s.seniorityFit ? ` · seniority ${esc(s.seniorityFit)}` : ""}`
      } · found ${esc(age(seen))}<span class="dim"> · board dates it ${esc(age(claimed))}</span></p>
    </div>
  </div>
  ${
    // Why it scored what it scored, not just the first line of it. The scorer
    // returns up to four reasons, the skills it actually matched, and the gaps;
    // the card printed reasons[0] and gaps[0] and dropped the rest, which is the
    // difference between a number with a justification and a number with a
    // caption.
    s.reasons?.length
      ? `<ul class="why">${s.reasons
          .slice(0, 3)
          .map((r) => `<li>${esc(r)}</li>`)
          .join("")}</ul>`
      : ""
  }
  ${
    s.matched?.length
      ? `<div class="chips">${s.matched
          .slice(0, 10)
          .map((m) => `<span class="chip">${esc(m)}</span>`)
          .join("")}</div>`
      : ""
  }
  ${
    tier === "old"
      ? `<p class="gap">⚠ the board has dated this ${esc(age(claimed))} and we have been seeing it for ${esc(age(seen))} — probably a requisition nobody closed. Check it is still live before spending an application.</p>`
      : tier === "sitting"
        ? `<p class="note">we found this ${esc(age(seen))} and it is still open — applying is fine, but you are no longer early</p>`
        : tier === "claimold"
          ? `<p class="note">the board dates this ${esc(age(claimed))}, but we only found it ${esc(age(seen))} — ${esc(j.ats)} dates run far behind, so treat the board's number as unreliable</p>`
          : ""
  }
  ${
    s.gaps?.length
      ? `<div class="chips">${s.gaps
          .slice(0, 4)
          .map(
            (g) =>
              `<span class="chip gap">⚠ ${esc(String(g).slice(0, 70))}</span>`,
          )
          .join("")}</div>`
      : ""
  }
  <div class="acts">
    <a class="btn open" href="${esc(j.applyUrl)}" target="_blank" rel="noreferrer">open posting ↗</a>
    <a class="btn" href="/preview?id=${j._id}" target="_blank">resume preview ↗</a>
    <button class="btn yes" data-id="${j._id}" data-d="approved">✅ apply</button>
    <button class="btn no"  data-id="${j._id}" data-d="skipped">⏭ skip</button>
  </div>
</article>`;
}

const PAGE = (q, sort, filters, token) => {
  const { rows, matching, held, bands, perCo } = q;
  const base = {
    sort: sort === DEFAULT_SORT ? null : sort,
    visa: filters.visa,
    fam: filters.fam,
    min: filters.minFit,
  };
  const link = (over) =>
    href("/", { ...base, ...over }, token);
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review — ${matching} pending</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:20px;
      max-width:820px;margin-inline:auto;background:Canvas;color:CanvasText}
 header{display:flex;justify-content:space-between;align-items:baseline;
        border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);
        padding-bottom:10px;margin-bottom:14px}
 h1{font-size:17px;margin:0} .sub{opacity:.6;font-size:13px}
 .card{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:10px;
       padding:14px 16px;margin-bottom:12px}
 .card.hi{border-left:4px solid #2e9e4f} .card.mid{border-left:4px solid #b8860b}
 .card.lo{border-left:4px solid color-mix(in srgb,CanvasText 25%,transparent)}
 .card.new{border-left:4px solid #4a7fd4}
 .card.novisa{background:color-mix(in srgb,#c0392b 4%,transparent)}
 .unscored{color:#4a7fd4;font-weight:600}
 .fit .pre{color:#4a7fd4;font-weight:500}
 .row{display:flex;gap:14px;align-items:flex-start}
 .fit{font:600 22px/1 ui-monospace,monospace;min-width:2.4ch;text-align:right;padding-top:2px}
 h2{font-size:15px;margin:0 0 3px} .co{margin:0;font-size:13.5px}
 .visa{margin:3px 0 0;font-size:12.5px}
 .meta{margin:3px 0 0;font-size:12.5px;opacity:.65}
 .dim{opacity:.7}
 ul.why{margin:9px 0 0;padding-left:17px;font-size:13px;opacity:.85}
 ul.why li{margin:1px 0}
 .chips{display:flex;flex-wrap:wrap;gap:4px;margin:7px 0 0}
 .chip{font:11px ui-monospace,monospace;border:1px solid color-mix(in srgb,#2e9e4f 45%,transparent);
       border-radius:99px;padding:1px 7px;color:#2e9e4f}
 .chip.gap{border-color:color-mix(in srgb,#b8860b 50%,transparent);color:#b8860b}
 .gap{margin:6px 0 0;font-size:12.5px;color:#b8860b}
 .acts{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
 .btn{font:inherit;font-size:13px;padding:7px 13px;border-radius:7px;cursor:pointer;
      border:1px solid color-mix(in srgb,CanvasText 22%,transparent);
      background:color-mix(in srgb,CanvasText 5%,transparent);color:inherit;text-decoration:none}
 .btn:hover{background:color-mix(in srgb,CanvasText 11%,transparent)}
 .yes{border-color:#2e9e4f} .no{opacity:.75}
 .done{opacity:.35}
 .empty{opacity:.6;padding:40px 0;text-align:center}
 .stale{color:#c0392b;font-weight:600}
 .note{margin:6px 0 0;font-size:12.5px;opacity:.6}
 .sorts{display:flex;gap:6px;flex-wrap:wrap}
 .sortbtn{font-size:12.5px;padding:5px 11px;border-radius:99px;text-decoration:none;color:inherit;
          border:1px solid color-mix(in srgb,CanvasText 20%,transparent);opacity:.7}
 .sortbtn:hover{opacity:1;background:color-mix(in srgb,CanvasText 8%,transparent)}
 .sortbtn.on{opacity:1;font-weight:600;background:color-mix(in srgb,CanvasText 12%,transparent);
             border-color:color-mix(in srgb,CanvasText 45%,transparent)}
 .filters{display:flex;gap:5px;flex-wrap:wrap;margin:0 0 14px}
 .fbtn{font-size:12px;padding:4px 10px;border-radius:99px;text-decoration:none;color:inherit;
       border:1px solid color-mix(in srgb,CanvasText 20%,transparent);opacity:.7}
 .fbtn.on{opacity:1;font-weight:600;background:color-mix(in srgb,CanvasText 12%,transparent);
          border-color:color-mix(in srgb,CanvasText 45%,transparent)}
 .fsep{width:1px;background:color-mix(in srgb,CanvasText 18%,transparent);margin:2px 5px}
${GATE_CSS}
 @media(max-width:560px){header{flex-direction:column;gap:10px;align-items:flex-start}}
</style>
<header>
  <div>
    <h1>Pending review</h1>
    <span class="sub">${
      sort === "fresh"
        ? `${rows.length} shown of ${matching} newest found, scored or not`
        : `${rows.length} shown of ${matching} at fit ≥ ${Math.max(MIN_FIT, filters.minFit || 0)}`
    }${held ? ` · ${held} more held back by the ${perCo}-per-employer cap` : ""} · local only, no internet needed</span>
  </div>
  <nav class="sorts"><a class="sortbtn" href="${href("/triage", base, token)}">⚡ triage</a><a class="sortbtn" href="${href("/bursts", {}, token)}">⚡ posting now</a><a class="sortbtn" href="${href("/warm", {}, token)}">🤝 warm path</a><a class="sortbtn" href="${href("/tracker", {}, token)}">tracker</a><a class="sortbtn" href="${href("/applications", {}, token)}">applications →</a>${Object.entries(
    SORTS,
  )
    .map(
      ([k, v]) =>
        `<a class="sortbtn${k === sort ? " on" : ""}" href="${link({ sort: k })}">${v.label}</a>`,
    )
    .join("")}</nav>
</header>
${everifyBanner()}
<div class="filters">
  ${Object.entries(VISA_FILTERS)
    .map(
      ([k, v]) =>
        `<a class="fbtn${filters.visa === k ? " on" : ""}" href="${link({ visa: k })}">${v.label}${
          k === "all" ? ` ${bands.all}` : bands[k] != null ? ` ${bands[k]}` : ""
        }</a>`,
    )
    .join("")}
  <span class="fsep"></span>
  ${Object.entries(FAMILIES)
    .map(
      ([k, v]) =>
        `<a class="fbtn${filters.fam === k ? " on" : ""}" href="${link({ fam: k })}">${v}</a>`,
    )
    .join("")}
  <span class="fsep"></span>
  ${[0, BAND_MID, BAND_HI]
    .map(
      (m) =>
        `<a class="fbtn${(filters.minFit || 0) === m ? " on" : ""}" href="${link({ min: m })}">${m ? `${m}+` : `${MIN_FIT}+`}</a>`,
    )
    .join("")}
</div>
${rows.length ? rows.map(card).join("") : '<p class="empty">Nothing matches these filters. Widen them, or leave the loop running and refresh.</p>'}
<script>
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  const card = b.closest(".card");
  b.disabled = true;
  const res = await fetch("/decide", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: b.dataset.id, decision: b.dataset.d }),
  });
  if (res.ok) {
    card.classList.add("done");
    card.querySelector(".acts").innerHTML =
      "<span class='sub'>" + (b.dataset.d === "approved" ? "✅ queued to apply" : "⏭ skipped") + "</span>";
  } else {
    const msg = await res.text().catch(() => "failed");
    b.disabled = false; b.textContent = msg.slice(0, 40) || "failed, retry";
  }
});
</script>`;
};

/**
 * The resume this posting would get, without spending a model call.
 *
 * The reviewer's real question on a borderline job is "what would I actually be
 * sending", and the answer used to be unavailable until after approval — resumes
 * are rendered during submit, so all 263 pending jobs have no resumePath and 65
 * decided ones do. Generating one on demand would call the tailoring model per
 * preview, which is the wrong price for a glance.
 *
 * So this renders the deterministic half. renderResume is a pure function; given
 * an empty selection it fills every slot from the bank by bulletRelevance against
 * this posting's text, which is exactly the path a real render takes for every
 * bullet the selector does not supply — and the selector supplies about a quarter
 * (measured: qwen2.5:7b returned 5.2 ids of the 22 a full resume needs). The
 * variant comes from the scorer's own family judgement. Content can only come
 * from resume/bullets.yaml, here as everywhere else in this pipeline.
 *
 * If the job already has a rendered PDF, that is the real artefact and wins.
 */
function previewPage(j, r, resumeHref) {
  const s = j.llmScore || {};
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resume preview — ${esc(j.companyName || j.companyToken)}</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:20px 24px 50px;
      max-width:820px;margin-inline:auto;background:Canvas;color:CanvasText}
 .banner{border:1px solid color-mix(in srgb,#4a7fd4 55%,transparent);
         background:color-mix(in srgb,#4a7fd4 9%,transparent);border-radius:8px;
         padding:9px 12px;font-size:12.5px;margin-bottom:16px;line-height:1.5}
 .banner code{font:11.5px ui-monospace,monospace}
 h1{font-size:18px;margin:0 0 2px} .who{font-size:12.5px;opacity:.7;margin:0 0 4px}
 h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;opacity:.6;
    margin:18px 0 6px;border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding-bottom:3px}
 .sum{font-size:13px;margin:10px 0 0}
 .role{display:flex;justify-content:space-between;gap:12px;font-size:13.5px;margin-top:10px}
 .role b{font-weight:600} .role span{opacity:.65;font-size:12.5px;white-space:nowrap}
 ul{margin:4px 0 0;padding-left:18px;font-size:13px} li{margin:2px 0}
 .sk{font-size:12.5px;margin:2px 0} .sk b{opacity:.75}
 .for{font-size:12.5px;opacity:.7;margin:0 0 14px}
 a{color:inherit}
</style>
<div class="banner">
  <b>Deterministic preview — no model was called.</b> This is
  <code>resume/bullets.yaml</code> ranked against this posting by keyword and tag
  relevance, which is the same code path that fills every bullet the tailoring
  model does not pick. The submitted resume reorders these; it cannot add text
  that is not in the bank.
  ${resumeHref ? `<br><a href="${esc(resumeHref)}" target="_blank"><b>The real rendered PDF exists for this job — open it ↗</b></a>` : ""}
</div>
<p class="for">Preview for <b>${esc(j.title)}</b> at <b>${esc(j.companyName || j.companyToken)}</b>${
    s.fit != null ? ` · fit ${esc(s.fit)}` : ""
  } · variant <b>${esc(r.family)}</b>${s.family ? ` (scorer said ${esc(s.family)})` : ""} ·
  <a href="${esc(j.applyUrl)}" target="_blank" rel="noreferrer">posting ↗</a></p>
<h1>${esc(r.profile?.name || "")}</h1>
<p class="who">${esc(r.profile?.location || "")} · ${esc(r.profile?.email || "")} · ${esc(r.profile?.phone || "")}</p>
${r.summary ? `<p class="sum">${esc(r.summary)}</p>` : ""}
<h2>Skills</h2>
${Object.entries(r.skills || {})
  .map(
    ([k, v]) =>
      `<div class="sk"><b>${esc(k)}:</b> ${esc(Array.isArray(v) ? v.join(", ") : v)}</div>`,
  )
  .join("")}
<h2>Experience</h2>
${(r.experience || [])
  .map(
    (
      e,
    ) => `<div class="role"><b>${esc(e.company)} — ${esc(e.role)}</b><span>${esc(e.dates)}</span></div>
<ul>${(e.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`,
  )
  .join("")}
<h2>Projects</h2>
${(r.projects || [])
  .map(
    (
      p,
    ) => `<div class="role"><b>${esc(p.name)}</b><span>${esc(p.stack || "")}</span></div>
<ul>${(p.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`,
  )
  .join("")}
<h2>Education</h2>
${(r.education || [])
  .map(
    (e) =>
      `<div class="role"><b>${esc(e.school)} — ${esc(e.degree)}</b><span>${esc(e.dates)}</span></div>`,
  )
  .join("")}
`;
}

/* -------------------------------------------------------------- decide guard */
// A decision must never resurrect or duplicate an application that has already
// gone out. Both pages are rendered once and worked for a long session, and the
// Telegram channel writes the same fields independently, so by the time a
// keystroke lands the row may already be submitted. The old handler matched on
// _id alone: pressing `a` on such a row rewrote submitStatus to "queued" and
// step 3 would have applied a second time, and `u` unset the decision entirely,
// erasing the record of an application that was actually sent.
const SENT = ["submitted"];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (!authorized(req, url)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("forbidden — open the link printed in the terminal\n");
    }

    if (req.method === "GET" && url.pathname === "/") {
      const sort = SORTS[url.searchParams.get("sort")]
        ? url.searchParams.get("sort")
        : DEFAULT_SORT;
      const filters = parseFilters(url);
      const html = PAGE(
        await pending(sort, 60, filters),
        sort,
        filters,
        linkToken(url),
      );
      const headers = { "content-type": "text/html; charset=utf-8" };
      // Remember the token so in-page fetches and refreshes do not need ?k=.
      if (LAN && url.searchParams.get("k") === TOKEN)
        headers["set-cookie"] =
          `rk=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
      res.writeHead(200, headers);
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/triage") {
      const sort = SORTS[url.searchParams.get("sort")]
        ? url.searchParams.get("sort")
        : DEFAULT_SORT;
      const filters = parseFilters(url);
      // A bigger page than the card view: triage is meant to be worked through in
      // one sitting, and paginating it reintroduces the friction it exists to remove.
      const q = await pending(
        sort,
        Number(process.env.TRIAGE_PAGE || 120),
        filters,
      );
      // Stamp what was actually put in front of the user, so the next visit leads
      // with what this one did not reach. Fire and forget: a failed stamp must
      // never block the page, and the worst case is a job shown twice.
      const shownIds = (q.rows || q).map((r) => r._id).filter(Boolean);
      if (shownIds.length)
        jobs
          .updateMany(
            { _id: { $in: shownIds }, shownAt: { $exists: false } },
            { $set: { shownAt: new Date() } },
          )
          .catch(() => {});

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(TRIAGE_PAGE(q, sort, filters, linkToken(url)));
    }

    if (req.method === "GET" && url.pathname === "/tracker") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const tf = {
        view: TRACKER_FILTERS[url.searchParams.get("view")] ? url.searchParams.get("view") : null,
        co: (url.searchParams.get("co") || "").slice(0, 64) || null,
        fam: ["swe", "ai"].includes(url.searchParams.get("fam")) ? url.searchParams.get("fam") : null,
      };
      return res.end(TRACKER_PAGE(await tracker(tf), linkToken(url)));
    }

    if (req.method === "POST" && url.pathname === "/reply") {
      let body = "";
      for await (const c of req) body += c;
      const { id, state } = JSON.parse(body || "{}");
      if (!id || !/^[a-f0-9]{24}$/i.test(id) || ![...REPLY_STATES, "clear"].includes(state)) {
        res.writeHead(400);
        return res.end("bad request");
      }
      // Only an application that was actually sent can have an outcome. Guarding
      // on submitStatus keeps a stray id from inventing a reply for something
      // that never went out.
      const filter = { _id: new ObjectId(id), submitStatus: "submitted" };
      const r =
        state === "clear"
          ? await jobs.updateOne(filter, { $unset: { reply: "" } })
          : await jobs.updateOne(filter, { $set: { reply: { state, at: new Date(), note: null } } });
      if (!r.matchedCount) {
        res.writeHead(404);
        return res.end("no sent application with that id");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === "GET" && url.pathname === "/bursts") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(BURSTS_PAGE(await bursts(), linkToken(url)));
    }

    if (req.method === "GET" && url.pathname === "/warm") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(WARM_PAGE(await warmRows(), linkToken(url)));
    }

    if (req.method === "GET" && url.pathname === "/applications") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(APPS_PAGE(await applications(), linkToken(url)));
    }

    // The resume preview. Pure functions over the bullet bank — no model, no
    // network, no cost. See previewPage above for why this is the deterministic
    // half of the real render rather than a mock.
    if (req.method === "GET" && url.pathname === "/preview") {
      const id = url.searchParams.get("id") || "";
      if (!/^[a-f0-9]{24}$/i.test(id)) {
        res.writeHead(400, { "content-type": "text/plain" });
        return res.end("bad id\n");
      }
      const j = await jobs.findOne({ _id: new ObjectId(id) });
      if (!j) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found\n");
      }
      if (!BANK) {
        res.writeHead(503, { "content-type": "text/plain" });
        return res.end("resume/bullets.yaml could not be read\n");
      }
      const family = ["swe", "ai"].includes(j.llmScore?.family)
        ? j.llmScore.family
        : ["swe", "ai"].includes(j.screen?.roleFamily)
          ? j.screen.roleFamily
          : "swe";
      const jobText = [j.title, j.description].filter(Boolean).join("\n");
      const rendered = renderResume(
        BANK,
        { family, bulletIds: [] },
        { jobText },
      );
      const resumeHref = j.resumePath
        ? `/file?p=${encodeURIComponent(j.resumePath)}`
        : null;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(previewPage(j, rendered, resumeHref));
    }

    // Serve the rendered resumes. Confined to out/ by resolving the request and
    // checking containment — a path parameter that reaches readFile unchecked is
    // an arbitrary-file-read on a server that binds 0.0.0.0 in --lan mode.
    if (req.method === "GET" && url.pathname === "/file") {
      const rel = url.searchParams.get("p") || "";
      const root = resolve("out");
      const target = resolve(rel);
      if (!target.startsWith(root + sep) || !/\.(pdf|png)$/i.test(target)) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("outside out/\n");
      }
      if (!existsSync(target)) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found\n");
      }
      res.writeHead(200, {
        "content-type": target.toLowerCase().endsWith(".pdf")
          ? "application/pdf"
          : "image/png",
        "content-disposition": `inline; filename="${basename(target)}"`,
      });
      return res.end(readFileSync(target));
    }

    if (req.method === "POST" && url.pathname === "/decide") {
      let body = "";
      for await (const c of req) body += c;
      const { id, decision } = JSON.parse(body || "{}");
      if (
        !id ||
        !/^[a-f0-9]{24}$/i.test(id) ||
        !["approved", "skipped", "undo"].includes(decision)
      ) {
        res.writeHead(400);
        return res.end("bad request");
      }
      const _id = new ObjectId(id);

      // Undo. Triage decides fast enough that a mis-keyed `a` is inevitable, and
      // an approve that cannot be taken back becomes an application you did not
      // mean to make. Clears the decision so the job returns to the queue —
      // unless it has already been submitted, in which case there is nothing to
      // take back and unsetting the fields would destroy the only record that it
      // was sent.
      if (decision === "undo") {
        const u = await jobs.updateOne(
          { _id, submitStatus: { $nin: SENT } },
          {
            $unset: {
              decision: "",
              decidedAt: "",
              decidedVia: "",
              submitStatus: "",
            },
          },
        );
        if (!u.matchedCount) {
          const exists = await jobs.findOne(
            { _id },
            { projection: { submitStatus: 1 } },
          );
          console.log(
            `  ↩ undo refused ${id} (${exists?.submitStatus ?? "no such job"})`,
          );
          res.writeHead(exists ? 409 : 404);
          return res.end(exists ? "already submitted" : "not found");
        }
        console.log(`  ↩ undo ${id}`);
        res.writeHead(200);
        return res.end("ok");
      }
      // Identical write to the Telegram handler, so the two channels are
      // interchangeable and submit-queue cannot tell them apart.
      const r = await jobs.updateOne(
        { _id, submitStatus: { $nin: SENT } },
        {
          $set: {
            decision,
            decidedAt: new Date(),
            decidedVia: "local-review",
            submitStatus: decision === "approved" ? "queued" : null,
          },
        },
      );
      if (!r.matchedCount) {
        const exists = await jobs.findOne(
          { _id },
          { projection: { submitStatus: 1 } },
        );
        console.log(
          `  ✋ ${decision} refused ${id} (${exists?.submitStatus ?? "no such job"})`,
        );
        res.writeHead(exists ? 409 : 404);
        return res.end(exists ? "already submitted" : "not found");
      }
      console.log(`  ${decision === "approved" ? "✅" : "⏭ "} ${id}`);
      res.writeHead(200);
      return res.end("ok");
    }

    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error("  request failed:", err.message);
    res.writeHead(500);
    res.end("error");
  }
});

// 127.0.0.1 explicitly, not 0.0.0.0. Nothing about this should be reachable from
// the campus network it exists to work around.
server.listen(PORT, HOST, () => {
  console.log(`\n  On this Mac:  http://localhost:${PORT}`);
  if (LAN) {
    const ip = lanAddress();
    if (ip) {
      console.log(`  On your phone: http://${ip}:${PORT}/?k=${TOKEN}`);
      console.log(
        `                 (same wifi. open once, the link is remembered)`,
      );
    } else {
      console.log("  No wifi address found — not connected to a network?");
    }
    console.log("");
    console.log("  ! LAN mode: reachable by other devices on this network.");
    console.log(
      "    The token above is what stops a stranger on campus wifi from",
    );
    console.log(
      "    approving or binning your applications. Do not paste it anywhere.",
    );
    console.log(
      "    Campus networks often isolate clients, so phone access may be",
    );
    console.log("    blocked regardless — it will work on home wifi.");
  }
  console.log(`\n  Showing fit >= ${MIN_FIT}. Ctrl-C to stop.`);
  console.log(
    `  Fast lane: http://localhost:${PORT}/triage   (j/k a s w r o u)`,
  );
  if (eVerifyKnownCount === 0)
    console.log(
      "\n  ! E-Verify is unknown for every employer — data/everify.csv is missing.\n" +
        "    STEM OPT's extension requires an E-Verify employer, so that gate is\n" +
        "    currently unchecked. The pages say so rather than implying it passed.",
    );
  console.log("");
});
