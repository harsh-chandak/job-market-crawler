/**
 * Company-level sponsorship signals.
 *
 * The JD is silent about work authorization on ~95% of postings, so
 * `workAuth: 'unknown'` is the norm and silence is NOT a green light. This
 * module answers the question the posting doesn't: has this employer actually
 * sponsored before, and can they support a STEM OPT extension?
 *
 * Sources:
 *   USCIS H-1B Employer Data Hub  — approvals/denials per employer per FY.
 *                                   Flat CSVs exist through FY2023; FY2024+
 *                                   moved behind a Tableau embed.
 *   DOL LCA disclosure data       — quarterly, has worksite city. Optional:
 *                                   dol.gov blocks automated download, so it is
 *                                   read from data/lca-*.csv if present.
 *
 * Match strategy is the hard part. ATS tokens are slugs ("andurilindustries")
 * and federal data has legal names ("ANDURIL INDUSTRIES, INC"), so both sides
 * are normalized to a despaced key and compared exactly, then by prefix.
 */

import { normCompany, CORP_SUFFIXES } from "./util/normalize.js";

/** "ANDURIL INDUSTRIES, INC" -> "andurilindustries"; "andurilindustries" -> same. */
export function slugKey(name = "") {
  return normCompany(name).replace(/\s+/g, "");
}

// Employers that can file H-1B year-round with no lottery. Worth its own tier:
// for someone who definitely needs sponsorship, dodging the cap is a materially
// different risk profile than winning a 25%-odds lottery.
const CAP_EXEMPT_PATTERNS = [
  /\buniversit(y|ies)\b/i,
  /\bcollege\b/i,
  /\bschool district\b/i,
  /\b(medical|cancer|children'?s) center\b/i,
  /\bhospital\b/i,
  /\bhealth system\b/i,
  /\bclinic\b/i,
  /\bresearch institute\b/i,
  /\binstitute of technology\b/i,
  /\bnational laborator(y|ies)\b/i,
  /\bfoundation\b/i,
  /\bacademy\b/i,
];

// normCompany strips corporate suffixes from SPACED legal names, but an ATS
// token has no spaces so nothing is stripped from it. That asymmetry means
// "palantirtechnologies" would never reach "PALANTIR TECHNOLOGIES INC" (which
// normalizes to "palantir"). So when the token is longer, the remainder is
// allowed if it is one or more known suffix words — but not arbitrary letters,
// which is what kept "intuitive" from swallowing "intuit".
const SUFFIX_SET = new Set(CORP_SUFFIXES.map((s) => s.replace(/\s+/g, "")));
// Geographic / boilerplate qualifiers ATS tokens carry that legal names don't:
// "doordashusa" -> DOORDASH INC. Kept to a closed list so it can't turn into
// generic fuzzy matching.
const QUALIFIERS = new Set([
  "usa", "us", "na", "namer", "global", "worldwide", "international",
  "careers", "jobs", "hq", "corporate", "team", "hiring", "talent",
]);

function remainderIsSuffixWords(rest) {
  if (/^\d{1,2}$/.test(rest)) return true; // "LinkedIn3"
  let r = rest;
  let guard = 0;
  while (r.length && guard++ < 4) {
    const hit = [...SUFFIX_SET, ...QUALIFIERS]
      .filter((w) => r.startsWith(w))
      .sort((a, b) => b.length - a.length)[0];
    if (!hit) return false;
    r = r.slice(hit.length);
  }
  return r.length === 0;
}

export function looksCapExempt(name = "") {
  return CAP_EXEMPT_PATTERNS.some((re) => re.test(name));
}

/**
 * Aggregate USCIS rows into one record per employer.
 * Row shape: { "Fiscal Year", Employer, "Initial Approval", "Initial Denial",
 *              "Continuing Approval", "Continuing Denial", NAICS, State, City }
 */
export function aggregateH1b(rows) {
  const byKey = new Map();

  for (const r of rows) {
    const name = (r.Employer || "").trim();
    if (!name) continue;
    const key = slugKey(name);
    if (!key || key.length < 3) continue;

    const initApp = Number(r["Initial Approval"] || 0) || 0;
    const initDen = Number(r["Initial Denial"] || 0) || 0;
    const contApp = Number(r["Continuing Approval"] || 0) || 0;
    const contDen = Number(r["Continuing Denial"] || 0) || 0;
    const fy = Number(r["Fiscal Year"] || 0) || null;

    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        key,
        names: new Set(),
        initialApprovals: 0,
        initialDenials: 0,
        continuingApprovals: 0,
        continuingDenials: 0,
        years: new Set(),
        states: new Set(),
        cities: new Set(),
        naics: new Set(),
        capExempt: false,
      };
      byKey.set(key, rec);
    }

    rec.names.add(name);
    rec.initialApprovals += initApp;
    rec.initialDenials += initDen;
    rec.continuingApprovals += contApp;
    rec.continuingDenials += contDen;
    if (fy) rec.years.add(fy);
    if (r.State) rec.states.add(String(r.State).trim().toUpperCase());
    if (r.City) rec.cities.add(String(r.City).trim().toUpperCase());
    if (r.NAICS) rec.naics.add(String(r.NAICS).trim());
    if (looksCapExempt(name)) rec.capExempt = true;
  }

  for (const rec of byKey.values()) {
    rec.names = [...rec.names];
    rec.years = [...rec.years].sort();
    rec.states = [...rec.states];
    rec.cities = [...rec.cities];
    rec.naics = [...rec.naics];
    // NOTE: staffing detection by NAICS does not work here. USCIS publishes
    // only 2-digit SECTOR codes (verified: 25 distinct values, max length 2),
    // and sector 56 lumps employment services in with waste management, call
    // centres and facilities support. Testing /^5613/ or n === "56" flagged
    // Gusto, The New York Times, OpenTable and Planet Labs as body shops.
    // NAICS is retained as informational only; staffing is name-matched in
    // scripts/disable-staffing.mjs, which is imprecise but doesn't produce
    // confident false positives.
    rec.staffing = false;
    rec.totalApprovals = rec.initialApprovals + rec.continuingApprovals;
    const denials = rec.initialDenials + rec.continuingDenials;
    rec.approvalRate =
      rec.totalApprovals + denials > 0
        ? rec.totalApprovals / (rec.totalApprovals + denials)
        : null;
    // Phoenix metro presence — a local sponsor is worth surfacing separately.
    rec.phoenix = rec.cities.some((c) =>
      /^(PHOENIX|TEMPE|SCOTTSDALE|CHANDLER|MESA|GILBERT|GLENDALE|PEORIA)$/.test(
        c,
      ),
    );
  }

  return byKey;
}

