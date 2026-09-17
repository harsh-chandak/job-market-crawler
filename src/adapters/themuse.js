/**
 * The Muse — an aggregator, not an ATS.
 *
 * Every other adapter here fetches one employer's board. The Muse is a single
 * public feed across thousands of employers, paginated, no API key. That makes
 * it the one source that can surface a company the board list has never heard
 * of, which is exactly the gap the pinned-employer approach leaves.
 *
 * Modelled as pseudo-companies the way Amazon already is: one row per category
 * (`museCategory`), each walking its own pages. The company row carries
 * `musePage` so a sweep resumes where the last one stopped rather than
 * re-reading page 1 forever — the feed is ~5,000 pages deep and a poller that
 * only ever sees the first twenty jobs would find nothing new after its first
 * run.
 *
 * Postings link back to themuse.com rather than to the employer's own form. The
 * landing page redirects to the real application, so the submit step can follow
 * it, but liveness cannot be checked against an ATS API — these rows have no
 * ATS behind them.
 */
const BASE = "https://www.themuse.com/api/public/jobs";

/** Levels that are not worth a request for a 2-year candidate. */
const SENIOR = /senior|principal|staff|director|manager|executive|vp\b|head of/i;

export function museUrl({ category, page = 1, level }) {
  const p = new URLSearchParams();
  if (category) p.set("category", category);
  if (level) p.set("level", level);
  p.set("page", String(page));
  return `${BASE}?${p.toString()}`;
}

export function normalizeMuse(j) {
  const locs = (j.locations || []).map((l) => String(l?.name || "")).filter(Boolean);
  return {
    sourceJobId: String(j.id ?? ""),
    title: String(j.name || "").trim(),
    // `contents` is HTML. poller.js converts before it caps, so hand it over raw
    // rather than converting twice.
    description: String(j.contents || ""),
    locations: locs,
    applyUrl: j.refs?.landing_page || "",
    postedAtClaimed: j.publication_date || null,
    // Carried so the screen can use it; The Muse states seniority explicitly,
    // which most ATS feeds do not.
    museLevels: (j.levels || []).map((l) => String(l?.name || "")).filter(Boolean),
    // The employer, not the feed. poller.js prefers this over the board name so
    // an aggregator's rows are attributed to whoever is actually hiring.
    companyName: j.company?.name || "",
    museCompany: j.company?.name || "",
  };
}

/**
 * Fetch one page of one category.
 *
 * Returns the same {status, jobs, ...} envelope every other adapter returns, so
 * pollCompany needs no special case beyond the dispatch in fetchBoard.
 */
export async function fetchMuse(company, { timeout = 20_000 } = {}) {
  const page = Number(company.musePage) || 1;
  const url = museUrl({ category: company.museCategory, page, level: company.museLevel });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: "application/json", "user-agent": "job-hunt/1.0" },
    });
  } catch (err) {
    clearTimeout(timer);
    return { status: "error", error: `themuse:${String(err?.message || err).slice(0, 60)}`, jobs: [] };
  }
  clearTimeout(timer);

  if (res.status === 429)
    return { status: "error", error: "themuse:rate_limited", jobs: [], httpStatus: 429 };
  if (!res.ok)
    return { status: "error", error: `themuse:http_${res.status}`, jobs: [], httpStatus: res.status };

  let data;
  try {
    data = await res.json();
  } catch {
    return { status: "error", error: "themuse:bad_json", jobs: [] };
  }

  const rows = Array.isArray(data?.results) ? data.results : [];
  const jobs = rows
    .map(normalizeMuse)
    // Drop senior listings here rather than paying to store and screen them.
    // The feed states the level, so this is a fact about the posting and not a
    // guess — the deterministic screen still runs on everything that survives.
    .filter((j) => !j.museLevels.some((l) => SENIOR.test(l)))
    .filter((j) => j.sourceJobId && j.title);

  return {
    status: "ok",
    jobs,
    httpStatus: res.status,
    // Where the next sweep should resume. Wraps at the end rather than stopping,
    // because page 1 is where new postings appear.
    nextPage: page >= (Number(data?.page_count) || 1) ? 1 : page + 1,
    pageCount: Number(data?.page_count) || 1,
  };
}
