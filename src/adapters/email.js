/**
 * Job-alert email parser.
 *
 * This is the LinkedIn / Indeed ingestion path, and it is deliberately not a
 * scraper. Neither has a public jobs API for individuals, and automating the
 * logged-in site risks the account you also need for networking. Alert emails
 * are data those services choose to send you, so parsing your own inbox carries
 * none of that risk and gives comparable coverage.
 *
 * Intended wiring: a dedicated address per source (linkedin@, indeed@,
 * jobright@ …) so the envelope identifies the source with no parsing, then a
 * webhook or IMAP poll feeds the raw HTML here.
 *
 * Caveat worth knowing: LinkedIn job pages require auth for the full
 * description, so postings that arrive only via email carry title, company and
 * location but no body — body-dependent checks (work auth, YoE) degrade to
 * 'unknown', same as SmartRecruiters and Workday. The high-value case is when
 * an alert points at a company we already poll directly, which
 * `linkToAtsCandidate` detects so the row can be reconciled instead of
 * duplicated.
 */

import { htmlToText } from "./index.js";

/* ------------------------------------------------------------------ links */

const TRACKING_PARAMS = [
  /^utm_/i,
  /^trk$/i,
  /^trackingId$/i,
  /^refId$/i,
  /^lipi$/i,
  /^licu$/i,
  /^midToken$/i,
  /^midSig$/i,
  /^eid$/i,
  /^otpToken$/i,
  /^lgCta$/i,
  /^originalSubdomain$/i,
  /^src$/i,
  /^from$/i,
  /^campaign/i,
  /^ref$/i,
];

export function stripTracking(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key)))
        u.searchParams.delete(key);
    }
    u.hash = "";
    return u.toString().replace(/\?$/, "");
  } catch {
    return url;
  }
}

/** Extract every href from an HTML email. */
export function extractLinks(html = "") {
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].replace(/&amp;/g, "&").trim();
    if (/^(mailto:|tel:|#|javascript:)/i.test(raw)) continue;
    if (!/^https?:\/\//i.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

/* --------------------------------------------------------------- sources */

const SOURCES = [
  {
    name: "linkedin",
    // /comm/jobs/view/{id} in emails, /jobs/view/{id} on the site
    re: /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i,
    canonical: (id) => `https://www.linkedin.com/jobs/view/${id}/`,
  },
  {
    name: "indeed",
    re: /indeed\.com\/(?:viewjob|rc\/clk|job)[^"']*?[?&]jk=([a-f0-9]+)/i,
    canonical: (id) => `https://www.indeed.com/viewjob?jk=${id}`,
  },
  {
    name: "glassdoor",
    re: /glassdoor\.[a-z.]+\/job-listing\/[^"']*?jobListingId=(\d+)/i,
    canonical: (id) =>
      `https://www.glassdoor.com/job-listing/?jobListingId=${id}`,
  },
];

// If an alert links straight at a board we already poll, we can reconcile
// rather than create a duplicate row.
const ATS_LINK = [
  {
    ats: "greenhouse",
    re: /(?:job-)?boards\.greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/i,
  },
  { ats: "lever", re: /jobs\.lever\.co\/([a-z0-9_-]+)\/([a-f0-9-]+)/i },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9._-]+)\/([a-f0-9-]+)/i },
];

export function identifySource(url) {
  for (const s of SOURCES) {
    const m = url.match(s.re);
    if (m) return { source: s.name, id: m[1], canonical: s.canonical(m[1]) };
  }
  return null;
}

export function linkToAtsCandidate(url) {
  for (const a of ATS_LINK) {
    const m = url.match(a.re);
    if (m) return { ats: a.ats, token: m[1], sourceJobId: m[2] };
  }
  return null;
}

/* ---------------------------------------------------------------- fields */

/**
 * Alert emails put the title in the anchor text and the company/location in the
 * following line or two. Layouts change constantly, so this reads the plain-text
 * neighbourhood around the link rather than depending on any specific markup.
 */
export function extractCardFields(html, linkIndex) {
  const window = html.slice(Math.max(0, linkIndex - 200), linkIndex + 1200);
  const text = htmlToText(window)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // First substantial line after the anchor is usually the title.
  const title =
    text.find((l) => l.length > 3 && l.length < 140 && !/^https?:/i.test(l)) ||
    "";
  const idx = text.indexOf(title);
  const after = text.slice(idx + 1, idx + 4);

  // A location line contains a comma and a short region token, or "Remote".
  const location =
    after.find((l) => /remote/i.test(l) || (/,/.test(l) && l.length < 70)) ||
    "";
  const company = after.find((l) => l !== location && l.length < 80) || "";

  return { title, company, location };
}

/**
 * Parse one alert email into pipeline-shaped rows.
 * @returns {Array<{source, sourceJobId, title, company, locations, applyUrl, atsCandidate}>}
 */
export function parseAlertEmail(html = "", { defaultSource = null } = {}) {
  const links = extractLinks(html);
  const seen = new Set();
  const rows = [];

  for (const raw of links) {
    const ident = identifySource(raw);
    const ats = linkToAtsCandidate(raw);
    if (!ident && !ats) continue;

    const key = ident
      ? `${ident.source}:${ident.id}`
      : `${ats.ats}:${ats.token}:${ats.sourceJobId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const at =
      html.indexOf(raw.replace(/&/g, "&amp;")) >= 0
        ? html.indexOf(raw.replace(/&/g, "&amp;"))
        : html.indexOf(raw);
    const fields =
      at >= 0
        ? extractCardFields(html, at)
        : { title: "", company: "", location: "" };

    rows.push({
      source: ident?.source || defaultSource || ats?.ats || "email",
      sourceJobId: ident?.id || ats?.sourceJobId || null,
      title: fields.title,
      company: fields.company,
      locations: fields.location ? [fields.location] : [],
      applyUrl: stripTracking(ident?.canonical || raw),
      // description is unavailable from an alert email; body checks degrade to
      // 'unknown' downstream rather than silently passing
      description: "",
      atsCandidate: ats || null,
    });
  }

  return rows;
}
