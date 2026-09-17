/**
 * Company discovery: harvest ATS board tokens from public job feeds,
 * then verify every token against the live board API.
 *
 * Hand-written token lists are ~40% dead on arrival. This harvests tokens
 * from URLs that are known to resolve today, then proves each one.
 *
 * No API keys, no deps. Run: node seed/discover-companies.mjs
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 15_000;
const UA = "job-hunt-seed/0.1 (+personal job search tooling)";

/* ---------------------------------------------------------------- sources */
// Community-maintained feeds. Each is tried across a few likely paths since
// these repos rename branches/files periodically.
const SOURCES = [
  {
    name: "simplify-new-grad",
    urls: [
      "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
      "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/main/.github/scripts/listings.json",
    ],
  },
  {
    name: "simplify-internships-2026",
    urls: [
      "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
      "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/main/.github/scripts/listings.json",
    ],
  },
  {
    name: "vansh-internships-2026",
    urls: [
      "https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/dev/.github/scripts/listings.json",
      "https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/main/.github/scripts/listings.json",
    ],
  },
  {
    name: "cvrve-new-grad",
    urls: [
      "https://raw.githubusercontent.com/cvrve/New-Grad-2025/main/.github/scripts/listings.json",
      "https://raw.githubusercontent.com/cvrve/New-Grad-2026/main/.github/scripts/listings.json",
    ],
  },
];

/* ------------------------------------------------------------- extraction */
// Tokens that show up as path segments but aren't companies.
const TOKEN_DENYLIST = new Set([
  "embed",
  "v1",
  "boards",
  "job_board",
  "jobs",
  "api",
  "search",
  "company",
  "companies",
  "p",
  "c",
  "job",
  "posting",
  "postings",
  "www",
]);

const EXTRACTORS = [
  {
    ats: "greenhouse",
    re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-zA-Z0-9_-]+)/gi,
  },
  { ats: "lever", re: /jobs\.(?:eu\.)?lever\.co\/([a-zA-Z0-9_-]+)/gi },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\/([a-zA-Z0-9_.-]+)/gi },
  {
    ats: "smartrecruiters",
    re: /(?:jobs|careers)\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/gi,
  },
  { ats: "workable", re: /apply\.workable\.com\/([a-zA-Z0-9_-]+)/gi },
  { ats: "recruitee", re: /([a-zA-Z0-9_-]+)\.recruitee\.com/gi },
  // Workday needs tenant + site; capture both so we can build the endpoint later.
  {
    ats: "workday",
    re: /([a-zA-Z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([a-zA-Z0-9_-]+)/gi,
    workday: true,
  },
];

function extractTokens(rawText, sourceName) {
  const found = new Map(); // key -> record

  for (const { ats, re, workday } of EXTRACTORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(rawText)) !== null) {
      const token = (m[1] || "").trim();
      if (!token || token.length < 2) continue;
      if (TOKEN_DENYLIST.has(token.toLowerCase())) continue;

      const key = workday
        ? `workday:${token}:${m[3]}`
        : `${ats}:${token.toLowerCase()}`;
      if (found.has(key)) continue;

      const rec = { ats, token, sources: [sourceName] };
      if (workday) {
        rec.wdHost = m[2]; // wd1 / wd3 / wd5
        rec.wdSite = m[3]; // the careers site slug
      }
      found.set(key, rec);
    }
  }
  return found;
}

/* ----------------------------------------------------------- verification */
// One live endpoint per ATS. A 200 with a parseable job array proves the token.
const VERIFIERS = {
  greenhouse: {
    url: (t) =>
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    count: (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null),
  },
  lever: {
    url: (t) =>
      `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    count: (d) => (Array.isArray(d) ? d.length : null),
  },
  ashby: {
    url: (t) =>
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    count: (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null),
  },
  smartrecruiters: {
    url: (t) =>
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(t)}/postings?limit=100`,
    count: (d) => (Array.isArray(d?.content) ? d.content.length : null),
  },
  // workable + recruitee + workday: no clean unauthenticated list endpoint.
  // Kept in the output as `unverified` so the Workday adapter can pick them up.
};

