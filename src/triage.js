/**
 * Cheap triage: does a hard, stated blocker rule this candidate out?
 *
 * The queue holds far more postings than are worth a full fit score, and most
 * fail on something plain: 5+ years required, a senior title, a citizenship or
 * clearance bar, "we do not sponsor". Haiku answers that one question for a
 * fraction of what a scoring call costs, so the expensive model only sees jobs
 * that are actually open to this candidate. Postings go five to a call: most of
 * a headless call's time is the CLI starting up, not the model.
 *
 * A cheap model is allowed to reject only under rules enforced here:
 *   - one of five named blockers, never a judgement of fit;
 *   - a quote from the posting that must actually appear in it;
 *   - for years, its own extracted requirement must be 4 or more.
 * Anything else keeps the job. Rejected jobs are marked, not deleted.
 */

import { complete } from "./llm.js";
import { jobExcerpt } from "./tailor.js";

export const TRIAGE_MODEL = process.env.TRIAGE_MODEL || "claude-haiku-4-5";

const BLOCKERS = ["none", "years", "seniority", "citizenship_or_clearance", "no_sponsorship", "not_engineering"];

export const TRIAGE_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "qualified", "blocker", "requiredYears", "quote"],
        properties: {
          index: { type: "integer", minimum: 0 },
          qualified: { type: "boolean" },
          blocker: { type: "string", enum: BLOCKERS },
          requiredYears: { type: "integer", minimum: -1, maximum: 20 },
          quote: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `You triage job postings for one candidate. You return JSON only.

Candidate: M.S. Computer Science (May 2026), about 2 years of full-time software and AI engineering. On F-1 OPT: authorized to work now, will need H-1B sponsorship later. Not a U.S. citizen or permanent resident. No security clearance.

For EACH posting, set qualified=false ONLY when that posting clearly states one of these blockers:
- years: it REQUIRES 4 or more years of experience (preferred or nice-to-have does not count)
- seniority: the role is senior, staff, principal, lead or manager level
- citizenship_or_clearance: it requires U.S. citizenship, a green card, or a security clearance
- no_sponsorship: it says it will not sponsor work visas now or in the future
- not_engineering: it is not a software, ML, AI or data engineering role
Otherwise qualified=true and blocker="none". When unsure, qualified=true.
requiredYears: the minimum years REQUIRED, or -1 if none is stated.
quote: copy the exact words from THAT posting that decide it (under 25 words), or "" when qualified.
Return one verdict per posting, with its index.`;

const squash = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9+']+/g, " ").trim();

/** The rules a triage verdict must pass before a job may be removed. */
export function acceptRejection(v, description) {
  if (!v || v.qualified !== false) return { remove: false, why: "qualified" };
  if (!BLOCKERS.includes(v.blocker) || v.blocker === "none") return { remove: false, why: "no named blocker" };
  const q = squash(v.quote);
  if (q.length < 8 || !squash(description).includes(q)) return { remove: false, why: "quote not found in the posting" };
  if (v.blocker === "years" && !(v.requiredYears >= 4)) return { remove: false, why: "years under 4" };
  return { remove: true, why: v.blocker };
}

/** Verdicts for up to a handful of postings in one call, in input order. A missing verdict is null. */
export async function triageBatch(jobs, opts = {}) {
  const user =
    jobs
      .map((job, i) => `### POSTING ${i}: ${job.companyName || job.companyToken || ""} | ${job.title || ""}\n${jobExcerpt(job.description, 2500) || "(no description)"}`)
      .join("\n\n") + `\n\nReturn ${jobs.length} verdict(s), indexes 0-${jobs.length - 1}.`;
  const res = await complete({
    stage: "triage",
    model: TRIAGE_MODEL,
    system: SYSTEM,
    user,
    schema: TRIAGE_SCHEMA,
    maxTokens: 220 * jobs.length + 100,
    stubFactory: () => ({ verdicts: jobs.map((_, i) => ({ index: i, qualified: true, blocker: "none", requiredYears: -1, quote: "" })) }),
    ...opts.llm,
  });
  const byIndex = new Map((res.data?.verdicts || []).map((v) => [v.index, v]));
  return jobs.map((job, i) => {
    const v = byIndex.get(i);
    return v ? { ...v, ...acceptRejection(v, job.description), model: TRIAGE_MODEL } : null;
  });
}

export async function triageJob(job, opts = {}) {
  return (await triageBatch([job], opts))[0];
}
