/**
 * SmartRecruiters detail hydration + apply-URL repair.
 *
 * The list adapter in ./index.js is a plain conditional GET and stays there —
 * unlike Workday it is neither POST-based nor paginated, so it does not need a
 * module of its own. What it cannot do is produce a body: the postings list
 * carries no description at all, and paying a detail call per job at poll time
 * would turn one request per board into a hundred.
 *
 * Same silent failure as Workday, and worse. Every SmartRecruiters row ever
 * ingested stored `description: ""`, so the scorer's 400-character floor
 * skipped all 334 of them — none has ever been scored. Verified against the
 * live board list:
 *
 *     GET https://api.smartrecruiters.com/v1/companies/AristaNetworks/postings?limit=3
 *     -> content[0] keys: company, creator, customField, defaultJobAd, department,
 *        experienceLevel, function, id, industry, jobAdId, language, location,
 *        name, ref, refNumber, releasedDate, typeOfEmployment, uuid, visibility
 *
 * Note what is NOT in that list: `applyUrl`. So `applyUrl: j.applyUrl || j.ref`
 * always fell through to `ref`, and `ref` is the API URL, not an application
 * form:
 *
 *     ref = https://api.smartrecruiters.com/v1/companies/AristaNetworks/postings/744000141561647
 *
 * That is what got written to `applyUrl` for all 334 rows, so every
 * SmartRecruiters card in the review queue pointed the reviewer at raw JSON.
 * Two defects, one root cause.
 *
 * The apply URL does not need the detail call to be fixed. `postingUrl` in the
 * detail payload is `/{identifier}/{id}-{slug}`, but the slug is decorative —
 * the slug-less form resolves on its own, verified 200 with the right posting:
 *
 *     https://jobs.smartrecruiters.com/AristaNetworks/744000141561647
 *     -> 200, no redirect, <title> "Technical Solutions Engineer - Cloud,
 *        Hyperscalers and AI networks | SmartRecruiters"
 *
 * So publicUrl() below is computed at poll time from fields the list already
 * has, and the reviewer gets a real link whether or not hydration ever runs.
 */

import { getJson } from "../util/http.js";
import { htmlToText } from "./index.js";

const API = "https://api.smartrecruiters.com/v1/companies";
const PUBLIC = "https://jobs.smartrecruiters.com";

/**
 * The public application page. Constructible from the list row, no detail call.
 * `identifier` is the company token as SmartRecruiters spells it, which is
 * case-sensitive in the path ("AristaNetworks", not "aristanetworks").
 */
export function publicUrl(identifier, postingId) {
  if (!identifier || !postingId) return "";
  return `${PUBLIC}/${encodeURIComponent(identifier)}/${encodeURIComponent(postingId)}`;
}

/**
 * The detail endpoint for one posting.
 *
 * Derived from (companyToken, sourceJobId) rather than parsed out of the stored
 * applyUrl. Workday has to parse, because reconstructing its path needs an
 * externalPath the poller does not keep — SmartRecruiters has no such problem,
 * and deriving means this keeps working for the rows whose applyUrl has already
 * been repaired to the jobs.smartrecruiters.com form.
 *
 * The legacy `ref` value is accepted as a fallback so rows written before the
 * fix can still be hydrated even if their companyToken is somehow missing.
 */
export function detailUrl(job = {}, company = null) {
  const identifier = company?.token || job.companyToken;
  const id = job.sourceJobId;
  if (identifier && id) {
    return `${API}/${encodeURIComponent(identifier)}/postings/${encodeURIComponent(id)}`;
  }
  const legacy = String(job.applyUrl || "");
  return legacy.startsWith(`${API}/`) ? legacy : null;
}

/**
 * Section order is deliberate and is not the order the API returns them in.
 *
 * `companyDescription` is recruiting boilerplate — the same 1,160 characters on
 * every Arista req. It goes last because the poller truncates at
 * MAX_DESC_CHARS (5,000), so whatever is last is what gets cut, and losing the
 * boilerplate is free while losing `qualifications` would remove the exact text
 * the work-authorisation and years-of-experience checks read.
 */
const SECTION_ORDER = [
  "jobDescription",
  "qualifications",
  "additionalInformation",
  "companyDescription",
];

/** jobAd.sections.<name>.text, HTML, any subset of which may be absent or "". */
export function extractBody(detail) {
  const sections = detail?.jobAd?.sections || {};
  const parts = [];
  for (const key of SECTION_ORDER) {
    const raw = sections[key]?.text;
    if (!raw) continue;
    const text = htmlToText(raw);
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

/**
 * Fetch the description for one SmartRecruiters job.
 *
 * Returns { status, description, ... } and never throws, for the same reason
 * hydrateWorkday does not: a hydrate stage that dies on one malformed board
 * stops hydrating every board queued behind it.
 *
 * Statuses beyond Workday's set, both of which callers may treat as failure
 * without losing anything:
 *   'gone'         — 404 RESOURCE_NOT_FOUND. The req was filled or pulled. This
 *                    is a closed posting, not a hydration fault, and the caller
 *                    should retire the row rather than flag it as unhydratable.
 *   'not_modified' — 304 against a stored detail ETag. The endpoint serves
 *                    `etag: W/"2233-..."` and honours If-None-Match (verified),
 *                    so re-hydrating an unchanged posting costs no body.
 */
export async function hydrateSmartRecruiters(job, company, opts = {}) {
  const url = detailUrl(job, company);
  if (!url)
    return {
      status: "error",
      error: "cannot_derive_detail_url",
      description: "",
    };

  const res = await getJson(url, {
    timeout: opts.timeout,
    etag: opts.etag || job.detailEtag,
  });

  if (res.status === "not_modified")
    return { status: "not_modified", description: "", httpStatus: 304 };

  if (res.status !== "ok")
    return {
      status: res.httpStatus === 404 ? "gone" : "error",
      error: res.error || `http_${res.httpStatus}`,
      httpStatus: res.httpStatus,
      description: "",
    };

  const text = extractBody(res.data);
  return {
    status: text.length > 0 ? "ok" : "empty",
    description: text,
    // The detail payload carries the real links. `applyUrl` has ?oga=true
    // appended; `postingUrl` is the clean canonical page, and is preferred
    // because the submit path opens it in a browser.
    applyUrl: res.data?.postingUrl || res.data?.applyUrl || "",
    // Not every posting is live: `active: false` shows up on reqs that are
    // still served but no longer accepting applications.
    active: res.data?.active !== false,
    etag: res.etag || null,
    httpStatus: res.httpStatus,
  };
}
