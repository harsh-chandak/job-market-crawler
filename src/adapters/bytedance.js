/**
 * ByteDance "atsx" adapter — TikTok and ByteDance.
 *
 * One platform, two hosts, distinguished by a single header. The API is public:
 * no auth, no signature, no cookie, no CSRF token.
 *
 *   TikTok     POST https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts
 *              headers: content-type: application/json, website-path: tiktok
 *   ByteDance  POST https://jobs.bytedance.com/api/v1/public/supplier/search/job/posts
 *              headers: content-type: application/json, website-path: en
 *
 * `website-path` is mandatory and validated at the gateway — the ByteDance host
 * rejects anything but `en` with a bare `400 invalid request`, verified against
 * `bytedance`, `official`, `global`, `bd` and `career`.
 *
 * WHY THIS SOURCE IS CHEAP.
 *
 * The list response carries the full body. Every row has `description` AND
 * `requirement`, so there is no detail call, no hydrate stage, no per-job
 * fan-out — the thing that makes Workday and SmartRecruiters expensive simply
 * does not apply. Measured over the filtered US set: 585/585 rows have a body
 * over 400 characters, min 1,118, median 2,564, max 8,051.
 *
 * And `limit` is not clamped. limit=1000 returns all 635 matching TikTok rows in
 * a single 1.5s POST, so a whole board costs ONE request — cheaper per job than
 * any other adapter here, Workday's five POSTs included.
 *
 * SERVER-SIDE FILTERS, because most of the corpus is not ours.
 *
 * Unfiltered, TikTok reports 3,830 open postings spanning Sales, Operations and
 * Marketing across every country it operates in. Two filters are honoured
 * server-side and cut that to the part worth ingesting:
 *
 *   job_category_id_list: [R&D]      3,830 -> 1,104
 *   recruitment_id_list:  ["1"]      (Experienced; drops Intern and Campus)
 *   both together                    3,830 ->   635
 *
 * `job_type_id_list` is the name that looks right in the filter config and is
 * silently IGNORED — the count comes back unchanged at 3,830. `job_category_id_list`
 * is the one that works. Both were verified by counting, not by reading the bundle.
 *
 * Country is NOT filtered here. `location_code_list` only accepts city codes —
 * passing the country node's own code (`CN_6`, United States of America) returns
 * zero — and enumerating US cities would silently drop any city ByteDance opens
 * next. The screen's US gate already does this correctly against the full
 * "City, State, Country" string, which is why locationsOf() below emits the whole
 * chain. Same reasoning as the BofA adapter: page the source, let the
 * deterministic screen filter.
 *
 * THE HONEST CAVEAT: THERE IS NO POSTING DATE. ANYWHERE.
 *
 * Not in the row, not in a detail call, not on the public job page. `job_post_info`
 * is the only date-shaped field and it is null on all 1,052 rows fetched —
 * along with `department_info`, `job_subject`, `tag_list`, `vacancies`,
 * `process_type` and `channel_online_status`, all of which the public API
 * returns as null even though the schema has them.
 *
 * The ids look like snowflakes and are tempting, but the decode does not hold
 * up: at a 22-bit shift the corpus spans 2,661 days, which is not a plausible
 * age range for open requisitions, and the largest id lands 16 months in the
 * future. The list is not reliably id-ordered either — 35 inversions across
 * 500 rows — so server order carries no recency signal to preserve or sort on.
 *
 * So `postedAtClaimed` is null, deliberately. The poller then falls back to
 * `firstSeenAt`, which its own header calls the only freshness ground truth, and
 * that is exactly right here: a posting is new when an id we have never seen
 * appears. What it costs is the first sweep, which ingests the whole standing
 * backlog as though it were posted today. That is a one-time event, it is
 * bounded, and it is the reason registerByteDance defaults to enabled:false.
 */

import { postJson } from "../util/http.js";
import { sha256 } from "../util/normalize.js";

const PATH = "/api/v1/public/supplier/search/job/posts";

// R&D. Sibling top-level categories are Operations, Sales, Product, Marketing,
// Corporate Function / Support, Design, Legal — none of which we hire into.
export const RND_CATEGORY_ID = "6704215862603155720";
// 1 = Experienced. 2 = Campus. Interns arrive under Campus and the screen
// rejects them on title anyway, but not fetching them is cheaper than screening
// them out.
export const EXPERIENCED = "1";

// One request per board is the norm; this only exists so a board that grows an
// order of magnitude cannot turn one poll into an unbounded read.
const MAX_JOBS = Number(process.env.BYTEDANCE_MAX_JOBS || 1000);

/**
 * The two boards. `token` is the pipeline's company key, not ByteDance's.
 */
export const BYTEDANCE_BOARDS = [
  {
    token: "tiktok",
    name: "TikTok",
    btHost: "api.lifeattiktok.com",
    btWebsitePath: "tiktok",
  },
  {
    token: "bytedance",
    name: "ByteDance",
    btHost: "jobs.bytedance.com",
    btWebsitePath: "en",
  },
];

/** Both public job pages resolve; verified 200 with the posting rendered. */
export function applyUrlFor(company, id) {
  return company.btWebsitePath === "tiktok"
    ? `https://lifeattiktok.com/search/${id}`
    : `https://jobs.bytedance.com/en/position/${id}/detail`;
}

