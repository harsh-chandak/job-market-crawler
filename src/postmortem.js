/**
 * Loss analysis: why an application was rejected, stated and inferred.
 *
 * A rejection that is only counted teaches nothing. Three of the same
 * objection is a positioning problem, not luck, and the fix becomes a change
 * to targeting, a resume line, or getting a person attached.
 *
 * The model classifies from facts assembled here (the posting, the score's
 * gaps, the rejection email's subject, how fast it came, whether a person was
 * attached) and nothing else; it runs with no tools. What it returns is
 * checked in code: a class from a fixed list, "none given" as the stated
 * reason whenever the employer gave none, and low confidence whenever its
 * evidence quote is not actually in the facts.
 *
 * Adapted from JobFinderOS (github.com/matthewprice/JobFinderOS, MIT License,
 * (c) 2026 Matthew Price): /postmortem and recruiter_playbook.md section 9.
 */
import { complete } from "./llm.js";
import { jobExcerpt } from "./tailor.js";

// Bulk classification over short facts; Fable stays on scoring and resumes.
export const POSTMORTEM_MODEL =
  process.env.POSTMORTEM_MODEL || "claude-sonnet-5";
export const CLASSES = [
  "work_authorization",
  "level_or_years",
  "skills_or_domain_gap",
  "location",
  "comp",
  "slate_or_timing",
  "role_closed",
  "unknown",
];
export const STAGES = [
  "application",
  "assessment",
  "screen",
  "interview",
  "final",
];
export const CONFIDENCE = ["low", "medium", "high"];

const WORK_AUTH_RE =
  /[^.\n]{0,80}\b(?:(?:unable|not able|will not|won't|do(?:es)? not|cannot|can't|not)\s+(?:to\s+)?(?:provide|offer|support|consider)?\s*(?:visa\s+|employment\s+|immigration\s+)?sponsor(?:ship)?|sponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided)|without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?(?:employer\s+|visa\s+)?sponsorship|must\s+be\s+(?:a\s+)?u\.?s\.?\s+citizens?|citizenship\s+(?:is\s+)?required|(?:active|current)\s+security\s+clearance)[^.\n]{0,60}/i;

/** The posting's own words barring sponsorship, citizenship or clearance, if any. */
export function workAuthQuote(description) {
  const m = WORK_AUTH_RE.exec(String(description || ""));
  return m ? m[0].replace(/\s+/g, " ").trim().slice(0, 200) : null;
}

export function buildFacts(job, { attached = "cold" } = {}) {
  const appliedAt = job.submitAttemptAt ? new Date(job.submitAttemptAt) : null;
  const fromEmail = job.outcome === "rejected" && job.outcomeAt;
  const rejectedAt = fromEmail
    ? new Date(job.outcomeAt)
    : job.reply?.at
      ? new Date(job.reply.at)
      : null;
  const days =
    appliedAt && rejectedAt
      ? Math.max(0, Math.round((rejectedAt - appliedAt) / 864e5))
      : null;
  return {
    company: job.companyName || job.companyToken || null,
    title: job.title || null,
    applicationSystem: job.ats || null,
    applied: appliedAt ? appliedAt.toISOString().slice(0, 10) : null,
    daysToRejection: days,
    rejectionDateExact: !!(fromEmail && job.outcomeDateKnown),
    rejectionEmailSubject: job.outcomeSubject || null,
    candidateNote: job.reply?.note || null,
    stage: STAGES.includes(job.pipelineStage)
      ? job.pipelineStage
      : "application",
    fit: job.llmScore?.fit ?? null,
    scoreGaps: job.llmScore?.gaps || [],
    seniorityFit: job.llmScore?.seniorityFit || null,
    sponsorshipSignal: job.llmScore?.sponsorshipSignal || null,
    postingYearsRequired: job.screen?.yoe ?? null,
    postingWorkAuthQuote: workAuthQuote(job.description),
    resumeReviewGaps: job.resumeReview?.gaps || [],
    personAttached: attached,
    posting: jobExcerpt(job.description || "", 2000) || null,
  };
}

