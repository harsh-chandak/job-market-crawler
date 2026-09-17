/**
 * Filter tests. No network, no DB. `node scripts/test-filter.mjs`
 *
 * Includes regressions for the three bugs found in job-alerts/exclusion-check.js
 * and for the two failures observed in the first live poll.
 */

import {
  screen,
  classifyRoleFamily,
  extractYoE,
  futureCohort,
  exportControlBar,
  _internals,
} from "../src/filter.js";
import { classifyLocation, locationVerdict } from "../src/util/location.js";
import {
  contentHash,
  clusterKey,
  normTitle,
  normCompany,
} from "../src/util/normalize.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    return;
  }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name, actual, expected) {
  ok(
    name,
    Object.is(actual, expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

/* ---- REGRESSION: multi-word phrases must actually match -------------- */
// Old code did ex.replace(/\W/g,'') -> /\bvicepresident\b/ which never matched.
{
  const re = _internals.phraseRe("vice president");
  ok(
    'phrase: "vice president" matches',
    re.test("Vice President of Engineering"),
  );
  ok(
    "phrase: multi-space tolerant",
    _internals.phraseRe("team lead").test("Team   Lead"),
  );
  ok(
    'phrase: "5+ years" style',
    _internals.phraseRe("top secret").test("Top Secret clearance"),
  );
}

/* ---- REGRESSION: no substring matching ------------------------------- */
// Old INCLUDE used .includes('ml'), so "HTML/CSS Designer" matched.
{
  const r = classifyRoleFamily("HTML/CSS Designer");
  eq("no substring: HTML does not match ml", r.family, null);
  const r2 = classifyRoleFamily("Senior Familiarization Specialist");
  eq("no substring: familiarization does not match ai", r2.family, null);
}

/* ---- REGRESSION: seniority actually excluded ------------------------- */
{
  for (const t of [
    "Senior Software Engineer",
    "Sr. Software Engineer",
    "Staff Software Engineer",
    "Principal Software Engineer",
    "Software Engineering Manager",
    "Tech Lead, Backend",
    "Vice President of Engineering",
    "Director of Machine Learning",
  ]) {
    const v = screen({ title: t, locations: ["San Francisco, CA"] });
    ok(
      `seniority excluded: ${t}`,
      !v.pass && v.reasons.some((r) => r.startsWith("seniority")),
    );
  }
}

/* ---- LIVE-POLL REGRESSION: wrong discipline -------------------------- */
{
  const cases = [
    "AI Product Owner – Business Process Transformation",
    "AI Solution Strategist",
    "Cloud FinOps Business Partner",
    "Financial Systems Analyst",
    "Escalation and Incident Engineer",
    "Circuit Provisioning Engineer",
  ];
  for (const t of cases) {
    const v = screen({ title: t, locations: ["USA - Remote"] });
    ok(`discipline/family rejects: ${t}`, !v.pass, JSON.stringify(v.reasons));
  }
}

/* ---- LIVE-POLL REGRESSION: description no longer grants a family ----- */
{
  const v = classifyRoleFamily("Cloud FinOps Business Partner");
  eq("body cannot grant family (title-only)", v.family, null);
}

/* ---- positives ------------------------------------------------------- */
{
  const good = [
    ["Software Engineer, Backend", "swe"],
    ["Software Development Engineer I", "swe"],
    ["Full Stack Engineer", "swe"],
    ["Machine Learning Engineer", "ai"],
    ["AI Engineer", "ai"],
    ["Data Engineer", "ai"],
  ];
  for (const [title, want] of good) {
    const v = screen({ title, locations: ["New York, NY"] });
    ok(`accepts: ${title}`, v.pass, JSON.stringify(v.reasons));
    eq(`family(${title})`, v.roleFamily, want);
  }
}

/* ---- location gate --------------------------------------------------- */
{
  eq("loc: USA - Remote", classifyLocation("USA - Remote"), "us");
  /* REGRESSION: ISO country codes collide with US state codes. Microsoft's
     `standardizedLocations` emits "City, Region, CountryCode", so before
     positional parsing these all classified as US and were being STORED:
     CA=California/Canada, IN=Indiana/India, IL=Illinois/Israel. */
  eq("loc: Hyderabad, TS, IN is India", classifyLocation("Hyderabad, TS, IN"), "non_us");
  eq("loc: Vancouver, BC, CA is Canada", classifyLocation("Vancouver, BC, CA"), "non_us");
  eq("loc: Tel Aviv, TA, IL is Israel", classifyLocation("Tel Aviv, TA, IL"), "non_us");
  eq("loc: Toronto, ON, CA is Canada", classifyLocation("Toronto, ON, CA"), "non_us");
  eq("loc: Redmond, WA, US stays US", classifyLocation("Redmond, WA, US"), "us");
  eq("loc: Mountain View, CA, US stays US", classifyLocation("Mountain View, CA, US"), "us");
  /* two-part form is ambiguous; the city decides, not the code */
  eq("loc: Berlin, DE is Germany", classifyLocation("Berlin, DE"), "non_us");
  eq("loc: Wilmington, DE is Delaware", classifyLocation("Wilmington, DE"), "us");
  eq("loc: Chicago, IL is Illinois", classifyLocation("Chicago, IL"), "us");
  eq("loc: Indianapolis, IN is Indiana", classifyLocation("Indianapolis, IN"), "us");
  /* the old free-text 2-letter scan matched "in" inside "first in EU" */
  eq("loc: London remote-first not US", classifyLocation("London - remote first in EU"), "non_us");
  eq("loc: SF remote-first is US", classifyLocation("San Francisco - remote first in USA"), "us");

  eq(
    "loc: Philippines - Manila",
    classifyLocation("Philippines - Manila"),
    "non_us",
  );
  eq("loc: India - Pune", classifyLocation("India - Pune"), "non_us");
  eq("loc: Israel - Raanana", classifyLocation("Israel - Raanana"), "non_us");
  eq(
    "loc: United Kingdom - London",
    classifyLocation("United Kingdom - London"),
    "non_us",
  );
  eq("loc: Hoboken, NJ", classifyLocation("USA - Hoboken, NJ"), "us");
  eq(
    "loc: bare Remote is ambiguous",
    classifyLocation("Remote"),
    "remote_unknown",
  );
  eq("loc: Tempe, AZ", classifyLocation("Tempe, AZ"), "us");

  ok(
    "verdict: any-US wins",
    locationVerdict(["India - Pune", "USA - Austin, TX"]).eligible,
  );
  ok(
    "verdict: all non-US rejected",
    !locationVerdict(["India - Pune", "Germany - Berlin"]).eligible,
  );
  ok("verdict: empty is eligible", locationVerdict([]).eligible);

  // REGRESSION: boards emit ["Zurich, Switzerland", "Remote"]. The bare Remote
  // tag means remote-in-Switzerland, not remote-from-anywhere — it must not
  // rescue a posting that is explicitly anchored to another country.
  ok(
    "verdict: non-US + bare Remote is rejected",
    !locationVerdict(["Zurich, Switzerland", "Remote"]).eligible,
    JSON.stringify(locationVerdict(["Zurich, Switzerland", "Remote"])),
  );
  ok(
    "verdict: US + bare Remote still eligible",
    locationVerdict(["San Mateo, California", "Remote"]).eligible,
  );
  ok("verdict: bare Remote alone stays eligible", locationVerdict(["Remote"]).eligible);
  ok(
    "verdict: US + non-US + Remote is eligible",
    locationVerdict(["Zurich, Switzerland", "Austin, TX", "Remote"]).eligible,
  );
  ok(
    "verdict: Remote - Ireland is rejected",
    !locationVerdict(["Remote - Ireland"]).eligible,
  );

  const v = screen({
    title: "Software Engineer",
    locations: ["Philippines - Manila"],
  });
  ok(
    "screen rejects non-US",
    !v.pass && v.reasons.some((r) => r.startsWith("location")),
  );

  const p = screen({ title: "Software Engineer", locations: ["Tempe, AZ"] });
  ok("phoenix flagged", p.location.phoenix === true);
}

/* ---- work authorization --------------------------------------------- */
{
  const blocked = screen({
    title: "Software Engineer",
    locations: ["Austin, TX"],
    description:
      "Applicants must be a US citizen. Active security clearance required.",
  });
  ok(
    "work auth: citizenship blocks",
    !blocked.pass && blocked.workAuth === "blocked",
  );

  const nosponsor = screen({
    title: "Software Engineer",
    locations: ["Austin, TX"],
    description:
      "We are unable to sponsor or take over sponsorship of an employment visa at this time.",
  });
  ok(
    "work auth: no-sponsorship blocks",
    !nosponsor.pass && nosponsor.workAuth === "blocked",
  );

  const positive = screen({
    title: "Software Engineer",
    locations: ["Austin, TX"],
    description:
      "We are an E-Verify employer and will sponsor H-1B for qualified candidates.",
  });
  ok(
    "work auth: positive signal",
    positive.pass && positive.workAuth === "positive",
  );

  const silent = screen({
    title: "Software Engineer",
    locations: ["Austin, TX"],
    description: "Build things.",
  });
  eq("work auth: silence is unknown, not pass", silent.workAuth, "unknown");
  ok("work auth: silence still passes screen", silent.pass);
}

/* ---- years of experience -------------------------------------------- */
{
  eq("yoe: 8+ years", extractYoE("We want 8+ years of experience"), 8);
  eq("yoe: minimum of 5", extractYoE("Minimum of 5 years in backend"), 5);
  eq(
    "yoe: at least 10",
    extractYoE("At least 10 years experience required"),
    10,
  );
  eq("yoe: none", extractYoE("New grad friendly"), null);
  // Takes the MINIMUM stated, not the maximum. This assertion used to expect 7 —
  // but 7 is what the posting *prefers* and 3 is what it *requires*, and the
  // question this screen answers is "can I apply", not "what would delight them".
  // Postings also list alternative paths ("MS and 2 years, or BS and 4"), where
  // the max rejects a candidate who qualifies under one of them.
  eq(
    "yoe: takes the minimum stated, not the maximum",
    extractYoE("3 years of experience; at least 7 years preferred"),
    3,
  );
  eq("yoe: a range gives its low end", extractYoE("2-12+ years of industry software"), 2);
  eq(
    "yoe: alternative paths give the lower bar",
    extractYoE("MS and 2 years of experience, or BS and 4 years of experience"),
    2,
  );

  // Both halves of a real leak: 48 postings at fit>=70 demanded five or more
  // years and the screen saw nothing, because job posts write ranges with
  // typographic dashes and because the pattern insisted on the literal word
  // "experience" following the phrase.
  eq("yoe: en dash range", extractYoE("3\u20135 years of experience"), 3);
  eq("yoe: em dash range", extractYoE("4\u20146 years of experience"), 4);
  eq(
    "yoe: no literal 'experience' word",
    extractYoE("5+ years working on complex distributed systems"),
    5,
  );
  eq(
    "yoe: 'building' counts too",
    extractYoE("7+ years building production software"),
    7,
  );

  const v = screen({
    title: "Software Engineer",
    locations: ["Austin, TX"],
    description: "8+ years of experience",
  });
  ok(
    "yoe gate rejects 8y",
    !v.pass && v.reasons.some((r) => r.startsWith("yoe")),
  );
}

/* ---- normalization / identity --------------------------------------- */
{
  eq(
    "normCompany strips suffixes",
    normCompany("Acme Technologies, Inc."),
    "acme",
  );
  eq("normCompany handles &", normCompany("Ben & Jerry LLC"), "ben and jerry");
  eq(
    "normTitle strips parens",
    normTitle("Software Engineer (Remote)"),
    "software engineer",
  );
  eq(
    "normTitle strips req id",
    normTitle("Software Engineer Req #12345"),
    "software engineer",
  );

  const a = contentHash({
    company: "Acme Inc",
    title: "SWE",
    description: "x",
    locations: ["NY"],
  });
  const b = contentHash({
    company: "Acme, Inc.",
    title: "SWE",
    description: "x",
    locations: ["NY"],
  });
  ok("contentHash: stable across company spelling", a === b);

  const c = contentHash({
    company: "Acme",
    title: "SWE",
    description: "y",
    locations: ["NY"],
  });
  ok("contentHash: differs on body", a !== c);

  const k1 = clusterKey({
    company: "Acme",
    title: "SWE (NYC)",
    applyUrl: "https://boards.greenhouse.io/acme/1",
  });
  const k2 = clusterKey({
    company: "Acme",
    title: "SWE (Austin)",
    applyUrl: "https://boards.greenhouse.io/acme/2",
  });
  ok("clusterKey: same role across locations collapses", k1 === k2);
}

// ISO-3 country codes. Amazon emits "Asti, Piedmont, ITA"; before these were
// recognised both parts resolved to "unknown", which fails open, so a role in
// Italy was presented as applicable. The US state cases guard the fix against
// re-introducing the CA/IN/IL collision it must not break.
for (const [locs, want, label] of [
  [["IT, AT, Asti", "Asti, Piedmont, ITA"], false, "ITA is Italy, not eligible"],
  [["Bengaluru, Karnataka, IND"], false, "IND is India"],
  [["Toronto, Ontario, CAN"], false, "CAN is Canada"],
  [["Austin, Texas, USA"], true, "USA still eligible"],
  [["San Francisco, CA"], true, "CA in a pair is California"],
  [["Indianapolis, IN"], true, "IN in a pair is Indiana"],
  [["Chicago, IL"], true, "IL in a pair is Illinois"],
]) {
  eq(label, locationVerdict(locs).eligible, want);
}


// Pre-sales rejection. These reqs carry dense technical vocabulary in the body
// (cloud, APIs, integrations), so keyword scoring rated them highly while the
// job is quota-carrying customer work — Samsara alone put five into the top-100
// pre-rank. Title-only matching keeps this from firing on body text.
for (const [title, want] of [
  ["Sales Engineer 4 - Associate Specialist", false],
  ["Sales Engineer II, SE Desk - Mid West", false],
  ["Customer Engineer II", false],
  ["Technical Account Manager", false],
  ["Customer Success Engineer", false],
  // Not targeted since Sept 2026: most forward-deployed teams do not sponsor.
  ["Forward Deployed Engineer I", false],
  ["Solutions Engineer", false],
  ["AI Deployment Engineer, Enterprise", false],
  ["Software Engineer II", true],
  ["Software Engineer, New Grad", true],
]) {
  const v = screen({ title, locations: ["San Francisco, CA"], description: "x".repeat(900) });
  eq(`presales: ${title}`, v.pass, want);
}


// "america" was a US token, so "Latin America [Remote]" matched as US. Because
// multi-location matching is any-eligible by design, one false positive
// overrode three correct non-US verdicts on the same posting.
for (const [t, want] of [
  ["Latin America [Remote]", "non_us"],
  ["South America", "non_us"],
  ["Central America", "non_us"],
  ["North America", "us"],
  ["Americas", "us"],
  ["Reykjavík", "non_us"],
  ["Oslo", "non_us"],
  ["Haifa", "non_us"],
  ["USA - Remote", "us"],
]) {
  eq(`america/city: ${t}`, classifyLocation(t), want);
}
eq(
  "multi-location: one false US must not carry a non-US posting",
  locationVerdict(["Mexico, Remote", "Bogota, Colombia", "Latin America [Remote]", "Turkey"]).eligible,
  false,
);


// Four eligibility knockouts encoded from a 200-posting manual scoring pass.
// Three reject outright; the research-track rule soft-flags instead, because
// those reqs often match on content while the hiring track is the blocker.
{
  const S = (title, companyName, description) =>
    screen({
      title,
      companyName: companyName || "X",
      locations: ["San Francisco, CA"],
      description: description || "x".repeat(900),
    });

  // export control. Matched as imperative phrasing, never as keywords: bare
  // "export control" is legal boilerplate on a large share of ordinary tech
  // postings, and keyword matching rejected two Databricks backend reqs on a
  // conditional that explicitly leaves the door open.
  const BOILERPLATE =
    "If access to export-controlled technology or source code is required for " +
    "performance of job duties, it is within Employer's discretion whether to " +
    "apply for a U.S. government license for such positions.";
  eq("ec: conditional boilerplate is not a bar", exportControlBar(BOILERPLATE), null);
  eq("ec: 'may be subject to' is not a bar", exportControlBar("This position may be subject to export control regulations."), null);
  eq("ec: Databricks-style req still passes", S("Software Engineer - Backend", "Databricks", BOILERPLATE + " " + "x".repeat(700)).pass, true);
  eq("ec: active clearance in title", S("Software Engineer, Active Clearance, Air Defense", "Anduril").pass, false);
  eq("ec: ITAR US-person bar in body", S("Software Engineer, Backend", "Acme", "Applicants must be a U.S. Person as defined by ITAR. " + "x".repeat(800)).pass, false);
  eq("ec: TS/SCI", exportControlBar("Must hold a TS/SCI with polygraph."), "TS/SCI");
  eq("ec: SpaceX enforces blanket", S("Software Engineer, Propulsion Simulation", "SpaceX").pass, false);
  eq("ec: Palantir defence track", S("Forward Deployed Software Engineer, New Grad - Defense", "Palantir").pass, false);
  eq("ec: Palantir commercial software track passes", S("Software Engineer, New Grad - Commercial", "Palantir").pass, true);
  eq("fde: forward deployed is not targeted", S("Forward Deployed Software Engineer, New Grad - Commercial", "Palantir").reasons.some((r) => r.startsWith("not_targeted")), true);
  // A defence employer with no stated requirement is flagged, not rejected —
  // their reqs vary and blanket rejection would discard real openings.
  eq("ec: defence employer soft-flagged only", S("2026 Early Career Software Engineer", "Anduril").pass, true);
  ok("ec: and carries the flag",
     S("2026 Early Career Software Engineer", "Anduril").softFlags.some((f) => f.startsWith("defence_employer")));

  // internships — post-completion OPT has no active enrolment
  eq("intern: rejected", S("Software Engineer (Agent Platform) - Intern - 2026-2027", "Netic").pass, false);
  eq("intern: co-op rejected", S("Software Engineer, Co-op", "Nuro").pass, false);
  eq("intern: new-grad sibling passes", S("Software Engineer (Agent Platform) - New Grad - 2026-2027", "Netic").pass, true);
  // must not match "internal"
  eq("intern: 'Internal Tools' is not an internship", S("Software Engineer, Internal Tools", "Stripe").pass, true);

  // cohort year — inclusive ranges must survive
  eq("cohort: 2027 rejected", S("2027 Early Career Software Engineer", "Anduril").pass, false);
  eq("cohort: 2026 passes", S("2026 Early Career Software Engineer", "Notion").pass, true);
  eq("cohort: 2026-2027 range passes", futureCohort("New Grad - 2026-2027"), null);
  eq("cohort: 2027-2028 range rejected", futureCohort("New Grad - 2027-2028"), 2027);
  eq("cohort: no year is not a cohort claim", futureCohort("Software Engineer"), null);

  // research track — flagged, never rejected
  const as = S("Applied Scientist II, Core Search", "Amazon");
  eq("research: not rejected", as.pass, true);
  ok("research: flagged", as.softFlags.some((f) => f.startsWith("research_track")));
}


// Closed-set country matching. The curated NON_US list was whack-a-mole: this
// file was patched for India, then Iceland, then Serbia and Stuttgart, each
// found by a human reading a posting already scored as applicable. The US
// checks run first so state and city names that collide with country names
// still resolve correctly.
for (const [t, want] of [
  ["Belgrade, Serbia", "non_us"],
  ["Stuttgart, Germany", "non_us"],
  ["Warsaw, Poland", "non_us"],
  ["Seoul, South Korea", "non_us"],
  ["Dubai, United Arab Emirates", "non_us"],
  ["Atlanta, Georgia", "us"],        // the US state, not the country
  ["Jordan, Minnesota", "us"],       // the Minnesota city, not the country
  ["Portland, Oregon", "us"],
  ["Remote - United States", "us"],
  // Regressions from building the country list by splitting on whitespace,
  // which turned "south africa" into the bare token "south".
  ["AL600- 600 Boulevard South, Ste 301, Huntsville, AL 35802", "us"],
  ["South Bend, Indiana", "us"],
  ["North Reading, Massachusetts", "us"],
  ["Costa Mesa, California", "us"],
  ["Republic, Missouri", "us"],
  ["Cape Town, South Africa", "non_us"],
  // "reading" was briefly a curated non-US city. Reading PA and North Reading
  // MA are both US, so the entry was removed; the UK form still resolves via
  // the country name.
  ["Reading, Pennsylvania", "us"],
  ["Reading, United Kingdom", "non_us"],
  // A two-letter state beside a five-digit ZIP is an unambiguous US address.
  ["Seattle, WA 98109", "us"],
]) {
  eq(`country: ${t}`, classifyLocation(t), want);
}


// Amazon writes the country FIRST: "US, WA, Seattle", "GB, Cambridge",
// "TW, TPE, Taipei". The positional rule expects it last, so international
// Amazon reqs fell through to unknown and failed open. Only trusted when the
// leading token cannot also be a US state code, so CA/IN/IL are left alone.
for (const [t, want] of [
  ["US, WA, Seattle", "us"],
  ["US, CA, San Francisco", "us"],
  ["GB, Cambridge", "non_us"],
  ["TW, TPE, Taipei", "non_us"],
  ["JP, Tokyo", "non_us"],
  ["DE, BY, Munich", "non_us"],
  ["San Francisco, CA", "us"],
]) {
  eq(`country-first: ${t}`, classifyLocation(t), want);
}


// Titles carrying their own location. Speechify posts one role per US city with
// the city IN THE TITLE, which produced 202 rows for two actual jobs — 19% of
// the scoring backlog. clusterKey hashes the normalised title, so without this
// the fan-out never collapses and one role gets scored and applied to a
// hundred times. The negative cases guard against over-stripping: an early
// version ate ", Platform - Chicago, IL, USA" whole and left "software
// engineer".
for (const [t, want] of [
  ["Software Engineer, Platform - Chicago, IL, USA", "software engineer platform"],
  ["Software Engineer, Platform - Bend, OR, USA", "software engineer platform"],
  ["Software Engineer, Platform", "software engineer platform"],
  ["Software Engineer, iOS Core Product - Albuquerque, NM, USA", "software engineer ios core product"],
  ["Software Engineer, iOS Core Product - Reykjavik, Iceland", "software engineer ios core product"],
  ["Software Engineer, Backend", "software engineer backend"],
  ["Software Engineer - Backend", "software engineer backend"],
  ["Forward Deployed Software Engineer, New Grad - Commercial", "forward deployed software engineer new grad commercial"],
  ["Sales Engineer II, SE Desk - Mid West", "sales engineer ii se desk mid west"],
]) {
  eq(`normTitle: ${t.slice(0, 46)}`, normTitle(t), want);
}
ok(
  "clusterKey collapses the city fan-out",
  clusterKey({ company: "Speechify", title: "Software Engineer, Platform - Chicago, IL, USA", applyUrl: "https://job-boards.greenhouse.io/speechify/jobs/1" }) ===
    clusterKey({ company: "Speechify", title: "Software Engineer, Platform - Bend, OR, USA", applyUrl: "https://job-boards.greenhouse.io/speechify/jobs/2" }),
);

/* ---- report ---------------------------------------------------------- */
console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n  failures:");
  for (const f of failures) console.log(`    ✗ ${f}`);
  process.exit(1);
}

console.log("  all green\n");
