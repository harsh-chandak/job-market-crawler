/**
 * A recruiter's read of the finished resume against the posting. Advisory only.
 *
 * The model cannot change the resume: every line on the page is still chosen
 * from the bank and checked byte for byte by verifyNoFabrication. This only
 * reports, and what it reports is filtered in code:
 *   - a "weak line" must be a bullet actually on the page;
 *   - a "missing keyword" is split into ones the candidate HAS (present in the
 *     bank but not on this page, worth a second look at the selection) and real
 *     gaps (not in the bank at all, never to be added).
 * The second list is the reason this is not left to the prompt: a reviewer
 * model will happily suggest adding a skill the candidate does not have.
 */

import { complete } from "./llm.js";
import { jobExcerpt, tailorForJob, indexBullets } from "./tailor.js";

export const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "weakLines", "missingKeywords", "note"],
  properties: {
    verdict: { type: "string", enum: ["send", "fix"] },
    weakLines: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["line", "why"],
        properties: { line: { type: "string" }, why: { type: "string" } },
      },
    },
    missingKeywords: { type: "array", maxItems: 6, items: { type: "string" } },
    note: { type: "string" },
  },
};

const SYSTEM = `You are a technical recruiter giving a one-page resume a 30-second read against one job posting. You return JSON only.

- verdict: "send" if it is a credible fit as it stands, "fix" if something on the page works against it.
- weakLines: up to 3 bullets that are off-topic for this posting or read as filler. Copy the bullet text exactly as it appears.
- missingKeywords: up to 6 skills, tools or domains the posting asks for that this page does not show. Short terms, as the posting words them.
- note: one plain sentence a recruiter would say.
Do not rewrite bullets and do not suggest new claims.`;

const pageText = (r) =>
  [
    ...Object.entries(r.skills || {}).map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`,
    ),
    ...(r.experience || []).flatMap((e) => e.bullets || []),
    ...(r.projects || []).flatMap((p) => [
      p.name,
      p.stack,
      ...(p.bullets || []),
    ]),
  ].join("\n");

const bankText = (bank) =>
  [
    ...Object.values(bank.skills || {}).flatMap((fam) =>
      Object.values(fam || {}),
    ),
    ...(bank.experience || []).flatMap((e) =>
      (e.bullets || []).map((b) => b.text),
    ),
    ...(bank.projects || []).flatMap((p) => [
      p.stack,
      ...(p.bullets || []).map((b) => b.text),
    ]),
  ].join("\n");

/** Deterministic filter over what the model said. */
export function filterReview(raw, rendered, bank) {
  const onPage = new Set([
    ...(rendered.experience || []).flatMap((e) => e.bullets || []),
    ...(rendered.projects || []).flatMap((p) => p.bullets || []),
  ]);
  const page = pageText(rendered).toLowerCase();
  const all = bankText(bank).toLowerCase();
  const weakLines = (raw?.weakLines || []).filter((w) =>
    onPage.has(String(w.line).trim()),
  );
  const haveNotShown = [];
  const gaps = [];
  for (const k of raw?.missingKeywords || []) {
    const t = String(k).trim();
    if (!t) continue;
    const lk = t.toLowerCase();
    if (page.includes(lk)) continue; // the model missed it; it is on the page
    (all.includes(lk) ? haveNotShown : gaps).push(t);
  }
  return {
    verdict: raw?.verdict === "fix" ? "fix" : "send",
    weakLines,
    haveNotShown,
    gaps,
    note: String(raw?.note || "").slice(0, 240),
  };
}

export async function reviewResume(job, rendered, bank, opts = {}) {
  const user = [
    `POSTING: ${job.companyName || job.companyToken || ""} | ${job.title || ""}`,
    jobExcerpt(job.description) || "(no description)",
    ``,
    `RESUME PAGE:`,
    pageText(rendered),
  ].join("\n");
  const res = await complete({
    stage: "review",
    system: SYSTEM,
    user,
    schema: REVIEW_SCHEMA,
    maxTokens: 700,
    stubFactory: () => ({
      verdict: "send",
      weakLines: [],
      missingKeywords: [],
      note: "stub",
    }),
    ...opts.llm,
  });
  return {
    ...filterReview(res.data, rendered, bank),
    model: res.model || null,
    at: new Date(),
  };
}

/**
 * Tailor, review, and when the review says "fix", revise once: the flagged
 * lines leave the candidate pool, the reviewer's note goes to the selector,
 * and the page is re-picked and reviewed again. One revision, never a loop,
 * and it can only move between bank lines, never write one.
 */
export async function tailorWithReview(job, bank, opts = {}) {
  const first = await tailorForJob(job, bank, opts);
  const review = await reviewResume(job, first.rendered, bank, { llm: opts.reviewLlm ?? opts.llm });
  if (review.verdict !== "fix" || !review.weakLines.length || opts.revise === false)
    return { ...first, review, revised: false };
  const byText = new Map([...indexBullets(bank)].map(([id, b]) => [b.text, id]));
  const avoidIds = [
    ...new Set([...(first.selection.avoidIds || []), ...review.weakLines.map((w) => byText.get(w.line)).filter(Boolean)]),
  ];
  const hint = [
    review.note,
    review.haveNotShown.length ? `The candidate has these and the draft did not show them: ${review.haveNotShown.join(", ")}.` : "",
    "Lines judged weak for this posting have been removed from the options.",
  ]
    .filter(Boolean)
    .join(" ");
  const second = await tailorForJob(job, bank, { ...opts, cachedSelection: null, avoidIds, hint });
  const review2 = await reviewResume(job, second.rendered, bank, { llm: opts.reviewLlm ?? opts.llm });
  return { ...second, review: review2, firstReview: review, revised: true };
}

/** Console lines for the apply scripts. */
export function formatReview(rv) {
  if (!rv) return [];
  const out = [`  review (${rv.verdict}): ${rv.note}`];
  for (const w of rv.weakLines || [])
    out.push(`    weak: "${w.line.slice(0, 80)}" (${w.why})`);
  if (rv.haveNotShown?.length)
    out.push(
      `    you have but it is not on this page: ${rv.haveNotShown.join(", ")}`,
    );
  if (rv.gaps?.length)
    out.push(`    posting asks, you do not claim: ${rv.gaps.join(", ")}`);
  return out;
}
