/**
 * Workday (cxs) adapter.
 *
 * Workday is structurally different from the other four ATS and needs its own
 * handling on three counts:
 *
 *   1. POST, not GET. The board is a JSON search endpoint taking
 *      {appliedFacets, limit, offset, searchText}.
 *   2. No ETag, so conditional GET is impossible. Instead we fetch page 0 and
 *      fingerprint (total + the page's job paths). An unchanged fingerprint is
 *      reported as `not_modified`, which keeps the poller's economics intact —
 *      one small POST instead of full pagination.
 *   3. Pages cap at 20 rows. Verified empirically that results are ordered
 *      newest-first (offset 0 → "Posted Today", offset 400 → "Posted
 *      Yesterday"), so reading the first N pages reads the freshest slice.
 *      This is a freshness pipeline, not an archive, so we deliberately do not
 *      paginate 900 pages through CVS Health's 17,992 open roles.
 *
 * Descriptions require a per-job detail call and are skipped at poll time. That
 * tradeoff was correct for polling and quietly fatal downstream: the scorer
 * requires a body over 400 characters, so all 1,642 Workday rows ever ingested
 * were screened, pre-ranked, and then never scored once. A third of the corpus,
 * and the third where large enterprises host.
 *
 * hydrateWorkday below fetches the body for ONE job. It is deliberately not
 * called from the poll path — a board poll must stay one POST — and is driven
 * instead by a separate stage that only ever touches rows already known to be
 * new. See stageHydrate in scripts/run.mjs.
 */

import { getJson, postJson } from "../util/http.js";

import { sha256 } from "../util/normalize.js";
import { htmlToText } from "./index.js";

const PAGE_SIZE = 20; // Workday's hard cap
const MAX_PAGES = Number(process.env.WORKDAY_MAX_PAGES || 5); // 100 newest roles
const PAGE_DELAY_MS = Number(process.env.WORKDAY_PAGE_DELAY_MS || 150);
const RETRIES_429 = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Workday throttles aggressively under concurrency. A 429 is transient, so back
 * off and retry rather than silently returning a truncated page set — which is
 * what made a 684-job board report 21 jobs and look like a filter problem.
 */
async function postPage(url, offset, timeout) {
  for (let attempt = 0; attempt <= RETRIES_429; attempt++) {
    const res = await postJson(
      url,
      { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: "" },
      { timeout },
    );
    if (res.httpStatus !== 429) return res;
    if (attempt === RETRIES_429) return res;
    await sleep(600 * 2 ** attempt);
  }
}

export function boardUrl(company) {
  const { token, wdHost, wdSite } = company;
  return `https://${token}.${wdHost}.myworkdayjobs.com/wday/cxs/${token}/${wdSite}/jobs`;
}

export function jobUrl(company, externalPath) {
  const { token, wdHost, wdSite } = company;
  return `https://${token}.${wdHost}.myworkdayjobs.com/en-US/${wdSite}${externalPath || ""}`;
}

/** "Posted Today" | "Posted Yesterday" | "Posted 3 Days Ago" | "Posted 30+ Days Ago" */
export function parsePostedOn(text, now = new Date()) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (t.includes("today")) return new Date(now);
  if (t.includes("yesterday")) return new Date(now.getTime() - 86_400_000);
  const m = t.match(/(\d+)\+?\s*day/);
  if (m) return new Date(now.getTime() - Number(m[1]) * 86_400_000);
  const mo = t.match(/(\d+)\+?\s*month/);
  if (mo) return new Date(now.getTime() - Number(mo[1]) * 30 * 86_400_000);
  return null;
}

/**
 * bulletFields is positional and inconsistent: sometimes ["R184158"], sometimes
 * ["US - TX (Field Location)", "R184158"]. The req id is the last entry and
 * looks like an identifier; anything before it is location text.
 */
const REQ_ID_RE = /^[A-Z]{0,3}[-_]?\d[\w-]*$/;

export function splitBulletFields(bulletFields = []) {
  const fields = (bulletFields || [])
    .map((b) => String(b || "").trim())
    .filter(Boolean);
  if (!fields.length) return { reqId: null, locations: [] };

  const last = fields[fields.length - 1];
  const looksLikeId = REQ_ID_RE.test(last);
  return {
    reqId: looksLikeId ? last : null,
    locations: looksLikeId ? fields.slice(0, -1) : fields,
  };
}