/**
 * city_info is a linked list from city up to country:
 *   {en_name:"San Jose", parent:{en_name:"California", parent:{en_name:"United
 *    States of America", parent:null}}}
 *
 * The whole chain is emitted as one "San Jose, California, United States of
 * America" string because the US gate reads country names and state names out of
 * the text — the bare city alone would classify Vancouver or London as US-
 * ambiguous. Depth is 3 for every US row observed.
 */
export function locationsOf(row) {
  const parts = [];
  let node = row?.city_info;
  const guard = new Set();
  while (node && !guard.has(node)) {
    guard.add(node);
    const name = String(node.en_name || node.i18n_name || "").trim();
    if (name && !parts.includes(name)) parts.push(name);
    node = node.parent;
  }
  return parts.length ? [parts.join(", ")] : [];
}

/**
 * `description` and `requirement` are PLAIN TEXT with real newlines, not HTML —
 * verified across 585 rows: zero HTML tags, zero character entities.
 *
 * So htmlToText must not be applied unconditionally here, even though every
 * other adapter does. Its tag strip is `<[^>]+>`, and the corpus contains a
 * posting listing "<a-frame>" as a framework alongside Three.js — running the
 * HTML path over plain text would silently delete it. The sniff below only
 * converts when a real tag is present, so the adapter stays correct if
 * ByteDance ever switches these fields to HTML.
 */
const LOOKS_HTML = /<(p|br|div|li|ul|ol|strong|em|span|h[1-6])\b[^>]*>/i;

export function bodyOf(row, htmlToText) {
  const parts = [];
  for (const raw of [row?.description, row?.requirement]) {
    const s = String(raw || "").trim();
    if (!s) continue;
    parts.push(LOOKS_HTML.test(s) && htmlToText ? htmlToText(s) : s);
  }
  return parts.join("\n\n").trim();
}

export function normalizePost(row, company, htmlToText) {
  const id = String(row?.id ?? "");
  return {
    sourceJobId: id,
    title: String(row?.title || "").trim(),
    description: bodyOf(row, htmlToText),
    locations: locationsOf(row),
    applyUrl: id ? applyUrlFor(company, id) : "",
    // Not null out of laziness — see the module header. There is no date field
    // in the payload, the detail page, or the id. Inventing one would poison
    // claimedLagMs, which the age gates read.
    postedAtClaimed: null,
    meta: {
      code: row?.code || null,
      category: row?.job_category?.en_name || null,
      recruitType: row?.recruit_type?.en_name || null,
    },
  };
}

function fingerprint(count, rows) {
  return `bd:${sha256(`${count}|${rows.map((r) => r?.id).join("|")}`)}`;
}

/**
 * Fetch one ByteDance-platform board.
 *
 * Same return shape as every other adapter. There is no ETag and no
 * Last-Modified on this endpoint, so change detection uses a count+id
 * fingerprint returned in `etag`, exactly as Workday and Microsoft do — the
 * poller stores and replays it with no special-casing.
 */
export async function fetchByteDance(company, opts = {}) {
  const host = company?.btHost;
  const websitePath = company?.btWebsitePath;
  if (!host || !websitePath) {
    return {
      status: "error",
      error: "missing_bt_host_or_website_path",
      jobs: [],
      httpStatus: 0,
    };
  }

  const res = await postJson(
    `https://${host}${PATH}`,
    {
      keyword: "",
      limit: MAX_JOBS,
      offset: 0,
      job_category_id_list: [RND_CATEGORY_ID],
      recruitment_id_list: [EXPERIENCED],
    },
    { timeout: opts.timeout, headers: { "website-path": websitePath } },
  );

  if (res.status !== "ok") {
    return {
      status: "error",
      error: res.error || `http_${res.httpStatus}`,
      jobs: [],
      httpStatus: res.httpStatus,
    };
  }

  // The gateway answers 200 with a non-zero `code` for application-level
  // failures, so an HTTP 200 alone does not mean success. Treating it as one is
  // how a rejected request becomes a board that silently reports zero openings.
  if (Number(res.data?.code) !== 0) {
    return {
      status: "error",
      error: `api_code_${res.data?.code}:${res.data?.message || ""}`.slice(
        0,
        80,
      ),
      jobs: [],
      httpStatus: res.httpStatus,
    };
  }

  const rows = Array.isArray(res.data?.data?.job_post_list)
    ? res.data.data.job_post_list
    : [];
  const count = Number(res.data?.data?.count ?? rows.length);

  const fp = fingerprint(count, rows);
  if (company.etag && company.etag === fp) {
    return {
      status: "not_modified",
      jobs: [],
      etag: fp,
      httpStatus: res.httpStatus,
    };
  }

  // htmlToText is imported lazily to avoid a load-order cycle: index.js imports
  // this module, so importing it back at module scope would evaluate index.js
  // before its exports exist.
  const { htmlToText } = await import("./index.js");

  const seen = new Set();
  const jobs = [];
  for (const row of rows) {
    const n = normalizePost(row, company, htmlToText);
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
    // limit is not clamped by the server, so this only trips if a board exceeds
    // BYTEDANCE_MAX_JOBS.
    cappedByMaxJobs: count > rows.length,
    total: count,
  };
}
