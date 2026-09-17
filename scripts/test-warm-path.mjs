/**
 * Warm path and postmortem: the rules around people and losses. Stub provider,
 * no database, no network.
 */
process.env.LLM_PROVIDER = "stub";
const W = await import("../src/warm-path.js");
const P = await import("../src/postmortem.js");
const { loadBank } = await import("../src/tailor.js");

let pass = 0,
  fail = 0;
const failures = [];
const ok = (n, c, dd = "") =>
  c ? pass++ : (fail++, failures.push(`${n}${dd ? ` — ${dd}` : ""}`));
const at = (s) => new Date(`${s}T12:00:00`);
const ymd = (x) =>
  x
    ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
    : null;
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

/* ---- company keys and the ladder ---- */
ok(
  "key: board token and display name meet",
  W.companyKey("GE Vernova") === W.companyKey("gevernova"),
);
ok(
  "key: a corporate suffix is dropped",
  W.companyKey("Chicago Trading Company") === W.companyKey("chicagotrading"),
  W.companyKey("Chicago Trading Company"),
);
ok(
  "name: accents and case are folded",
  W.nameNorm("José  Álvarez") === W.nameNorm("jose alvarez"),
  W.nameNorm("José  Álvarez"),
);
const bank = await loadBank();
const terms = W.ladderTerms(bank);
ok(
  "ladder: Arizona State is a school",
  terms.schools.includes("Arizona State University"),
  JSON.stringify(terms),
);
ok(
  "ladder: former employers are Example Corp, the platform and ERP Co.",
  ["Example Corp", "the platform"].every((e) => terms.employers.includes(e)) &&
    terms.employers.some((e) => /^ERP Co./.test(e)),
  JSON.stringify(terms.employers),
);
ok(
  "ladder: a school is not repeated as an employer",
  !terms.employers.includes("Arizona State University"),
);
ok(
  "ladder: a company's description is not an employer",
  !terms.employers.some((e) => /platform|counsel/i.test(e)),
);
const links = W.searchLinks("GE Vernova", terms);
ok(
  "links: every link is a LinkedIn or Google search",
  links.length >= 4 &&
    links.every((l) =>
      /^https:\/\/www\.(linkedin|google)\.com\/search/.test(l.url),
    ),
);
ok("links: the company is URL-encoded", links[0].url.includes("GE%20Vernova"));

/* ---- what a finding must carry ---- */
const good = {
  verdict: "warm_reachable",
  people: [
    {
      name: "Jane Doe",
      rung: "recruiter",
      title: "University Recruiter",
      linkedin: "https://www.linkedin.com/in/janedoe",
    },
  ],
};
ok(
  "record: a named recruiter with a profile passes",
  W.validateRecord(good).ok,
  JSON.stringify(W.validateRecord(good).errors),
);
ok(
  "record: cold with nobody passes",
  W.validateRecord({ verdict: "cold", people: [] }).ok,
);
ok(
  "record: reachable with nobody is refused",
  !W.validateRecord({ verdict: "warm_reachable", people: [] }).ok,
);
ok(
  "record: a first name alone is refused",
  !W.validateRecord({
    verdict: "warm_reachable",
    people: [{ name: "Jane", rung: "alumni" }],
  }).ok,
);
ok(
  "record: a recruiter with no profile or source is refused",
  !W.validateRecord({
    verdict: "warm_reachable",
    people: [{ name: "Jane Doe", rung: "recruiter" }],
  }).ok,
);
ok(
  "record: an alum the candidate found needs no link",
  W.validateRecord({
    verdict: "warm_reachable",
    people: [{ name: "Jane Doe", rung: "alumni" }],
  }).ok,
);
ok(
  "record: a company page is not a profile",
  !W.validateRecord({
    verdict: "warm_reachable",
    people: [
      {
        name: "Jane Doe",
        rung: "alumni",
        linkedin: "https://www.linkedin.com/company/acme",
      },
    ],
  }).ok,
);
ok(
  "record: an unknown verdict is refused",
  !W.validateRecord({ verdict: "lukewarm", people: [] }).ok,
);

/* ---- dates ---- */
const mon = at("2026-09-14");
const p1 = W.planDates("warm_reachable", mon);
ok(
  "plan: reach out today, apply 2 to 3 days later",
  ymd(p1.outreachOn) === "2026-09-14" &&
    ymd(p1.applyAfter) === "2026-09-16" &&
    ymd(p1.applyBy) === "2026-09-17",
);
const p2 = W.planDates("warm_reachable", mon, {
  nextAllowed: at("2026-09-16"),
});
ok(
  "plan: a full cap moves day 0",
  ymd(p2.outreachOn) === "2026-09-16" && ymd(p2.applyAfter) === "2026-09-18",
);
ok(
  "plan: cold looks again in 14 days",
  ymd(W.planDates("cold", mon).recheckOn) === "2026-09-28",
);
ok(
  "plan: an evidenced closing window applies today",
  ymd(
    W.planDates("warm_reachable", mon, { closingWindow: "closes Friday" })
      .applyBy,
  ) === "2026-09-14",
);
const p3 = W.planDates("warm_reachable", mon, { applied: true });
ok(
  "plan: already applied means outreach only",
  !p3.applyBy && ymd(p3.outreachOn) === "2026-09-14",
);

