/**
 * Deterministic pre-filter. Runs before any LLM call.
 *
 * Rewritten from job-alerts/src/exclusion-check.js, which had three real bugs:
 *   1. `ex.replace(/\W/g, '')` collapsed multi-word entries before building the
 *      regex, so `\bvicepresident\b` / `\b5years\b` / `\bteamlead\b` could never
 *      match — roughly half the EXCLUDE list was dead code.
 *   2. ~10 duplicated entries.
 *   3. INCLUDE used substring matching, so 'ml' matched "HTML/CSS Designer".
 *
 * Two further rules learned from the first live poll:
 *   - Role family is decided by the TITLE only. Scanning the body let any JD
 *     that merely mentions "software engineer" grant a family, which is how
 *     "Cloud FinOps Business Partner" got through.
 *   - Location is a hard gate. On OPT the work has to be in the US.
 */

import { norm } from "./util/normalize.js";
import { locationVerdictWithBody, isPhoenixMetro } from "./util/location.js";

/* ------------------------------------------------------------------ terms */

// Strong title signals only — these must appear in the title itself.
export const ROLE_FAMILIES = {
  swe: [
    "software engineer",
    "software developer",
    "software development engineer",
    "full stack",
    "fullstack",
    "full-stack",
    "backend engineer",
    "back end engineer",
    "frontend engineer",
    "front end engineer",
    "backend developer",
    "frontend developer",
    "web developer",
    "platform engineer",
    "infrastructure engineer",
    "product engineer",
    // "application engineer" was here and earned nothing. Measured over the 1,614
    // scored postings that pass this screen: 30 carried the title, 0 reached fit
    // 70, the best was 60. In practice it is an industrial title — field
    // application engineering for automation, injection moulding, servo drives,
    // electron microscopy — and it is now in EXCLUDE_DISCIPLINE instead.
    "systems engineer",
    "api engineer",
    "sde",
    "swe",
    "site reliability engineer",
    "devops engineer",
    "cloud engineer",
  ],
  ai: [
    "machine learning engineer",
    "ml engineer",
    "ai engineer",
    "applied scientist",
    "applied ai",
    "llm engineer",
    "genai engineer",
    "generative ai engineer",
    "research engineer",
    "ai/ml engineer",
    "mlops engineer",
    "data engineer",
    "machine learning",
    "deep learning",
    "nlp engineer",
    "ai infrastructure",
  ],
};

// Seniority / scope we are not eligible for. Deduped.
const EXCLUDE_SENIORITY = [
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "expert",
  "seasoned",
  "distinguished",
  "manager",
  "management",
  "director",
  "head of",
  "vp",
  "vice president",
  "chief",
  "supervisor",
  "team lead",
  "tech lead",
  "technical lead",
  "project lead",
  "product lead",
  "architect",
  "fellow",
  "ii i",
  "iii",
  "iv",
];

// Adjacent-but-wrong roles. Everything here surfaced in the first live poll.
const EXCLUDE_DISCIPLINE = [
  "product owner",
  "product manager",
  "program manager",
  "project manager",
  "business partner",
  "business analyst",
  "strategist",
  "scrum master",
  "account executive",
  "account manager",
  "sales representative",
  // Pre-sales. These carry a dense technical vocabulary in the body — cloud,
  // APIs, integrations — so keyword scoring rates them highly while the actual
  // job is quota-carrying customer work. Samsara alone put five "Sales
  // Engineer" reqs into the top-100 pre-rank. Matched on title only.
  "sales engineer",
  "presales",
  "pre-sales",
  "solutions consultant",
  "partner engineer",
  "sales specialist",
  "customer engineer",
  "technical account",
  "customer success",
  "recruiter",
  "marketing",
  "financial",
  "finance",
  "accountant",
  "attorney",
  "legal counsel",
  "domain leader",
  "escalation",
  "incident engineer",
  "provisioning",
  "field service",
  "technical writer",
  "ux designer",
  "ui designer",
  "nurse",
  "therapist",
  "driver",
  "mechanic",
  "caregiver",
  "teacher",
  "instructor",
  "security engineer",
  "network engineer",
  "hardware engineer",
  "firmware",
  "mechanical engineer",
  "electrical engineer",
  "civil engineer",
  "chemical engineer",
  // Application engineering is an industrial discipline, not a software one:
  // automation cabinets, injection moulding, servo controllers, electron
  // microscopy. It sat in ROLE_FAMILIES.swe and granted a family to all of
  // them. Measured over the postings that passed this screen and were then
  // scored: 30 titles, 0 reached fit 70, best 60.
  "application engineer",
  "applications engineer",
];

