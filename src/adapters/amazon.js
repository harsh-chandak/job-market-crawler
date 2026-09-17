/**
 * Amazon (amazon.jobs) adapter.
 *
 * Amazon's public search.json is the richest source in the pipeline: unlike
 * Workday and SmartRecruiters it returns the full `description` plus
 * `basic_qualifications` and `preferred_qualifications` at search time, so
 * work-authorization and years-of-experience checks actually run instead of
 * degrading to 'unknown'.
 *
 * Two structural differences from an ATS board:
 *
 *   1. There is no "board" to enumerate — it is a search endpoint, so coverage
 *      comes from a fixed set of queries rather than one URL. Each query is
 *      registered as its own company row (token `amazon:swe`, `amazon:ml`, …)
 *      so each gets its own ETag, tier and cadence with no poller changes.
 *   2. It serves a real ETag, so conditional GET works — unlike Workday.
 *
 * `result_limit` caps at 100 (verified: 500 returns zero rows). Results are
 * sorted newest-first via sort=recent, so reading the first pages reads the
 * freshest slice.
 */

import { getJson } from "../util/http.js";

const PAGE_SIZE = 100; // verified ceiling
const MAX_PAGES = Number(process.env.AMAZON_MAX_PAGES || 3); // 300 newest per query

/**
 * Query set. Amazon posts tens of thousands of roles, most of them warehouse
 * and retail, so an unfiltered sweep is mostly noise. These target the three
 * resume variants directly.
 */
export const AMAZON_QUERIES = [
  { slug: "sde", query: "software development engineer" },
  { slug: "swe", query: "software engineer" },
  { slug: "frontend", query: "front end engineer" },
  { slug: "ml", query: "machine learning engineer" },
  { slug: "applied-scientist", query: "applied scientist" },
  { slug: "data-engineer", query: "data engineer" },
  { slug: "solutions-architect", query: "solutions architect" },
  { slug: "support-engineer", query: "systems development engineer" },
];

export function searchUrl(query, offset = 0, limit = PAGE_SIZE) {
  const p = new URLSearchParams({
    base_query: query,
    offset: String(offset),
    result_limit: String(limit),
    sort: "recent",
  });
  // Restrict to US at the source — cheaper than filtering 40 countries locally.
  p.append("country[]", "USA");
  return `https://www.amazon.jobs/en/search.json?${p.toString()}`;
}

/**
 * `locations` is an array of JSON-encoded strings, not objects. Parsing is
 * best-effort; `location` ("US, MA, Cambridge") is always present as a fallback.
 */
export function parseLocations(job) {
  const out = new Set();
  if (job.location) out.add(String(job.location).trim());

  for (const raw of job.locations || []) {
    if (typeof raw !== "string") continue;
    try {
      const o = JSON.parse(raw);
      const label =
        o.normalizedLocation ||
        o.location ||
        [o.city, o.region].filter(Boolean).join(", ");
      if (label) out.add(String(label).trim());
      if (o.type && /remote|virtual/i.test(o.type)) out.add("Remote");
    } catch {
      // not JSON — treat the string itself as a label
      if (raw.trim()) out.add(raw.trim());
    }
  }

  if (!out.size && job.city)
    out.add([job.city, job.state].filter(Boolean).join(", "));
  return [...out];
}

/** "July 31, 2026" → ISO. Amazon also exposes a relative `updated_time`. */
export function parsePostedDate(job) {
  const raw = job.posted_date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeJob(job) {
  // The screen reads the body for work auth and YoE; qualifications carry the
  // citizenship/clearance language more often than the description does.
  const description = [
    job.description,
    job.basic_qualifications,
    job.preferred_qualifications,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    sourceJobId: String(job.id_icims || job.id || ""),
    title: String(job.title || "").trim(),
    description,
    locations: parseLocations(job),
    applyUrl: job.job_path ? `https://www.amazon.jobs${job.job_path}` : "",
    postedAtClaimed: parsePostedDate(job),
    meta: {
      isIntern: Boolean(job.is_intern),
      isManager: Boolean(job.is_manager),
      universityJob: Boolean(job.university_job),
      jobFamily: job.job_family || null,
      team: job.team?.business_category || job.business_category || null,
    },
  };
}

/**
 * Fetch one Amazon query.
 * @param {{token:string, query:string, etag?:string}} company
 */
export async function fetchAmazon(company, opts = {}) {
  const query =
    company.query ||
    AMAZON_QUERIES.find((q) => company.token?.endsWith(q.slug))?.query;
  if (!query) {
    return { status: "error", error: "missing_query", jobs: [], httpStatus: 0 };
  }

  const first = await getJson(searchUrl(query, 0), {
    etag: company.etag,
    timeout: opts.timeout,
  });

  if (first.status === "not_modified") {
    return {
      status: "not_modified",
      jobs: [],
      etag: company.etag,
      httpStatus: 304,
    };
  }
  if (first.status !== "ok") {
    return {
      status: "error",
      error: first.error || `http_${first.httpStatus}`,
      jobs: [],
      httpStatus: first.httpStatus,
    };
  }

  const hits = Number(first.data?.hits ?? 0);
  const rows = Array.isArray(first.data?.jobs) ? first.data.jobs : [];
  const all = [...rows];
  let partial = false;

  const maxPages = Math.min(MAX_PAGES, Math.ceil(hits / PAGE_SIZE) || 1);
  for (let page = 1; page < maxPages; page++) {
    const res = await getJson(searchUrl(query, page * PAGE_SIZE), {
      timeout: opts.timeout,
    });
    if (res.status !== "ok") {
      partial = true;
      break;
    }
    const more = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
    if (!more.length) break;
    all.push(...more);
  }

  // The same req appears across queries; dedupe within a fetch by req id.
  const seen = new Set();
  const jobs = [];
  for (const j of all) {
    const n = normalizeJob(j);
    if (!n.sourceJobId || !n.title) continue;
    if (seen.has(n.sourceJobId)) continue;
    seen.add(n.sourceJobId);
    jobs.push(n);
  }

  return {
    status: "ok",
    jobs,
    // Same rule as Workday: never store a validator for an incomplete read, or
    // the next poll reports not_modified and the missing pages never load.
    etag: partial ? null : first.etag,
    httpStatus: first.httpStatus,
    partial,
    total: hits,
  };
}