async function fetchJson(url, { timeout = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "application/json" },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    try {
      return { ok: true, status: res.status, data: JSON.parse(text), text };
    } catch {
      return { ok: true, status: res.status, data: null, text };
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error:
        err?.name === "AbortError" ? "timeout" : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function verify(rec) {
  const v = VERIFIERS[rec.ats];
  if (!v) return { ...rec, status: "unverified", openRoles: null };

  const res = await fetchJson(v.url(rec.token));
  if (!res.ok) {
    return {
      ...rec,
      status: res.status === 404 ? "dead" : "error",
      httpStatus: res.status,
      openRoles: null,
    };
  }
  const n = v.count(res.data);
  if (n === null)
    return { ...rec, status: "error", httpStatus: res.status, openRoles: null };
  return {
    ...rec,
    status: "live",
    httpStatus: res.status,
    openRoles: n,
    boardUrl: v.url(rec.token),
  };
}

/* ------------------------------------------------------------------ pool */
async function pool(items, limit, worker, onProgress) {
  const results = [];
  let i = 0;
  let done = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
        done++;
        if (onProgress && done % 25 === 0) onProgress(done, items.length);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ main */
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("[seed] harvesting ATS tokens from public feeds\n");

  const all = new Map();
  const sourceReport = [];

  for (const src of SOURCES) {
    let hit = null;
    for (const url of src.urls) {
      const res = await fetchJson(url);
      if (res.ok && res.text) {
        hit = { url, text: res.text };
        break;
      }
    }
    if (!hit) {
      console.log(
        `  ✗ ${src.name.padEnd(26)} unreachable (all candidate paths failed)`,
      );
      sourceReport.push({ source: src.name, ok: false, tokens: 0 });
      continue;
    }

    const found = extractTokens(hit.text, src.name);
    for (const [key, rec] of found) {
      if (all.has(key)) all.get(key).sources.push(src.name);
      else all.set(key, rec);
    }
    console.log(
      `  ✓ ${src.name.padEnd(26)} ${String(found.size).padStart(5)} tokens  (${(hit.text.length / 1024 / 1024).toFixed(1)} MB)`,
    );
    sourceReport.push({
      source: src.name,
      ok: true,
      url: hit.url,
      tokens: found.size,
    });
  }

  const candidates = [...all.values()];
  console.log(`\n[seed] ${candidates.length} unique candidate tokens`);

  const byAts = candidates.reduce(
    (a, c) => ((a[c.ats] = (a[c.ats] || 0) + 1), a),
    {},
  );
  console.log("[seed] by ATS:", JSON.stringify(byAts));

  const verifiable = candidates.filter((c) => VERIFIERS[c.ats]);
  console.log(
    `\n[seed] verifying ${verifiable.length} tokens against live board APIs (concurrency ${CONCURRENCY})…`,
  );

  const verified = await pool(verifiable, CONCURRENCY, verify, (d, t) =>
    process.stdout.write(`\r  ${d}/${t}`),
  );
  process.stdout.write("\r");

  const unverifiable = candidates
    .filter((c) => !VERIFIERS[c.ats])
    .map((c) => ({ ...c, status: "unverified", openRoles: null }));

  const companies = [...verified, ...unverifiable].sort(
    (a, b) => (b.openRoles ?? -1) - (a.openRoles ?? -1),
  );

  const live = companies.filter((c) => c.status === "live");
  const dead = companies.filter((c) => c.status === "dead");
  const errored = companies.filter((c) => c.status === "error");
  const unver = companies.filter((c) => c.status === "unverified");
  const totalRoles = live.reduce((s, c) => s + (c.openRoles || 0), 0);

  const outPath = join(OUT_DIR, "companies.json");
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceReport,
        stats: {
          candidates: candidates.length,
          live: live.length,
          dead: dead.length,
          errored: errored.length,
          unverified: unver.length,
          openRolesAcrossLiveBoards: totalRoles,
        },
        companies,
      },
      null,
      2,
    ),
  );

  console.log("\n──────────────── result ────────────────");
  console.log(`  live (verified)     ${String(live.length).padStart(5)}`);
  console.log(`  dead (404)          ${String(dead.length).padStart(5)}`);
  console.log(`  errored             ${String(errored.length).padStart(5)}`);
  console.log(`  unverified (wd/etc) ${String(unver.length).padStart(5)}`);
  console.log(`  open roles on live  ${String(totalRoles).padStart(5)}`);
  console.log(`\n  → ${outPath}`);

  console.log("\n  top 15 boards by open roles:");
  for (const c of live.slice(0, 15)) {
    console.log(
      `    ${String(c.openRoles).padStart(5)}  ${c.ats.padEnd(16)} ${c.token}`,
    );
  }
}

main().catch((err) => {
  console.error("[seed] fatal:", err);
  process.exit(1);
});