/**
 * Build a prefix index so "janestreet" can find "JANE STREET CAPITAL LLC".
 * Only keys >= MIN_PREFIX are indexed; shorter ones produce garbage matches.
 */
const MIN_PREFIX = 6;

export function buildIndex(byKey) {
  const exact = byKey;
  const byPrefix = new Map();
  for (const [key, rec] of byKey) {
    if (key.length < MIN_PREFIX) continue;
    const p = key.slice(0, MIN_PREFIX);
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(rec);
  }
  return { exact, byPrefix };
}

/**
 * Resolve one company token to a sponsorship record.
 * Returns { rec, matchType } — matchType is 'exact' | 'prefix' | null.
 *
 * Prefix matches are ranked by total approvals so a token that prefixes several
 * legal entities lands on the one that actually sponsors, and are only accepted
 * when the length difference is small enough to be a suffix, not a coincidence.
 */
export function matchCompany(token, index) {
  const key = slugKey(token);
  if (!key || key.length < 3) return { rec: null, matchType: null };

  const hit = index.exact.get(key);
  if (hit) return { rec: hit, matchType: "exact" };

  if (key.length < MIN_PREFIX) return { rec: null, matchType: null };

  const bucket = index.byPrefix.get(key.slice(0, MIN_PREFIX));
  if (!bucket) return { rec: null, matchType: null };

  const candidates = bucket
    .filter((r) => {
      const a = key;       // our ATS token
      const b = r.key;     // the federal legal name
      if (a === b) return true;

      // Token longer than the legal name: the extra must be a numeric suffix
      // (SmartRecruiters/Greenhouse disambiguators like "LinkedIn3"), never
      // letters — otherwise "intuitive" swallows "intuit".
      if (a.startsWith(b)) return remainderIsSuffixWords(a.slice(b.length));

      // Legal name longer than the token: the extra is a corporate qualifier
      // ("janestreet" -> "janestreetcapital"). Require a reasonably long token
      // so short generic words don't latch on — this is what stopped "citizen"
      // from matching "citizens financial".
      if (b.startsWith(a)) return a.length >= 8 && b.length - a.length <= 8;

      return false;
    })
    .sort((x, y) => y.totalApprovals - x.totalApprovals);

  if (!candidates.length) return { rec: null, matchType: null };
  return { rec: candidates[0], matchType: "prefix" };
}

/**
 * Turn a match into the stored verdict.
 *
 * 'strong'   — sponsored recently and at volume
 * 'yes'      — sponsored at some point
 * 'cap_exempt' — files year-round, no lottery
 * 'none'     — no record found. NOT proof they won't sponsor; smaller and newer
 *              companies are legitimately absent from a dataset ending FY2023.
 */
export function classifySponsorship(rec, { recentYears = [2022, 2023] } = {}) {
  if (!rec) {
    return {
      status: "none",
      h1bApprovals: 0,
      capExempt: false,
      staffing: false,
      years: [],
      confidence: "no_record",
    };
  }

  const recent = rec.years.some((y) => recentYears.includes(y));
  const approvals = rec.totalApprovals;

  let status;
  if (rec.capExempt) status = "cap_exempt";
  else if (recent && approvals >= 5) status = "strong";
  else if (approvals >= 1) status = "yes";
  else status = "none";

  return {
    status,
    h1bApprovals: approvals,
    initialApprovals: rec.initialApprovals,
    approvalRate: rec.approvalRate,
    capExempt: rec.capExempt,
    staffing: rec.staffing,
    naics: rec.naics.slice(0, 4),
    years: rec.years,
    states: rec.states.slice(0, 8),
    phoenix: rec.phoenix,
    legalNames: rec.names.slice(0, 3),
    confidence: recent ? "recent" : "stale",
  };
}