export const POSTMORTEM_SCHEMA = {
  type: "object",
  required: ["stated", "inferred", "class", "confidence", "evidence", "fix"],
  properties: {
    stated: { type: "string" },
    inferred: { type: "string" },
    class: { type: "string", enum: CLASSES },
    confidence: { type: "string", enum: CONFIDENCE },
    evidence: { type: "string" },
    fix: { type: "string" },
  },
};

const SYSTEM = `You analyse one lost job application and name the most likely objection. You return JSON only.

Candidate: M.S. Computer Science (May 2026), about 2 years of full-time software and AI engineering, on F-1 OPT and needing H-1B sponsorship later. Applies to software and AI engineering roles, mostly through company job boards with nobody inside attached.

- stated: the employer's own reason, from rejectionEmailSubject only. Most rejections give none: then "none given". candidateNote is the candidate's own label, not the employer's words.
- inferred: one or two sentences on what most likely happened, reasoning only from the facts given.
- class: work_authorization (the posting bars sponsorship, citizenship or clearance, or a sponsorship question likely screened him out), level_or_years (asks for more years or seniority than he has), skills_or_domain_gap (a required skill or domain his resume does not show; see scoreGaps and resumeReviewGaps), location, comp, slate_or_timing (someone closer, a filled requisition, a slow fade), role_closed, unknown.
- confidence: high only when a fact states it outright (postingWorkAuthQuote, a stated year requirement); medium when the facts point to it; low otherwise. A rejection within 2 days of applying usually means an automated screen or a knockout question: a clue, not proof.
- evidence: copy a short exact phrase from the facts that supports the class, or "".
- fix: one concrete change for the next application of this kind: targeting, a resume line he already has, an honest answer prepared in advance, or getting a person attached. Never suggest claiming experience he lacks or hiding his sponsorship need.`;

const squash = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The checks a model's postmortem must pass before it is stored. */
export function acceptPostmortem(raw, facts) {
  const out = {
    stated: String(raw?.stated || "").slice(0, 300),
    inferred: String(raw?.inferred || "").slice(0, 400),
    class: CLASSES.includes(raw?.class) ? raw.class : "unknown",
    confidence: CONFIDENCE.includes(raw?.confidence) ? raw.confidence : "low",
    evidence: String(raw?.evidence || "").slice(0, 240),
    fix: String(raw?.fix || "").slice(0, 300),
  };
  if (!facts.rejectionEmailSubject) out.stated = "none given";
  const ev = squash(out.evidence);
  out.evidenceVerified =
    ev.length >= 6 && squash(JSON.stringify(facts)).includes(ev);
  if (out.class === "unknown" || !out.evidenceVerified) out.confidence = "low";
  return out;
}

export async function postmortemJob(
  job,
  { attached = "cold", model = POSTMORTEM_MODEL, llm = {} } = {},
) {
  const facts = buildFacts(job, { attached });
  const res = await complete({
    stage: "postmortem",
    model,
    system: SYSTEM,
    user: `FACTS:\n${JSON.stringify(facts, null, 1)}`,
    schema: POSTMORTEM_SCHEMA,
    maxTokens: 500,
    stubFactory: () => ({
      stated: "none given",
      inferred: "stub",
      class: "unknown",
      confidence: "low",
      evidence: "",
      fix: "stub",
    }),
    ...llm,
  });
  return {
    ...acceptPostmortem(res.data, facts),
    stage: facts.stage,
    personAttached: attached,
    daysToRejection: facts.daysToRejection,
    model,
    source: "model",
    at: new Date(),
  };
}

/** Counts by class, counting only medium and high confidence, and the classes seen three times or more. */
export function objectionPatterns(pms) {
  const counted = pms.filter(
    (p) => p && p.class !== "unknown" && p.confidence !== "low",
  );
  const byClass = {};
  for (const p of counted) byClass[p.class] = (byClass[p.class] || 0) + 1;
  const patterns = Object.entries(byClass)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => ({ class: cls, n }));
  return {
    byClass,
    patterns,
    unknownOrLow: pms.filter(Boolean).length - counted.length,
  };
}
