/**
 * Bank of America (careers.bankofamerica.com) adapter.
 *
 * Endpoint found with the resource-timing recipe in docs/PORTALS.md — the
 * public site is an AEM SPA whose search calls `/services/jobssearchservlet`.
 *
 * Verified behaviour:
 *   - `search` is a MODE, not a query. `search=software engineer` returns
 *     totalMatches:0; `search=getAllJobs` returns the full 2,054-row set.
 *     No working keyword mode was found, so we page the newest slice and let
 *     the deterministic screen do the filtering — which is what it is for.
 *   - `rows=100` works (unlike Workday's hard 20 and Microsoft's fixed 10).
 *   - Results are date-descending, so the first pages are the freshest.
 *   - No ETag → page-0 fingerprint, same as Workday and Microsoft.
 *
 * Payload is unusually rich: it carries `jobDescriptionExternal` AND explicit
 * `minYearsOfExperience` / `maxYearsOfExperience` integers, so the YoE gate can
 * use a real number instead of regexing prose.
 */

import { getJson } from "../util/http.js";
import { sha256 } from "../util/normalize.js";

// `rows` is the TOTAL number of records to return, and `start` is an offset
// WITHIN that returned set — not a global cursor. Verified: start=100&rows=100
// returns 0 rows, while start=10&rows=100 returns 90. So there is no page loop
// here; one request with a large `rows` fetches the whole freshest slice.
const MAX_ROWS = Number(process.env.BOFA_MAX_ROWS || 500);
const BASE = "https://careers.bankofamerica.com";

export function searchUrl(rows = MAX_ROWS) {
  return `${BASE}/services/jobssearchservlet?start=0&rows=${rows}&search=getAllJobs`;
}

/** "08/01/2026" (MM/DD/YYYY) → ISO */
export function parsePostedDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const [, mm, dd, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseLocations(j) {
  const out = new Set();
  const primary = [j.city, j.stateAbbriviation || j.state]
    .filter(Boolean)
    .join(", ");
  if (primary) out.add(primary);
  if (j.locationString) out.add(String(j.locationString).trim());

  // "US - SC - Charleston - 540 Folly Rd (SC1344),US - SC - Mount Pleasant - …"
  const extra = j.additionalLocationsList || j.additionalLocations;
  const list = Array.isArray(extra) ? extra : String(extra || "").split(",");
  for (const raw of list) {
    const s = String(raw || "").trim();
    if (!s) continue;
    // keep the "US - SC - Charleston" part, drop the street address / branch code
    const parts = s.split(" - ").slice(0, 3).join(", ");
    if (parts) out.add(parts);
  }
  if (j.timeType && /remote/i.test(j.timeType)) out.add("Remote");
  return [...out].slice(0, 12);
}

export function normalizeJob(j) {
  const path = j.jcrURL || j.externalUrl || "";
  return {
    sourceJobId: String(j.jobRequisitionId || "").trim(),
    title: String(j.postingTitle || "").trim(),
    description: String(
      j.jobDescriptionExternal || j.additionalJobDescription || "",
    ),
    locations: parseLocations(j),
    applyUrl: path.startsWith("http") ? path : `${BASE}${path}`,
    postedAtClaimed: parsePostedDate(j.externalPostedDate || j.postedDate),
    // Structured YoE beats regexing prose — surfaced so the screen can prefer it.
    meta: {
      minYoE: Number.isFinite(Number(j.minYearsOfExperience))
        ? Number(j.minYearsOfExperience)
        : null,
      maxYoE: Number.isFinite(Number(j.maxYearsOfExperience))
        ? Number(j.maxYearsOfExperience)
        : null,
      lob: j.lob || null,
      family: j.family || null,
    },
  };
}

function fingerprint(total, rows) {
  return `bofa:${sha256(`${total}|${rows.map((r) => r.jobRequisitionId).join("|")}`)}`;
}

export async function fetchBofa(company, opts = {}) {
  const res = await getJson(searchUrl(), { timeout: opts.timeout });
  if (res.status !== "ok") {
    return {
      status: "error",
      error: res.error || `http_${res.httpStatus}`,
      jobs: [],
      httpStatus: res.httpStatus,
    };
  }

  const total = Number(res.data?.totalMatches ?? 0);
  const rows = Array.isArray(res.data?.jobsList) ? res.data.jobsList : [];

  const fp = fingerprint(total, rows);
  if (company.etag && company.etag === fp) {
    return { status: "not_modified", jobs: [], etag: fp, httpStatus: res.httpStatus };
  }

  const seen = new Set();
  const jobs = [];
  for (const r of rows) {
    const n = normalizeJob(r);
    if (!n.sourceJobId || !n.title || seen.has(n.sourceJobId)) continue;
    seen.add(n.sourceJobId);
    jobs.push(n);
  }

  return {
    status: "ok",
    jobs,
    etag: fp,
    httpStatus: res.httpStatus,
    partial: false,
    cappedByMaxRows: total > rows.length,
    total,
  };
}
