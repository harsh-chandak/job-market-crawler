/**
 * Discover job boards from the SimplifyJobs/New-Grad-Positions listing.
 *
 *   node scripts/discover-simplify.mjs           report only
 *   node scripts/discover-simplify.mjs --apply   add the new boards
 *
 * DISCOVERS BOARDS, NOT JOBS, AND THAT IS THE POINT.
 *
 * The obvious move is to ingest the 2,600 active listings directly. It is the
 * wrong move: the feed carries title, company, location and URL but no
 * description, and the scorer needs a body over 400 characters. Ingesting it
 * would manufacture 2,600 rows that pass every screen and can never be scored —
 * precisely the Workday failure that took 1,642 rows a month to notice.
 *
 * What the feed uniquely provides is the URLs, and a Greenhouse or Lever URL
 * names a board. Boards we do not already poll are the actual finding. Adding one
 * lets the existing adapters fetch it properly, with descriptions, on the normal
 * tiered schedule. The feed is a directory, not a source.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { getJson } from "../src/util/http.js";

const FEED =
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json";
const apply = process.argv.includes("--apply");
const CATEGORIES = new Set(["Software", "AI/ML/Data", "Software Engineering"]);

/** Board URL builders, mirroring what the poller already stores per ATS. */
const BOARD_URL = {
  greenhouse: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
  ashby: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
  smartrecruiters: (t) =>
    `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`,
  // Workday's board URL is derived by the adapter from token/wdHost/wdSite, so
  // the stored value only has to match what boardUrl() in the adapter produces.
  workday: (t, b) =>
    `https://${t}.${b.wdHost}.myworkdayjobs.com/wday/cxs/${t}/${b.wdSite}/jobs`,
};

/**
 * (ats, token) from a posting URL, or null when the host is not an ATS we poll.
 *
 * Token case matters: Greenhouse and Lever tokens are lowercase, SmartRecruiters
 * tokens are CamelCase identifiers. Normalising all of them would produce boards
 * that 404 on every poll forever.
 */
export function parseBoard(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  if (!seg.length) return null;

  // Tokens arrive percent-encoded ("vytalize%20health"). Decode, then reject
  // anything that is not a plausible board token — a token with a space in it
  // yields a board URL that 404s on every poll, forever, silently.
  const tok = (raw, lower = true) => {
    let t;
    try {
      t = decodeURIComponent(raw);
    } catch {
      t = raw;
    }
    t = lower ? t.toLowerCase() : t;
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t) ? t : null;
  };

  // Greenhouse also serves an EU host, which is the same API with the same token.
  if (
    host === "job-boards.greenhouse.io" ||
    host === "boards.greenhouse.io" ||
    host === "job-boards.eu.greenhouse.io"
  ) {
    const t = tok(seg[0]);
    return t ? { ats: "greenhouse", token: t } : null;
  }
  if (host === "jobs.lever.co") {
    const t = tok(seg[0]);
    return t ? { ats: "lever", token: t } : null;
  }
  if (host === "jobs.ashbyhq.com") {
    const t = tok(seg[0]);
    return t ? { ats: "ashby", token: t } : null;
  }
  if (host === "jobs.smartrecruiters.com") {
    const t = tok(seg[0], false);
    return t ? { ats: "smartrecruiters", token: t } : null;
  }

  // Workday. Worth parsing now that descriptions can be hydrated — before that,
  // adding a Workday board would only have manufactured more unscoreable stubs.
  // Host shape: {token}.{wdHost}.myworkdayjobs.com, path /en-US/{site}/...
  const wd = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const site = seg[0] === "en-US" ? seg[1] : seg[0];
    if (!site) return null;
    const t = tok(wd[1]);
    return t ? { ats: "workday", token: t, wdHost: wd[2], wdSite: site } : null;
  }
  return null;
}

