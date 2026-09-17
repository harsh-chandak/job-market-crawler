/**
 * Is this posting still open?
 *
 * A job that closed between being surfaced and being clicked looks exactly like a
 * broken link from the reviewer's side, and costs the same: attention spent, a
 * resume possibly rendered, a tab opened on a 404. Sampling 55 apply URLs found no
 * genuinely wrong URLs, so this is a staleness problem — the link was right when
 * it was written and the posting has since gone.
 *
 * CHECKED AGAINST EACH ATS'S OWN API, not by fetching the public page.
 *
 * Fetching the page does not work. Greenhouse answers a plain GET with 403 for
 * every job, live or not, so everything comes back "unknown". Ashby answers 200
 * for a posting id that has never existed, so everything comes back "live". A
 * checker that cannot distinguish a real job from an invented one is worse than no
 * checker, because its answers look like data.
 *
 * The ATS APIs are unambiguous, already trusted by the poller, and cheap. The page
 * fetch below survives only as the fallback for hosts with no API, where its
 * weaknesses are at least visible as "unknown" rather than confidently wrong.
 */
import { setTimeout as delay } from "node:timers/promises";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Phrases an ATS shows on a page that returns 200 for a closed req. */
const CLOSED_TEXT = [
  "no longer accepting applications",
  "this job is no longer available",
  "position has been filled",
  "job posting is no longer active",
  "this posting is closed",
  "sorry, this job is not available",
  "job not found",
];

/**
 * @returns {"live"|"dead"|"unknown"} — unknown on a network failure, because a
 * flaky connection must never be recorded as a closed requisition.
 */
export async function checkLive(url, { timeout = 15_000 } = {}) {
  if (!url) return { state: "unknown", reason: "no_url" };
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    return { state: "unknown", reason: String(e?.name || e).slice(0, 40) };
  }

  if (res.status === 404 || res.status === 410)
    return { state: "dead", reason: `http_${res.status}` };
  // 403 is usually a bot wall, not a closed job. Treating it as dead would bin
  // every posting on a host that dislikes automated GETs.
  if (res.status >= 400) return { state: "unknown", reason: `http_${res.status}` };

  let body = "";
  try {
    body = (await res.text()).slice(0, 200_000).toLowerCase();
  } catch {
    return { state: "unknown", reason: "unreadable_body" };
  }
  const hit = CLOSED_TEXT.find((p) => body.includes(p));
  if (hit) return { state: "dead", reason: `page_says:${hit.slice(0, 28)}` };

  return { state: "live", reason: `http_${res.status}` };
}

/**
 * Per-ATS liveness. Returns null when this ATS has no API check, so the caller
 * falls back to the page fetch rather than guessing.
 */
export async function checkLiveByAts(job, { timeout = 15_000, ashbyBoardCache } = {}) {
  const { ats, companyToken: t, sourceJobId: id } = job || {};
  if (!ats || !t || !id) return null;
  const get = async (url) => {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
      return r;
    } catch (e) {
      return { status: 0, _err: String(e?.name || e) };
    }
  };

  if (ats === "greenhouse") {
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs/${id}`);
    if (r.status === 404) return { state: "dead", reason: "greenhouse_404" };
    if (r.status === 200) return { state: "live", reason: "greenhouse_200" };
    return { state: "unknown", reason: `greenhouse_${r.status}` };
  }

  if (ats === "lever") {
    const r = await get(`https://api.lever.co/v0/postings/${t}/${id}`);
    if (r.status === 404) return { state: "dead", reason: "lever_404" };
    if (r.status === 200) return { state: "live", reason: "lever_200" };
    return { state: "unknown", reason: `lever_${r.status}` };
  }

  if (ats === "ashby") {
    // Ashby has no per-posting endpoint that 404s usefully, so ask the board and
    // look for the id. Cached per company because a board answers for all of its
    // jobs at once and checking fifty of them should be one request, not fifty.
    let ids = ashbyBoardCache?.get(t);
    if (!ids) {
      const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${t}`);
      if (r.status !== 200) return { state: "unknown", reason: `ashby_${r.status}` };
      let data;
      try {
        data = await r.json();
      } catch {
        return { state: "unknown", reason: "ashby_unparseable" };
      }
      ids = new Set((data?.jobs || []).map((x) => String(x.id)));
      ashbyBoardCache?.set(t, ids);
    }
    return ids.has(String(id))
      ? { state: "live", reason: "ashby_on_board" }
      : { state: "dead", reason: "ashby_off_board" };
  }

  return null;
}

/** Check many, gently. Concurrency is deliberately low: this is not a crawl. */
export async function checkMany(urls, { concurrency = 4, timeout = 15_000, pause = 120 } = {}) {
  const out = new Map();
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const u = queue.shift();
      out.set(u, await checkLive(u, { timeout }));
      if (pause) await delay(pause);
    }
  });
  await Promise.all(workers);
  return out;
}