export function normalizePosting(p, company, now = new Date()) {
  const { reqId, locations: bulletLocs } = splitBulletFields(p.bulletFields);

  const locs = new Set();
  if (p.locationsText) locs.add(String(p.locationsText).trim());
  for (const l of bulletLocs) locs.add(l);
  if (p.remoteType && /remote/i.test(p.remoteType)) locs.add("Remote");

  const path = p.externalPath || "";
  // externalPath tail is a stable per-req identifier; prefer the explicit reqId.
  const tail = path.split("/").filter(Boolean).pop() || "";
  const sourceJobId = reqId || tail || path;

  const posted = parsePostedOn(p.postedOn, now);

  return {
    sourceJobId: String(sourceJobId),
    title: String(p.title || "").trim(),
    description: "", // detail call is per-job; too expensive at poll time
    locations: [...locs],
    applyUrl: jobUrl(company, path),
    postedAtClaimed: posted ? posted.toISOString() : null,
  };
}

/**
 * The cxs detail URL for a job, derived from the apply URL.
 *
 * Apply:  https://aah.wd5.myworkdayjobs.com/en-US/External/job/Remote/Foo_R258944-1
 * Detail: https://aah.wd5.myworkdayjobs.com/wday/cxs/aah/External/job/Remote/Foo_R258944-1
 *
 * Only the middle segment differs, so the path tail is reused verbatim rather
 * than reconstructed — reconstructing it would need the externalPath the poller
 * does not store.
 */
export function detailUrl(company, applyUrl) {
  const { token, wdHost, wdSite } = company || {};
  if (!token || !wdHost || !wdSite || !applyUrl) return null;
  const marker = `/en-US/${wdSite}`;
  const i = String(applyUrl).indexOf(marker);
  if (i < 0) return null;
  const tail = String(applyUrl).slice(i + marker.length);
  if (!tail) return null;
  return `https://${token}.${wdHost}.myworkdayjobs.com/wday/cxs/${token}/${wdSite}${tail}`;
}

/**
 * Fetch the description for one Workday job.
 *
 * Returns { status, description } — never throws, because a hydrate stage that
 * dies on one malformed board stops hydrating every other board behind it.
 */
export async function hydrateWorkday(job, company, opts = {}) {
  const url = detailUrl(company, job.applyUrl);
  if (!url) return { status: "error", error: "cannot_derive_detail_url", description: "" };

  const res = await getJson(url, { timeout: opts.timeout });
  if (res.status !== "ok")
    return {
      status: "error",
      error: res.error || `http_${res.httpStatus}`,
      httpStatus: res.httpStatus,
      description: "",
    };

  const html = res.data?.jobPostingInfo?.jobDescription || "";
  const text = htmlToText(html);
  return {
    status: text.length > 0 ? "ok" : "empty",
    description: text,
    httpStatus: res.httpStatus,
  };
}

function fingerprint(total, postings) {
  return `wd:${sha256(`${total}|${postings.map((p) => p.externalPath || p.title).join("|")}`)}`;
}

/**
 * Fetch one Workday board.
 * Mirrors the shape of the other adapters so the poller stays ATS-agnostic.
 * The synthetic fingerprint is returned in `etag` so the poller stores and
 * replays it with no special-casing.
 */
export async function fetchWorkday(company, opts = {}) {
  if (!company.wdHost || !company.wdSite) {
    return {
      status: "error",
      error: "missing_wd_host_or_site",
      jobs: [],
      httpStatus: 0,
    };
  }

  const url = boardUrl(company);
  const now = new Date();

  const first = await postPage(url, 0, opts.timeout);

  if (first.status !== "ok") {
    return {
      status: "error",
      error: first.error || `http_${first.httpStatus}`,
      jobs: [],
      httpStatus: first.httpStatus,
    };
  }
  const total = Number(first.data?.total ?? 0);
  const page0 = Array.isArray(first.data?.jobPostings)
    ? first.data.jobPostings
    : [];

  const fp = fingerprint(total, page0);
  if (company.etag && company.etag === fp) {
    return {
      status: "not_modified",
      jobs: [],
      etag: fp,
      httpStatus: first.httpStatus,
    };
  }

  const all = [...page0];
  const maxPages = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE) || 1);
  let partial = false;
  for (let page = 1; page < maxPages; page++) {
    if (PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
    const res = await postPage(url, page * PAGE_SIZE, opts.timeout);
    if (res.status !== "ok") {
      // Record it. Returning a short page set as a clean success is how a
      // throttled board masquerades as a board with no matching roles.
      partial = true;
      break;
    }
    const rows = Array.isArray(res.data?.jobPostings)
      ? res.data.jobPostings
      : [];
    if (!rows.length) break;
    all.push(...rows);
  }

  const jobs = all
    .map((p) => normalizePosting(p, company, now))
    .filter((j) => j.sourceJobId && j.title);

  return {
    status: "ok",
    jobs,
    // Withhold the fingerprint on a partial read. Storing it would make the
    // next poll report not_modified and the un-fetched pages would never load.
    etag: partial ? null : fp,
    httpStatus: first.httpStatus,
    partial,
    cappedByMaxPages: total > all.length && !partial,
    total,
  };
}