const res = await getJson(FEED, { timeout: 30_000 });
if (res.status !== "ok") {
  console.log(`✗ could not fetch the feed: ${res.error || res.httpStatus}`);
  process.exit(1);
}
const all = res.data;

/**
 * The feed's booleans are real JSON booleans, and the comparison has to survive
 * both. An earlier version tested String(e.active) === "True" — the capitalised
 * form Python's str() produces — which matches nothing in JavaScript, where the
 * same value stringifies to "true". Every clause after it was unreachable and the
 * script cheerfully reported 0 live listings out of 18,176 as though the feed were
 * empty.
 */
const isTrue = (v) => v === true || String(v).toLowerCase() === "true";

const live = all.filter(
  (e) =>
    isTrue(e.active) &&
    isTrue(e.is_visible) &&
    CATEGORIES.has(e.category) &&
    e.sponsorship !== "Does Not Offer Sponsorship" &&
    e.sponsorship !== "U.S. Citizenship is Required",
);

const boards = new Map(); // "ats:token" -> {ats, token, jobs, sample}
const offAts = new Map(); // host -> count, for the coverage gap
for (const e of live) {
  const b = parseBoard(e.url);
  if (!b) {
    try {
      const h = new URL(e.url).hostname;
      offAts.set(h, (offAts.get(h) || 0) + 1);
    } catch {}
    continue;
  }
  const k = `${b.ats}:${b.token}`;
  if (!boards.has(k))
    boards.set(k, { ...b, jobs: 0, sample: e.company_name || b.token });
  boards.get(k).jobs++;
}

const db = await getDb();
const companies = db.collection("companies");
const known = new Set(
  (await companies.find({}, { projection: { ats: 1, token: 1 } }).toArray()).map(
    (c) => `${c.ats}:${String(c.token).toLowerCase()}`,
  ),
);

const fresh = [...boards.values()]
  .filter((b) => !known.has(`${b.ats}:${b.token.toLowerCase()}`))
  .sort((a, b) => b.jobs - a.jobs);

console.log(`feed: ${all.length} listings, ${live.length} live and relevant`);
console.log(`boards named: ${boards.size}   already tracked: ${boards.size - fresh.length}   NEW: ${fresh.length}\n`);

for (const b of fresh.slice(0, 25))
  console.log(`  + ${b.ats.padEnd(16)}${b.token.slice(0, 24).padEnd(25)}${String(b.jobs).padStart(3)} listings   ${b.sample.slice(0, 24)}`);
if (fresh.length > 25) console.log(`  … and ${fresh.length - 25} more`);

console.log(`\nlistings on hosts no adapter covers (a real gap, not fixed here):`);
for (const [h, n] of [...offAts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
  console.log(`  ${h.padEnd(34)}${n}`);

if (!apply) {
  console.log(`\ndry run — re-run with --apply to add the ${fresh.length} new board(s)`);
  await closeDb();
  process.exit(0);
}

const now = new Date();
const docs = fresh.map((b) => ({
  ats: b.ats,
  token: b.token,
  name: b.sample,
  boardUrl: BOARD_URL[b.ats](b.token, b),
  ...(b.ats === "workday" ? { wdHost: b.wdHost, wdSite: b.wdSite } : {}),
  enabled: true,
  consecutiveErrors: 0,
  etag: null,
  lastModified: null,
  createdAt: now,
  // Untried boards start on the slow tier. A board discovered from a directory
  // has not proved it posts anything relevant, and putting 400 of them on the
  // 3-minute tier would swamp the poll budget that pinned targets depend on.
  tier: "C",
  discoveredVia: "simplify",
}));

let added = 0;
for (const d of docs) {
  const r = await companies.updateOne(
    { ats: d.ats, token: d.token },
    { $setOnInsert: d },
    { upsert: true },
  );
  if (r.upsertedCount) added++;
}
console.log(`\nadded ${added} board(s) on tier C; the poller will pick them up on its next sweep`);
await closeDb();