// Hard knockouts anywhere in the posting body.
/**
 * Statements that genuinely rule the candidate out, as PATTERNS not substrings.
 *
 * This was a literal-substring list matched with word boundaries, and it leaked in
 * two ways that matter more than any other filter in the system — this is the one
 * hard constraint, everything else is a preference.
 *
 * Plurals failed. "green card holder" does not match "green card holders", because
 * the boundary after "holder" is not a boundary before "s". A posting saying
 * "US citizens or green card holders" sailed through.
 *
 * Phrasing variants were missing. The list had "does not sponsor" and "unable to
 * provide sponsorship" but not "does not offer sponsorship" or "unable to offer
 * visa sponsorship" — both extremely common, both passing.
 *
 * Measured before this change: of six explicit blockers written the way employers
 * actually write them, four passed.
 *
 * Patterns are deliberately anchored on the negation so that a posting which
 * SPONSORS is never caught. "We sponsor visas" and "sponsorship available" must
 * pass, and the tests pin that in both directions.
 */
const WORK_AUTH_KNOCKOUT_RES = [
  // Citizenship / permanent residence demanded
  /\bmust be (a |an )?(us|u\.s\.|united states) citizens?\b/,
  /\b(us|u\.s\.|united states) citizenship (is )?(required|mandatory)\b/,
  /\bcitizenship (is )?required\b/,
  /\b(us|u\.s\.) citizens? (or|and) (green card holders?|permanent residents?)\b/,
  /\b(green card holders?|permanent residents?) (only|required)\b/,
  /\bmust be (a |an )?(green card holder|permanent resident)s?\b/,
  /\bpermanent (work )?authorization\b[^.]{0,60}\bwithout\b[^.]{0,30}\bsponsorship\b/,

  // Clearance, which requires citizenship in practice
  /\bsecurity clearance\b/,
  /\btop secret\b/,
  /\bts\/sci\b/,
  /\bactive clearance\b/,
  /\bpublic trust\b/,

  // Sponsorship refused, in the phrasings employers actually use
  /\b(do|does|will|can|are|is)( not|n't) (be able to )?(sponsor|provide|offer|support)\b[^.]{0,40}\b(sponsorship|visas?|immigration)\b/,
  // The trailing group is REQUIRED. Written optional, this matched "unable to
  // offer relocation support" and would have binned a perfectly applicable job
  // over a sentence about moving expenses.
  /\bunable to (sponsor|provide|offer|support)\b[^.]{0,40}\b(sponsorship|visas?|immigration|work authorization)\b/,
  /\bno (visa )?sponsorship\b/,
  /\bsponsorship is not (available|offered|provided)\b/,
  /\bwithout (the need for |requiring )?sponsorship\b/,
  /\bnot (require|need) sponsorship (now or in the future|currently or in the future)\b/,
  /\bmust not require sponsorship\b/,
  /\bdoes not (offer|provide) (visa )?sponsorship\b/,
];

// Kept for the reason string and for callers that want the plain vocabulary.
const WORK_AUTH_KNOCKOUTS = [
  "must be a us citizen",
  "us citizenship is required",
  "green card holders",
  "security clearance",
  "we do not sponsor",
  "unable to offer visa sponsorship",
  "does not offer sponsorship",
  "without sponsorship",
];

/** The first knockout pattern this text trips, as readable text, or null. */
export function workAuthKnockout(text = "") {
  const t = norm(text);
  for (const re of WORK_AUTH_KNOCKOUT_RES) {
    const m = re.exec(t);
    if (m) return m[0].slice(0, 60);
  }
  return null;
}


// Soft flags. ITAR / export-control language is frequently conditional
// boilerplate ("may need to meet certain legal status requirements"), but it
// does often imply US-person status. Flag and deprioritize; don't hard-reject —
// let the LLM scoring stage read the surrounding context.
const WORK_AUTH_SOFT = ["itar", "export control", "us person", "u.s. person"];

const SPONSORSHIP_POSITIVE = [
  "will sponsor",
  "we sponsor",
  "visa sponsorship available",
  "sponsorship is available",
  "h-1b",
  "h1b",
  "e-verify",
  "cap-exempt",
  "cap exempt",
  "stem opt",
  "we welcome international",
  "immigration support",
];

const NOISE = [
  "privacy",
  "cookie",
  "terms of service",
  "terms of use",
  "sitemap",
  "unsubscribe",
  "help center",
  "contact us",
  "faq",
  "accessibility",
  "legal notice",
];

/* ------------------------------------------------------------- primitives */

/**
 * Word-boundary matcher that preserves multi-word phrases.
 * This is the bug fix: escape each token, join with \s+, keep the boundaries.
 */
function phraseRe(phrase) {
  const parts = String(phrase)
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![a-z0-9])${parts.join("\\s+")}(?![a-z0-9])`, "i");
}

const compiled = new Map();
function matches(text, phrase) {
  let re = compiled.get(phrase);
  if (!re) {
    re = phraseRe(phrase);
    compiled.set(phrase, re);
  }
  return re.test(text);
}

function matchesAny(text, phrases) {
  for (const p of phrases) if (matches(text, p)) return p;
  return null;
}

/* ------------------------------------------------------------------ rules */

/** Years-of-experience floor stated in the body. Returns the max found, or null. */
export function extractYoE(description = "") {
  const t = norm(description)
    // Job posts write ranges with typographic dashes far more often than ASCII
    // hyphens. "3–5 years" and "2–12+ years" both went undetected, and the whole
    // years-of-experience screen was silently absent on those postings.
    .replace(/[\u2010-\u2015\u2212]/g, "-");

  const out = [];
  const patterns = [
    // A range gives its LOW end. "2-12+ years" means two years is the entry bar,
    // not twelve; postings state a band because they will hire across it. Taking
    // the high end reads a wide-open req as a senior-only one.
    /(\d{1,2})\s*-\s*(\d{1,2})\s*\+?\s*years?/g,
    // "5+ years working on…", "5 years building…". Requiring the literal word
    // "experience" after the phrase was the second half of the leak: a posting
    // saying "5+ years working on complex systems" stated its bar plainly and
    // was read as stating nothing.
    // The qualifier list used to be fixed — relevant, professional, industry,
    // hands-on, full-time — and anything else broke the match. Scout Motors
    // wrote "8+ years Practical experience with LLM platforms" and the screen
    // read no requirement at all, so an eight-year req reached the queue at
    // fit 92. Any one or two words may sit between the count and the noun; the
    // match must still land on the noun, so "5 years ago the company started
    // building" cannot fire.
    /(\d{1,2})\s*\+?\s*years?(?:\s+of)?\s+(?:[a-z][a-z-]*\s+){0,2}(?:experience|work|working|building|developing|engineering|software|programming|development)/g,
    /minimum\s+(?:of\s+)?(\d{1,2})\s*\+?\s*years?/g,
    /at\s+least\s+(\d{1,2})\s*\+?\s*years?/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 30) out.push(n);
    }
  }
  if (!out.length) return null;

  // The MINIMUM across everything stated. Postings routinely list alternatives —
  // "MS and 2 years, or BS and 4 years" — and the lowest of those is the bar the
  // candidate has to clear. Taking the max rejected reqs the candidate qualified
  // for under one of the stated paths.
  return Math.min(...out);
}

/**
 * Which resume variant this maps to — TITLE ONLY, deliberately.
 * The body fallback was removed: it granted a family to any posting whose JD
 * happened to mention an engineering term.
 */
export function classifyRoleFamily(title = "") {
  const t = norm(title);
  const scores = {};
  let best = null;
  for (const [family, terms] of Object.entries(ROLE_FAMILIES)) {
    let s = 0;
    let longest = 0;
    for (const term of terms) {
      if (matches(t, term)) {
        s += 1;
        longest = Math.max(longest, term.length);
      }
    }
    scores[family] = s;
    // Longest matched phrase wins ties: "ml engineer" beats a stray "sde".
    if (s > 0 && (!best || longest > best.longest))
      best = { family, score: s, longest };
  }
  return best
    ? { family: best.family, score: best.score, scores }
    : { family: null, score: 0, scores };
}

/**
 * screen(job) -> { pass, reasons[], roleFamily, yoe, workAuth, location }
 *
 * `workAuth`:
 *   'blocked'  — explicit knockout in the body
 *   'positive' — explicit sponsorship-friendly signal
 *   'unknown'  — silence. NOT a green light; the company-level H-1B/E-Verify
 *                join decides. See scripts/enrich-sponsorship.mjs.
 */
/* ------------------------------------------------- eligibility knockouts */
// Four patterns that recurred across a 200-posting manual scoring pass. Each
// was being applied by hand, which is exactly the judgement that should not be
// repeated another 1,400 times.

// 1. EXPORT CONTROL. An active clearance requires US citizenship, and ITAR/EAR
// "US Person" status is unavailable on F-1 OPT. Several of these were otherwise
// excellent on level and title, which is precisely why the rule is needed: fit
// scoring ranks them highly and nothing downstream catches the blocker.
// Matched as IMPERATIVE phrasing, not keywords. Bare "export control" is legal
// boilerplate on a large share of ordinary tech postings — Databricks carries
// "If access to export-controlled technology is required ... it is within
// Employer's discretion whether to apply for a U.S. government license", which
// is a conditional that leaves the door open, and keyword matching rejected two
// of their backend reqs on it. A hard bar states a requirement; boilerplate
// states a possibility, so the regexes below require the imperative.
const EXPORT_CONTROL_RE = [
  [
    /\bmust be (?:an?\s+)?(?:u\.?s\.?|united states)\s+(?:person|citizen)\b/i,
    "must be a US person",
  ],
  [
    /\b(?:u\.?s\.?|united states)\s+citizenship\s+(?:is\s+)?required\b/i,
    "US citizenship required",
  ],
  [
    /\b(?:u\.?s\.?|united states)\s+person\s+status\s+(?:is\s+)?required\b/i,
    "US person status required",
  ],
  [
    /\b(?:requires?|must (?:have|possess|hold)|active)\s+(?:an?\s+)?(?:active\s+)?(?:security|top[- ]secret|secret)\s+clearance\b/i,
    "clearance required",
  ],
  [/\bts\/sci\b/i, "TS/SCI"],
  [/\bpolygraph\b/i, "polygraph"],
  [/\bitar[- ]restricted\b/i, "ITAR-restricted"],
  [
    /\bcitizenship\s+(?:is\s+)?(?:a\s+)?requirement\b/i,
    "citizenship requirement",
  ],
  [/\bactive clearance\b/i, "active clearance"],
];

/** First imperative export-control requirement in the text, or null. */
export function exportControlBar(text = "") {
  const t = String(text);
  for (const [re, label] of EXPORT_CONTROL_RE) if (re.test(t)) return label;
  return null;
}

// Blanket rejection only where the employer enforces US Person status
// essentially without exception. Anduril and the smaller defence shops are NOT
// listed here: their reqs vary, so they are soft-flagged on the employer and
// hard-rejected only when a posting states the requirement. Rejecting a whole
// employer on reputation would discard real openings.
const EXPORT_CONTROL_EMPLOYERS = ["spacex"];
const DEFENCE_EMPLOYERS = [
  "anduril",
  "allen control",
  "beacon ai",
  "shield ai",
  "epirus",
  "saronic",
];
// Palantir splits by track: Commercial is open, Defense/Intel/USG are not.
const DEFENCE_TRACK = [
  "defense",
  "defence",
  "intelligence",
  "us government",
  "national security",
];

// 2. INTERNSHIPS. Post-completion OPT carries no active enrolment, so intern
// reqs are unusable regardless of content. Netic, Nuro, Postman and Anduril
// each post an intern variant beside a new-grad req for the same work, so the
// right outcome is "take the sibling", not "avoid the company".
// \bintern\b deliberately does not match "internal".
const INTERN_RE = /\b(intern|interns|internship|co-?op)\b/i;

// 3. COHORT YEAR. "2027 Early Career" targets the class after this one.
// Rejected only when EVERY year in the title is later than the graduation year,
// so an inclusive range such as "New Grad 2026-2027" still passes.
const GRAD_YEAR = Number(process.env.GRAD_YEAR || 2026);
const YEAR_RE = /\b(20\d{2})\b/g;

// 4. RESEARCH TRACK. Applied Scientist and Research Scientist reqs screen for
// research credentials, usually a PhD and publications.
//
// This one is a SOFT FLAG rather than a rejection, which is a deliberate
// departure from the other three. The content on several matched more closely
// than most SDE reqs did: multi-agent orchestration, GenAI evaluation, agentic
// reasoning. The blocker is the hiring track, not the work, and teams often
// post an SDE-titled equivalent for the same charter. Hard-rejecting would
// delete the signal that such a team exists. Soft-flagging drops them out of
// the top batches while leaving them findable.
// Genuinely ambiguous. "Solutions Engineer" is deployment work at Palantir and
// pre-sales at Snowflake; "Field Engineer" splits the same way. The role-family
// table already classifies Solutions Engineer as fde, which was a deliberate
// call and a defensible one, so these pass and are flagged for reading in
// context rather than excluded. Getting this wrong in the rejecting direction
// costs more: forward-deployed roles are among the strongest matches in the
// whole corpus.
//
// "deployment engineer" was in this list and does not belong. It is not
// ambiguous — it is the same job as forward-deployed engineering under a
// different name, and it is the second-strongest title in the whole corpus.
// Measured over the scored postings that pass this screen: 22 titles, 4 reached
// fit 70, best 80 ("AI Deployment Engineer, Enterprise"). Compare the four that
// remain below: 64 titles, 0 reached fit 70, best 60. Flagging it was applying
// a pre-sales penalty to the role the pipeline exists to find.
const AMBIGUOUS_CUSTOMER_FACING = [
  "solution engineer",
  "solutions engineer",
  "field engineer",
  "implementation engineer",
];

// Forward-deployed and customer-facing engineering: not targeted. The
// candidate moved to SDE / AI engineering roles in Sept 2026 because most of
// these teams do not sponsor visas. This supersedes the comments above that
// call forward-deployed roles a strong match; they were, on fit, but not on
// the one constraint that decides whether an offer can be accepted. Title only,
// so a software role that mentions deployment in its body is unaffected.
const FDE_TRACK = [
  "forward deployed",
  "deployment engineer",
  "solutions engineer",
  "solution engineer",
  "field engineer",
  "implementation engineer",
  "integration engineer",
  "professional services engineer",
  "developer advocate",
  "developer relations",
];

const RESEARCH_TRACK = [
  "applied scientist",
  "research scientist",
  "research engineer",
  "postdoctoral",
  "post-doctoral",
];

// 5. "SYSTEMS ENGINEER" WITHOUT A SOFTWARE QUALIFIER.
//
// The single worst term in ROLE_FAMILIES. It is one phrase in software ("AI
// Systems Engineer", "Distributed Systems Engineer") and an entirely different
// profession everywhere else: MBSE and requirements work in aerospace, IT
// desktop administration, power and spacecraft systems, trading-floor support.
// The title grants swe, the body reads technical, and the fit score comes back
// in the twenties.
//
// Measured over the scored postings that pass this screen: 86 carried the
// title. The 17 with a software qualifier produced the one match in the group
// (OpenAI, "AI Systems Engineer, Codex Agents", fit 80). The other 69 produced
// none at all, best 65. So the qualifier — not the phrase — is what carries the
// signal, and this rejects only the unqualified form.
//
// It matters most upstream: 42 of the 282 Workday stubs currently queued for
// hydration carry this title, and a stub's title is known before the fetch, so
// each one rejected here saves an HTTP round trip as well as a model call.
const SYSTEMS_ENGINEER_RE = /(?<![a-z0-9])systems?\s+engineer(?![a-z0-9])/i;
const SYSTEMS_SOFTWARE_QUALIFIERS = [
  "ai",
  "ml",
  "machine learning",
  "distributed",
  "software",
  "backend",
  "back end",
  "frontend",
  "front end",
  "platform",
  "cloud",
  "site reliability",
  "full stack",
  "fullstack",
];

/** True when a title says "Systems Engineer" with nothing software about it. */
export function unqualifiedSystemsEngineer(title = "") {
  const t = norm(title);
  if (!SYSTEMS_ENGINEER_RE.test(t)) return false;
  return !matchesAny(t, SYSTEMS_SOFTWARE_QUALIFIERS);
}

/** Years in a title that are ALL later than the target cohort, else null. */
export function futureCohort(title, gradYear = GRAD_YEAR) {
  const years = [...String(title).matchAll(YEAR_RE)].map((m) => Number(m[1]));
  if (!years.length) return null;
  return years.every((y) => y > gradYear) ? Math.min(...years) : null;
}

export function screen(job, opts = {}) {
  const { maxYoE = 3, requireRoleFamily = true, requireUS = true } = opts;
  const title = String(job.title || "");
  const description = String(job.description || "");
  const locations = job.locations || [];
  const t = norm(title);
  const body = norm(description);

  const reasons = [];
  const softFlags = [];

  if (!t || t.length < 4 || !/[a-z]/i.test(t)) {
    return {
      pass: false,
      reasons: ["title_missing_or_noise"],
      softFlags: [],
      roleFamily: null,
      yoe: null,
      workAuth: "unknown",
      location: null,
    };
  }

  const noise = matchesAny(t, NOISE);
  if (noise) reasons.push(`noise:${noise}`);

  const senior = matchesAny(t, EXCLUDE_SENIORITY);
  if (senior) reasons.push(`seniority:${senior}`);

  const wrongDiscipline = matchesAny(t, EXCLUDE_DISCIPLINE);
  if (wrongDiscipline) reasons.push(`discipline:${wrongDiscipline}`);

  // Location — hard gate.
  // Body-aware: a "Remote" tag can hide "position in India".
  const loc = locationVerdictWithBody(locations, description);
  if (requireUS && !loc.eligible) reasons.push(`location:${loc.reason}`);

  // Work authorization — body only. A title never says this.
  let workAuth = "unknown";
  const knockout = body ? workAuthKnockout(body) : null;
  if (knockout) {
    workAuth = "blocked";
    reasons.push(`work_auth:${knockout}`);
  } else if (body && matchesAny(body, SPONSORSHIP_POSITIVE)) {
    workAuth = "positive";
  } else if (body) {
    const soft = matchesAny(body, WORK_AUTH_SOFT);
    if (soft) {
      // Does not fail the screen — surfaces lower and gets read in context later.
      workAuth = "restricted";
      softFlags.push(`work_auth_soft:${soft}`);
    }
  }

  // --- eligibility knockouts ------------------------------------------
  const company = norm(job.companyName || job.companyToken || "");

  if (INTERN_RE.test(title)) reasons.push("internship");

  const cohort = futureCohort(title, opts.gradYear ?? GRAD_YEAR);
  if (cohort) reasons.push(`cohort:${cohort}`);

  // SOFT FLAG, NOT A REJECT.
  //
  // This was pushed into `reasons`, which sets pass=false, which makes run.mjs
  // write status:"screened_out" on TITLE ALONE before any body is fetched — 53 of
  // 282 Workday stubs retired permanently with no description ever read and no way
  // to revisit the call.
  //
  // The evidence given for that was also wrong. Measured over screen-passing
  // scored jobs, unqualified "Systems Engineer" titles top out at fit 72, not 65,
  // and produce one match above the bar, not zero — and the list below it is
  // OpenAI Codex infrastructure, a Kubernetes role and a DevOps role, none of
  // which carries a qualifier. A 1-in-79 hit rate justifies a penalty; it does not
  // justify an irreversible reject applied before the posting is even read.
  if (unqualifiedSystemsEngineer(title))
    softFlags.push("systems_engineer_unqualified");

  const ec = exportControlBar(title) || exportControlBar(description);
  if (ec) reasons.push(`export_control:${ec}`);
  else if (company && matchesAny(company, EXPORT_CONTROL_EMPLOYERS))
    reasons.push("export_control:employer_enforces_us_person");
  else if (
    company &&
    matchesAny(t, DEFENCE_TRACK) &&
    matchesAny(company, [...DEFENCE_EMPLOYERS, "palantir"])
  )
    reasons.push("export_control:defence_track");
  else if (company && matchesAny(company, DEFENCE_EMPLOYERS))
    // Employer varies by req; surfaces lower rather than disappearing.
    softFlags.push("defence_employer_verify_export_control");

  const ambiguous = matchesAny(t, AMBIGUOUS_CUSTOMER_FACING);
  if (ambiguous) softFlags.push(`customer_facing_ambiguous:${ambiguous}`);

  const fdeTrack = matchesAny(t, FDE_TRACK);
  if (fdeTrack) reasons.push(`not_targeted:${fdeTrack}`);

  const research = matchesAny(t, RESEARCH_TRACK);
  if (research) softFlags.push(`research_track:${research}`);

  const yoe = extractYoE(description);
  if (yoe !== null && yoe > maxYoE) reasons.push(`yoe:${yoe}`);

  const { family, score, scores } = classifyRoleFamily(title);
  if (requireRoleFamily && !family) reasons.push("no_role_family");

  return {
    pass: reasons.length === 0,
    reasons,
    softFlags,
    roleFamily: family,
    roleFamilyScore: score,
    roleFamilyScores: scores,
    yoe,
    workAuth,
    location: { ...loc, phoenix: isPhoenixMetro(locations) },
  };
}

export const _internals = {
  phraseRe,
  EXCLUDE_SENIORITY,
  EXCLUDE_DISCIPLINE,
  WORK_AUTH_KNOCKOUTS,
  WORK_AUTH_SOFT,
  NOISE,
};
