/**
 * ATS adapters.
 *
 * Every adapter returns the same shape so the poller stays ATS-agnostic:
 *   { status: 'ok' | 'not_modified' | 'error', jobs: NormalizedJob[], etag, lastModified, httpStatus }
 *
 * NormalizedJob:
 *   { sourceJobId, title, description, locations[], applyUrl, postedAtClaimed, raw }
 *
 * Conditional GETs matter: most polls should come back 304 with no body, which
 * is what makes 3-minute polling on tier-S boards affordable.
 */

import { getJson } from "../util/http.js";
import { fetchWorkday } from "./workday.js";
import { publicUrl as smartRecruitersPublicUrl } from "./smartrecruiters.js";
import { fetchAmazon } from "./amazon.js";
import { fetchMicrosoft } from "./microsoft.js";
import { fetchBofa } from "./bofa.js";
import { fetchByteDance } from "./bytedance.js";

const UA = "job-hunt/0.1 (+personal job search tooling)";
const DEFAULT_TIMEOUT = Number(process.env.POLL_TIMEOUT_MS || 20_000);

/* ------------------------------------------------------------------ utils */

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&#x27;": "'",
  "&#x2F;": "/",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&ldquo;": '"',
  "&rdquo;": '"',
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

export function htmlToText(html = "") {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pushLoc(set, v) {
  if (!v) return;
  if (Array.isArray(v)) return v.forEach((x) => pushLoc(set, x));
  if (typeof v === "object") {
    return pushLoc(
      set,
      v.name ??
        v.location ??
        [v.city, v.region, v.country].filter(Boolean).join(", "),
    );
  }
  const s = String(v).trim();
  if (s) set.add(s);
}

/* --------------------------------------------------------------- adapters */

export const ADAPTERS = {
  greenhouse: {
    url: (t) =>
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=true`,
    parse(data) {
      const rows = Array.isArray(data?.jobs) ? data.jobs : [];
      return rows.map((j) => {
        const locs = new Set();
        pushLoc(locs, j.location);
        pushLoc(locs, j.offices);
        return {
          sourceJobId: String(j.id ?? j.internal_job_id ?? ""),
          title: String(j.title || "").trim(),
          description: htmlToText(j.content || ""),
          locations: [...locs],
          applyUrl: j.absolute_url || "",
          postedAtClaimed: j.updated_at || j.first_published || null,
          raw: undefined,
        };
      });
    },
  },

  lever: {
    url: (t) =>
      `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    parse(data) {
      const rows = Array.isArray(data) ? data : [];
      return rows.map((j) => {
        const locs = new Set();
        pushLoc(locs, j?.categories?.location);
        pushLoc(locs, j?.categories?.allLocations);
        pushLoc(locs, j?.workplaceType === "remote" ? "Remote" : null);
        return {
          sourceJobId: String(j.id ?? ""),
          title: String(j.text || "").trim(),
          description: j.descriptionPlain || htmlToText(j.description || ""),
          locations: [...locs],
          applyUrl: j.hostedUrl || j.applyUrl || "",
          postedAtClaimed: j.createdAt
            ? new Date(j.createdAt).toISOString()
            : null,
        };
      });
    },
  },

  ashby: {
    url: (t) =>
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}?includeCompensation=true`,
    parse(data) {
      const rows = Array.isArray(data?.jobs) ? data.jobs : [];
      return rows.map((j) => {
        const locs = new Set();
        pushLoc(locs, j.location);
        pushLoc(locs, j.secondaryLocations);
        pushLoc(locs, j.isRemote ? "Remote" : null);
        return {
          sourceJobId: String(j.id ?? ""),
          title: String(j.title || "").trim(),
          description:
            j.descriptionPlain || htmlToText(j.descriptionHtml || ""),
          locations: [...locs],
          applyUrl: j.applyUrl || j.jobUrl || "",
          postedAtClaimed: j.publishedAt || j.updatedAt || null,
        };
      });
    },
  },

  // `limit=100` with no `offset` is a deliberate truncation, not an oversight.
  // 191 tracked boards hold 87,232 postings between them and 100 boards have
  // more than one page, but the list is ordered newest-first (releasedDate
  // descending across the page; offset=100 lands on older dates), so the first
  // page IS the freshest slice. Same tradeoff WORKDAY_MAX_PAGES makes, and for
  // the same reason: this is a freshness pipeline, not an archive. `limit=200`
  // is silently clamped to 100 by the API.
  smartrecruiters: {
    url: (t) =>
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(t)}/postings?limit=100`,
    parse(data, company) {
      const rows = Array.isArray(data?.content) ? data.content : [];
      return rows.map((j) => {
        const locs = new Set();
        pushLoc(locs, j.location);
        const id = String(j.id ?? j.uuid ?? "");
        return {
          sourceJobId: id,
          title: String(j.name || "").trim(),
          // The list endpoint has no body; the detail call is per-job and not
          // worth it at poll time. Body-dependent checks degrade to 'unknown'
          // until hydrateSmartRecruiters fills it in — see ./smartrecruiters.js.
          description: "",
          locations: [...locs],
          // The list row has NO applyUrl field, so `j.applyUrl || j.ref` always
          // fell through to `ref` — and `ref` is the API URL, which sent every
          // reviewer to raw JSON instead of an application form. The public page
          // is constructible from fields we already have; the slug in the
          // canonical URL is decorative and the slug-less form resolves 200.
          applyUrl: smartRecruitersPublicUrl(
            j.company?.identifier || company?.token,
            id,
          ),
          postedAtClaimed: j.releasedDate || j.createdOn || null,
        };
      });
    },
  },
};

