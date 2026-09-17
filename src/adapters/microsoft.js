/**
 * Microsoft (apply.careers.microsoft.com) adapter.
 *
 * The documented `gcsservices.careers.microsoft.com` endpoint no longer
 * resolves. The live one was found by loading the careers SPA in a browser and
 * reading its resource timings — the same devtools recipe that works for any
 * proprietary portal:
 *
 *     performance.getEntriesByType('resource').map(r => r.name)
 *
 * That surfaced /api/pcsx/search, which serves clean JSON over plain HTTP with
 * no auth.
 *
 * Verified behaviour:
 *   - page size is fixed at 10; the `num` parameter is accepted and ignored
 *   - `start` paginates correctly (zero overlap between start=0 and start=20)
 *   - no ETag and `cache-control: no-store`, so conditional GET is impossible —
 *     change detection uses a page-0 fingerprint, same as Workday
 *   - `postedTs` / `creationTs` are unix seconds
 *
 * The search payload carries no body, so every Microsoft row ever ingested
 * stored `description: ""` and was skipped by the scorer's 400-character floor
 * — the same silent failure as Workday and SmartRecruiters, and never once
 * scored. The same devtools recipe run against a job page rather than the
 * search page surfaced the fix: /api/pcsx/position_details. See
 * hydrateMicrosoft below.
 */

import { getJson } from "../util/http.js";
import { sha256 } from "../util/normalize.js";
import { htmlToText } from "./index.js";

const PAGE_SIZE = 10; // server-fixed
const MAX_PAGES = Number(process.env.MICROSOFT_MAX_PAGES || 5); // 50 newest per query
const PAGE_DELAY_MS = Number(process.env.MICROSOFT_PAGE_DELAY_MS || 120);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MICROSOFT_QUERIES = [
  { slug: "swe", query: "software engineer" },
  { slug: "ml", query: "machine learning engineer" },
  { slug: "data", query: "data engineer" },
  { slug: "ai", query: "applied scientist" },
  { slug: "cloud", query: "cloud solution architect" },
];

export function searchUrl(query, start = 0) {
  const p = new URLSearchParams({
    domain: "microsoft.com",
    query,
    location: "",
    start: String(start),
    num: String(PAGE_SIZE),
    sort_by: "Most recent",
  });
  return `https://apply.careers.microsoft.com/api/pcsx/search?${p.toString()}`;
}

/** standardizedLocations is the clean list ("Redmond, WA, US"); locations is verbose. */
export function parseLocations(p) {
  const out = new Set();
  for (const l of p.standardizedLocations || []) {
    const s = String(l || "").trim();
    // bare country codes carry no signal and confuse the US gate
    if (s && s.length > 3) out.add(s);
  }
  if (!out.size)
    for (const l of p.locations || []) {
      const s = String(l || "").trim();
      if (s) out.add(s);
    }
  if (p.workLocationOption && /remote/i.test(p.workLocationOption))
    out.add("Remote");
  return [...out];
}

export function normalizePosition(p) {
  const ts = Number(p.postedTs || p.creationTs || 0);
  const posted = ts > 0 ? new Date(ts * 1000).toISOString() : null;

  return {
    sourceJobId: String(p.displayJobId || p.atsJobId || p.id || ""),
    title: String(p.name || "").trim(),
    // The search payload carries no body; the detail call is per-job. Body
    // checks degrade to 'unknown', same as Workday and SmartRecruiters.
    description: "",
    locations: parseLocations(p),
    applyUrl: p.positionUrl
      ? `https://apply.careers.microsoft.com${p.positionUrl}`
      : `https://jobs.careers.microsoft.com/global/en/job/${p.displayJobId || p.id}`,
    postedAtClaimed: posted,
    meta: { department: p.department || null },
  };
}

