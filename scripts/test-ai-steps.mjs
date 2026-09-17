/**
 * The three model steps added around the pipeline: second look at borderline
 * rejections, form answers, resume review. Runs on the stub provider; what is
 * tested is the code around each model call, which is where the safety lives.
 */
process.env.LLM_PROVIDER = "stub";

const { isBorderlineRejection, secondLook } =
  await import("../src/second-look.js");
const { modelMayAnswer, validateChoices, buildFormFacts, chooseFormAnswers } =
  await import("../src/form-ai.js");
const { filterReview } = await import("../src/resume-review.js");
const { loadBank, renderResume } = await import("../src/tailor.js");

let pass = 0,
  fail = 0;
const failures = [];
const ok = (n, c, d = "") =>
  c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`));
const stub = (obj) => ({ llm: { stubFactory: () => obj } });

/* ---- second look: which rejections qualify ---- */
ok("borderline: yoe 4", isBorderlineRejection({ reasons: ["yoe:4"] }));
ok(
  "borderline: yoe 5 with an unrecognised title",
  isBorderlineRejection({ reasons: ["yoe:5", "no_role_family"] }),
);
ok("not borderline: yoe 6", !isBorderlineRejection({ reasons: ["yoe:6"] }));
ok(
  "not borderline: export control rides along",
  !isBorderlineRejection({ reasons: ["yoe:4", "export_control:ITAR"] }),
);
ok(
  "not borderline: work authorization",
  !isBorderlineRejection({ reasons: ["work_auth"] }),
);
ok(
  "not borderline: the forward-deployed exclusion",
  !isBorderlineRejection({ reasons: ["not_targeted:forward deployed"] }),
);
ok("not borderline: a passing screen", !isBorderlineRejection({ reasons: [] }));

/* ---- second look: the model's rescue is checked against its own numbers ---- */
const job = {
  title: "Software Engineer",
  screen: { reasons: ["yoe:5"] },
  description: "x".repeat(500),
};
ok(
  "second look: refused when its own required years exceed 3",
  (
    await secondLook(
      job,
      "p",
      stub({ requiredYears: 5, family: "swe", rescue: true, reason: "r" }),
    )
  ).rescue === false,
);
ok(
  "second look: kept at 2 required years",
  (
    await secondLook(
      job,
      "p",
      stub({ requiredYears: 2, family: "ai", rescue: true, reason: "r" }),
    )
  ).rescue === true,
);
ok(
  "second look: a non-engineering role is never rescued",
  (
    await secondLook(
      job,
      "p",
      stub({ requiredYears: 1, family: "none", rescue: true, reason: "r" }),
    )
  ).rescue === false,
);

/* ---- form answers: what the model may see ---- */
for (const l of [
  "Will you now or in the future require sponsorship for employment visa status?",
  "Are you legally authorized to work in the United States?",
  "Gender",
  "Do you have a disability?",
  "Veteran status",
  "Desired salary",
  "Have you ever been convicted of a felony?",
  "I acknowledge the applicant privacy notice",
  "Are you a U.S. citizen?",
  "Do you hold an active security clearance?",
])
  ok(`off limits: ${l.slice(0, 40)}`, !modelMayAnswer(l));
for (const l of [
  "How did you hear about us?",
  "Are you willing to relocate to New York?",
  "Do you have experience with Python?",
  "Which office would you prefer?",
  "Highest level of education completed",
])
  ok(`may answer: ${l}`, modelMayAnswer(l));

const qs = [
  {
    label: "How did you hear about us?",
    options: ["LinkedIn", "Company Website", "Referral"],
  },
  { label: "Python experience?", options: ["Yes", "No"] },
];
const v = validateChoices(qs, [
  { index: 0, option: "company website" },
  { index: 1, option: "Maybe" },
  { index: 7, option: "Yes" },
  { index: 1, option: "" },
]);
ok(
  "validate: a case-insensitive exact match returns the form's own option string",
  v.length === 1 && v[0].option === "Company Website",
  JSON.stringify(v),
);

const facts = buildFormFacts({
  identity: { city: "Phoenix", state: "AZ", country: "United States" },
  work_authorization: { requires_sponsorship: true, visa_status: "F-1 OPT" },
  eeo: { gender: "Male", race: "Asian" },
  preferences: { willing_to_relocate: true },
  education: [
    {
      school: "Arizona State University",
      degree: "M.S.",
      field: "Computer Science",
      end: "2026-05",
    },
  ],
});
ok(
  "facts: no EEO or work-authorization data reaches the model",
  !/male|asian|sponsor|f-1|opt/i.test(facts),
  facts,
);
ok(
  "facts: location, education and relocation are included",
  /Phoenix/.test(facts) &&
    /Arizona State/.test(facts) &&
    /relocate: yes/i.test(facts),
);
ok(
  "choose: an option the form does not offer is dropped",
  (
    await chooseFormAnswers(
      qs,
      { facts, job: {} },
      stub({ answers: [{ index: 0, option: "Billboard" }] }),
    )
  ).length === 0,
);
ok(
  "choose: a valid option comes back",
  (
    await chooseFormAnswers(
      qs,
      { facts, job: {} },
      stub({ answers: [{ index: 1, option: "Yes", why: "Python" }] }),
    )
  )[0]?.option === "Yes",
);

/* ---- resume review: the filter over what the model says ---- */
const bank = await loadBank();
const r = renderResume(
  bank,
  { family: "ai", bulletIds: [] },
  { jobText: "python llm agents" },
);
const line = r.experience[0].bullets[0];
const f = filterReview(
  {
    verdict: "fix",
    weakLines: [
      { line, why: "x" },
      { line: "A line that is not on the page", why: "y" },
    ],
    missingKeywords: ["Sentry", "Rust", "Python"],
    note: "n",
  },
  r,
  bank,
);
ok(
  "review: only bullets on the page can be flagged",
  f.weakLines.length === 1 && f.weakLines[0].line === line,
);
ok(
  "review: a skill in the bank but off this page is 'have, not shown'",
  f.haveNotShown.includes("Sentry"),
  JSON.stringify(f),
);
ok(
  "review: a skill not in the bank is a gap, never a suggestion",
  f.gaps.includes("Rust") && !f.haveNotShown.includes("Rust"),
);
ok(
  "review: a keyword already on the page is dropped",
  !f.gaps.includes("Python") && !f.haveNotShown.includes("Python"),
);

/* ---- a role's min_bullets holds even when a review removes lines ---- */
{
  const nm = bank.experience.find((e) => e.id === "neuromonk");
  const out = renderResume(bank, { family: "ai", bulletIds: [] }, { jobText: "x", exclude: nm.bullets.slice(0, 3).map((b) => b.id) });
  const got = out.experience.find((e) => e.company === nm.company).bullets.length;
  ok("floor: ERP Co. keeps its min_bullets after three lines are excluded", got >= (nm.min_bullets || 0), String(got));
}

/* ---- triage: a cheap model may only remove on a verified, named blocker ---- */
{
  const { acceptRejection, triageBatch } = await import("../src/triage.js");
  const desc = "We need a Software Engineer. Requirements: 8+ years of professional experience in Java. Visa sponsorship available.";
  ok("triage: a quote that is in the posting, with 8 years, removes", acceptRejection({ qualified: false, blocker: "years", requiredYears: 8, quote: "8+ years of professional experience in Java" }, desc).remove === true);
  ok("triage: a quote not in the posting keeps the job", acceptRejection({ qualified: false, blocker: "no_sponsorship", requiredYears: -1, quote: "we will not sponsor visas" }, desc).remove === false);
  ok("triage: a years blocker under 4 keeps the job", acceptRejection({ qualified: false, blocker: "years", requiredYears: 3, quote: "8+ years of professional experience in Java" }, desc).remove === false);
  ok("triage: qualified or no named blocker keeps the job",
    !acceptRejection({ qualified: true, blocker: "none", requiredYears: -1, quote: "" }, desc).remove &&
    !acceptRejection({ qualified: false, blocker: "none", requiredYears: -1, quote: "8+ years of professional experience" }, desc).remove);
  const vs = await triageBatch([{ title: "a", description: desc }, { title: "b", description: desc }], {
    llm: { stubFactory: () => ({ verdicts: [{ index: 1, qualified: false, blocker: "years", requiredYears: 8, quote: "8+ years of professional experience in Java" }] }) },
  });
  ok("triage: verdicts map back by index, and a missing one is null", vs[0] === null && vs[1]?.remove === true, JSON.stringify(vs));
}

/* ---- revision: flagged lines leave the pool and cannot be topped back in ---- */
{
  const { tailorForJob } = await import("../src/tailor.js");
  const { tailorWithReview } = await import("../src/resume-review.js");
  const gjob = { title: "Software Engineer", description: "python llm agents ranking " + "x".repeat(500) };
  const draft = await tailorForJob(gjob, bank);
  const weak = draft.rendered.experience[0].bullets[0];
  const out = await tailorWithReview(gjob, bank, {
    reviewLlm: { stubFactory: () => ({ verdict: "fix", weakLines: [{ line: weak, why: "off-topic" }], missingKeywords: [], note: "n" }) },
  });
  const onPage = [...out.rendered.experience, ...out.rendered.projects].flatMap((e) => e.bullets);
  ok("revise: a 'fix' review triggers one revision", out.revised === true);
  ok("revise: the flagged line is gone from the page", !onPage.includes(weak));
  ok("revise: the exclusion is stored on the selection", (out.selection.avoidIds || []).length === 1);
  const again = await tailorForJob(gjob, bank, { cachedSelection: out.selection });
  ok("revise: re-rendering the cached selection cannot bring it back",
    ![...again.rendered.experience, ...again.rendered.projects].flatMap((e) => e.bullets).includes(weak));
  const keep = await tailorWithReview(gjob, bank, {
    reviewLlm: { stubFactory: () => ({ verdict: "send", weakLines: [], missingKeywords: [], note: "n" }) },
  });
  ok("revise: a 'send' review changes nothing", keep.revised === false);
}

console.log(failures.map((x) => `  FAIL ${x}`).join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? "  FAILURES" : "  all green");
process.exit(fail ? 1 : 0);