/* ---- caps ---- */
const mk = (name, co, first, status = "contacted", last = first) => ({
  name,
  companyKey: W.companyKey(co),
  status,
  firstTouchAt: first ? at(first) : null,
  lastTouchAt: last ? at(last) : null,
});
const c1 = W.capsStatus(
  [
    mk("A One", "Acme", "2026-09-14"),
    mk("B Two", "Beta", "2026-09-14"),
    mk("C Three", "Gamma", "2026-09-14"),
  ],
  mon,
);
ok(
  "caps: three new people today moves the next to tomorrow",
  c1.newToday === 3 && ymd(c1.nextAllowed) === "2026-09-15",
);
const week = Array.from({ length: 10 }, (_, i) =>
  mk(
    `P${i} Person`,
    `Co${i}`,
    `2026-09-${String(8 + (i % 6)).padStart(2, "0")}`,
    "replied",
  ),
);
const c2 = W.capsStatus(week, mon);
ok(
  "caps: ten this week waits for the oldest to age out",
  c2.newThisWeek === 10 && ymd(c2.nextAllowed) === "2026-09-15",
  `${c2.newThisWeek} ${ymd(c2.nextAllowed)}`,
);
ok(
  "caps: an unanswered thread blocks a second person there",
  W.capsStatus([mk("Jane Doe", "Acme", "2026-09-10")], mon, [
    W.companyKey("Acme"),
  ]).blockedByThread?.name === "Jane Doe",
);
ok(
  "caps: it does not block another company",
  !W.capsStatus([mk("Jane Doe", "Acme", "2026-09-10")], mon, [
    W.companyKey("Beta"),
  ]).blockedByThread,
);
ok(
  "caps: a thread quiet for 30 days no longer blocks",
  !W.capsStatus([mk("Jane Doe", "Acme", "2026-08-01")], mon, [
    W.companyKey("Acme"),
  ]).blockedByThread,
);

/* ---- touches ---- */
const fresh = { name: "Jane Doe", status: "not_contacted", touches: [] };
const t1 = W.applyTouch(fresh, "outreach", mon);
ok(
  "touch: outreach opens a thread with a follow-up date",
  t1.status === "contacted" &&
    ymd(t1.firstTouchAt) === "2026-09-14" &&
    ymd(t1.nextTouchAt) === "2026-09-22" &&
    !t1.warnings.length,
);
const s1 = { ...fresh, ...t1 };
ok(
  "touch: a follow-up inside 7 days is flagged",
  W.applyTouch(s1, "bump", at("2026-09-17")).warnings.some((w) =>
    /wait at least 7/.test(w),
  ),
);
const s2 = { ...s1, ...W.applyTouch(s1, "bump", at("2026-09-22")) };
const t3 = W.applyTouch(s2, "bump", at("2026-09-30"));
ok(
  "touch: the second follow-up parks the thread 30 days",
  ymd(t3.nextTouchAt) === "2026-10-30" && !t3.warnings.length,
  JSON.stringify(t3.warnings),
);
ok(
  "touch: a third follow-up is flagged",
  W.applyTouch({ ...s2, ...t3 }, "bump", at("2026-10-31")).warnings.some((w) =>
    /follow-up 3/.test(w),
  ),
);
ok(
  "touch: a second first message is flagged",
  W.applyTouch(s1, "outreach", at("2026-09-25")).warnings.some((w) =>
    /already messaged/.test(w),
  ),
);
ok(
  "touch: a reply ends the follow-ups",
  W.applyTouch(s1, "reply", at("2026-09-15")).status === "replied",
);
ok(
  "touch: an unknown kind throws",
  throws(() => W.applyTouch(fresh, "wave")),
);

/* ---- attached at apply ---- */
const job = { companyName: "Acme", submitAttemptAt: at("2026-09-10") };
const acme = (first) => [
  { companyKey: W.companyKey("Acme"), firstTouchAt: first ? at(first) : null },
];
ok(
  "attached: a referral wins",
  W.attachedAtApply({ ...job, referral: { by: "X Y" } }, []) === "referral",
);
ok(
  "attached: already talking, recorded before applying",
  W.attachedAtApply(
    {
      ...job,
      warmPath: { verdict: "warm_active", recordedAt: at("2026-09-09") },
    },
    [],
  ) === "warm_active",
);
ok(
  "attached: recorded after applying does not count",
  W.attachedAtApply(
    {
      ...job,
      warmPath: { verdict: "warm_active", recordedAt: at("2026-09-12") },
    },
    [],
  ) === "cold",
);
ok(
  "attached: messaged someone before applying",
  W.attachedAtApply(job, acme("2026-09-08")) === "contacted_before",
);
ok(
  "attached: messaged someone only after",
  W.attachedAtApply(job, acme("2026-09-12")) === "contacted_after",
);
ok("attached: nobody is cold", W.attachedAtApply(job, acme(null)) === "cold");
ok(
  "apply line: an unchecked strong job gets a nudge",
  /not checked/.test(
    W.warmPathLine({ companyName: "Acme", llmScore: { fit: 80 } }) || "",
  ),
);
ok(
  "apply line: a weak job gets nothing",
  W.warmPathLine({ companyName: "Acme", llmScore: { fit: 50 } }) === null,
);