export function supportedAts() {
  // Workday is not in ADAPTERS because it is POST-based, paginated and has no
  // ETag — it gets its own module. It is still a first-class ATS here.
  return [
    ...Object.keys(ADAPTERS),
    "workday",
    "amazon",
    "microsoft",
    "bofa",
    "bytedance",
  ];
}

/**
 * Fetch one board.
 * @param {{ats:string, token:string, etag?:string, lastModified?:string}} company
 */
export async function fetchBoard(company, opts = {}) {
  if (company.ats === "workday") return fetchWorkday(company, opts);
  if (company.ats === "amazon") return fetchAmazon(company, opts);
  if (company.ats === "microsoft") return fetchMicrosoft(company, opts);
  if (company.ats === "bofa") return fetchBofa(company, opts);
  // TikTok and ByteDance share one platform and one adapter; the board's
  // btHost/btWebsitePath pick the host, the way wdHost/wdSite do for Workday.
  if (company.ats === "bytedance") return fetchByteDance(company, opts);
  // The Muse is an aggregator, not an employer board: one feed across thousands
  // of companies, walked a page at a time. Imported lazily for the same
  // load-order reason bytedance is.
  if (company.ats === "themuse") {
    const { fetchMuse } = await import("./themuse.js");
    return fetchMuse(company, opts);
  }

  const adapter = ADAPTERS[company.ats];
  if (!adapter) {
    return {
      status: "error",
      error: `no_adapter:${company.ats}`,
      jobs: [],
      httpStatus: 0,
    };
  }

  const res = await getJson(adapter.url(company.token), {
    etag: company.etag,
    lastModified: company.lastModified,
    timeout: opts.timeout,
  });

  if (res.status !== "ok") {
    return { ...res, jobs: [] };
  }

  let jobs = [];
  try {
    // `company` is passed so an adapter can fall back to the board token when
    // the payload does not repeat it (SmartRecruiters needs it to build the
    // public apply URL).
    jobs = adapter
      .parse(res.data, company)
      .filter((j) => j.sourceJobId && j.title);
  } catch (err) {
    return {
      status: "error",
      error: `parse_failed:${err?.message || err}`,
      jobs: [],
      httpStatus: res.httpStatus,
    };
  }

  return {
    status: "ok",
    jobs,
    etag: res.etag,
    lastModified: res.lastModified,
    httpStatus: res.httpStatus,
  };
}