/**
 * The detail endpoint, keyed on the INTERNAL id — not the one we store.
 *
 * The search row carries two identifiers and they are not interchangeable:
 * `displayJobId` (200039153) is the requisition number a human sees and is what
 * normalizePosition writes to sourceJobId, while `id` (1970393556872425) is the
 * internal key position_details wants. Passing the display id returns
 * `404 Position not found`.
 *
 * The internal id is not stored on the job row, but it IS in the apply URL that
 * is — `/careers/job/1970393556872425` — so it is recovered from there, the same
 * way Workday's detailUrl reuses the apply URL's path tail rather than
 * reconstructing an identifier the poller does not keep.
 */
export function positionIdFrom(applyUrl) {
  const m = String(applyUrl || "").match(/\/careers\/job\/(\d+)/);
  return m ? m[1] : null;
}

export function detailUrl(applyUrl) {
  const id = positionIdFrom(applyUrl);
  return id
    ? `https://apply.careers.microsoft.com/api/pcsx/position_details` +
        `?position_id=${id}&domain=microsoft.com&hl=en`
    : null;
}

/**
 * Fetch the description for one Microsoft job.
 *
 * Same contract as hydrateWorkday: returns { status, description }, never
 * throws. `gone` is split out from `error` because this endpoint answers a
 * retired requisition with a clean 404 `Position not found`, which is a closed
 * posting rather than a hydration fault.
 *
 * No ETag and `cache-control: no-store`, so unlike SmartRecruiters there is no
 * conditional re-hydrate to be had here.
 */
export async function hydrateMicrosoft(job, company, opts = {}) {
  const url = detailUrl(job?.applyUrl);
  if (!url)
    return {
      status: "error",
      error: "cannot_derive_detail_url",
      description: "",
    };

  const res = await getJson(url, { timeout: opts.timeout });
  if (res.status !== "ok")
    return {
      status: res.httpStatus === 404 ? "gone" : "error",
      error: res.error || `http_${res.httpStatus}`,
      httpStatus: res.httpStatus,
      description: "",
    };

  const text = htmlToText(res.data?.data?.jobDescription || "");
  return {
    status: text.length > 0 ? "ok" : "empty",
    description: text,
    // The canonical page, which is also what the search row builds.
    applyUrl: res.data?.data?.publicUrl || "",
    httpStatus: res.httpStatus,
  };
}

function fingerprint(count, positions) {
  return `ms:${sha256(`${count}|${positions.map((p) => p.id || p.displayJobId).join("|")}`)}`;
}

export async function fetchMicrosoft(company, opts = {}) {
  const query =
    company.query ||
    MICROSOFT_QUERIES.find((q) => company.token?.endsWith(q.slug))?.query;
  if (!query)
    return { status: "error", error: "missing_query", jobs: [], httpStatus: 0 };

  const first = await getJson(searchUrl(query, 0), { timeout: opts.timeout });
  if (first.status !== "ok") {
    return {
      status: "error",
      error: first.error || `http_${first.httpStatus}`,
      jobs: [],
      httpStatus: first.httpStatus,
    };
  }

  const data = first.data?.data || {};
  const count = Number(data.count ?? 0);
  const page0 = Array.isArray(data.positions) ? data.positions : [];

  const fp = fingerprint(count, page0);
  if (company.etag && company.etag === fp) {
    return {
      status: "not_modified",
      jobs: [],
      etag: fp,
      httpStatus: first.httpStatus,
    };
  }

  const all = [...page0];
  let partial = false;
  const maxPages = Math.min(MAX_PAGES, Math.ceil(count / PAGE_SIZE) || 1);
  for (let page = 1; page < maxPages; page++) {
    if (PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
    const res = await getJson(searchUrl(query, page * PAGE_SIZE), {
      timeout: opts.timeout,
    });
    if (res.status !== "ok") {
      partial = true;
      break;
    }
    const rows = res.data?.data?.positions || [];
    if (!rows.length) break;
    all.push(...rows);
  }

  const seen = new Set();
  const jobs = [];
  for (const p of all) {
    const n = normalizePosition(p);
    if (!n.sourceJobId || !n.title || seen.has(n.sourceJobId)) continue;
    seen.add(n.sourceJobId);
    jobs.push(n);
  }

  return {
    status: "ok",
    jobs,
    etag: partial ? null : fp,
    httpStatus: first.httpStatus,
    partial,
    total: count,
  };
}