/* ---- LinkedIn export ---- */
const csv =
  'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing."\n\n' +
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n" +
  'Jane,Doe,https://www.linkedin.com/in/janedoe,jane@example.com,"Acme, Inc.","Engineer, Platform",01 Sep 2026\r\n' +
  "Bob,,https://www.linkedin.com/in/bob,,,Student,02 Sep 2026\n";
const conns = W.parseLinkedInConnections(csv);
ok(
  "linkedin: header found past the notes, quoted commas kept",
  conns.length === 1 &&
    conns[0].company === "Acme, Inc." &&
    conns[0].title === "Engineer, Platform",
  JSON.stringify(conns),
);
ok(
  "linkedin: email addresses are not kept",
  !JSON.stringify(conns).includes("jane@example.com"),
);
ok(
  "linkedin: a file that is not the export is refused",
  throws(() => W.parseLinkedInConnections("a,b\n1,2")),
);
ok(
  "linkedin: the company meets the job's key",
  W.companyKey(conns[0].company) === W.companyKey("acme"),
  W.companyKey(conns[0].company),
);

/* ---- postmortem ---- */
ok(
  "work auth: a no-sponsorship line is quoted",
  /unable to sponsor/i.test(
    P.workAuthQuote(
      "Great team. We are unable to sponsor visas for this role. Apply now.",
    ) || "",
  ),
);
ok(
  "work auth: a posting that sponsors is not quoted",
  P.workAuthQuote("We offer H-1B sponsorship and relocation.") === null,
);
ok(
  "work auth: 'without the need for sponsorship' is quoted",
  !!P.workAuthQuote(
    "Must be authorized to work without the need for current or future sponsorship.",
  ),
);
const lost = {
  companyName: "Acme",
  title: "Software Engineer",
  ats: "workday",
  submitAttemptAt: at("2026-09-01"),
  outcome: "rejected",
  outcomeAt: at("2026-09-02"),
  outcomeDateKnown: true,
  outcomeSubject: null,
  llmScore: { fit: 70, gaps: ["No Kubernetes"] },
  description:
    "Requires 5+ years of backend experience. We are unable to sponsor visas.",
};
const facts = P.buildFacts(lost, { attached: "cold" });
ok(
  "facts: days to rejection from the email's date",
  facts.daysToRejection === 1 && facts.rejectionDateExact === true,
);
ok(
  "facts: the work-authorization quote is carried",
  /unable to sponsor/.test(facts.postingWorkAuthQuote || ""),
);
const a1 = P.acceptPostmortem(
  {
    stated: "they wanted more years",
    inferred: "x",
    class: "work_authorization",
    confidence: "high",
    evidence: "We are unable to sponsor visas",
    fix: "f",
  },
  facts,
);
ok(
  "accept: no email subject means stated is 'none given'",
  a1.stated === "none given",
);
ok(
  "accept: evidence found in the facts keeps its confidence",
  a1.evidenceVerified && a1.confidence === "high",
);
const a2 = P.acceptPostmortem(
  {
    inferred: "x",
    class: "level_or_years",
    confidence: "high",
    evidence: "requires 10 years of Go",
    fix: "f",
  },
  facts,
);
ok(
  "accept: evidence not in the facts drops to low",
  !a2.evidenceVerified && a2.confidence === "low",
);
ok(
  "accept: an invented class becomes unknown",
  P.acceptPostmortem(
    { class: "bad_vibes", confidence: "high", evidence: "" },
    facts,
  ).class === "unknown",
);
const pats = P.objectionPatterns([
  { class: "level_or_years", confidence: "medium" },
  { class: "level_or_years", confidence: "high" },
  { class: "level_or_years", confidence: "medium" },
  { class: "work_authorization", confidence: "low" },
]);
ok(
  "patterns: three of a kind is flagged",
  pats.patterns.length === 1 && pats.patterns[0].class === "level_or_years",
);
ok(
  "patterns: low confidence is not counted",
  !pats.byClass.work_authorization && pats.unknownOrLow === 1,
);
const pm = await P.postmortemJob(lost, { attached: "cold" });
ok(
  "postmortem: a stub run stores a checked, low-confidence unknown",
  pm.class === "unknown" &&
    pm.confidence === "low" &&
    pm.stage === "application" &&
    pm.personAttached === "cold",
);

console.log(failures.map((x) => `  FAIL ${x}`).join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? "  FAILURES" : "  all green");
process.exit(fail ? 1 : 0);
