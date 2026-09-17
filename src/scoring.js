/**
 * LLM fit scoring.
 *
 * Runs only on postings that already cleared the deterministic screen, so the
 * volume is small (tens per day, not thousands) and the cost stays negligible
 * regardless of provider.
 *
 * Two things the model is NOT asked to do:
 *   - decide work authorization. That comes from the company-level H-1B /
 *     E-Verify join, which is factual. The model only reads what the JD says.
 *   - invent anything about the candidate. It is given a fixed profile summary
 *     and scores the job against it.
 *
 * Results are cached against the job's contentHash, so re-running after a prompt
 * change costs nothing for unchanged postings.
 */

import { completeWithFallback as complete } from "./llm.js";
import { sha256 } from "./util/normalize.js";
import { jobExcerpt } from "./tailor.js";

export const SCORE_SCHEMA = {
  type: "object",
  required: ["fit", "family", "verdict", "reasons", "matched", "gaps"],
  properties: {
    fit: { type: "integer", minimum: 0, maximum: 100 },
    family: { type: "string", enum: ["swe", "ai", "none"] },
    verdict: { type: "string", enum: ["strong", "good", "stretch", "poor"] },
    reasons: { type: "array", maxItems: 4, items: { type: "string" } },
    matched: { type: "array", maxItems: 8, items: { type: "string" } },
    gaps: { type: "array", maxItems: 5, items: { type: "string" } },
    seniorityFit: {
      type: "string",
      enum: ["under", "right", "over", "unknown"],
    },
    sponsorshipSignal: {
      type: "string",
      enum: ["positive", "negative", "silent"],
    },
  },
};

const SYSTEM = `You are a precise job-fit evaluator. You return JSON only, no prose.

You score how well ONE candidate fits ONE job posting. Be calibrated and honest:
most postings are a partial fit. Reserve fit > 85 for genuinely strong matches.

Rules:
- Score against the candidate profile you are given. Do not assume skills that
  are not listed.
- "family" is which of the candidate's two resume variants best matches:
  swe (full-stack / backend) or ai (ML, LLM, data). Use "none" if it is not an
  engineering role the candidate should apply to. Forward-deployed, solutions
  and other customer-facing engineering roles are not targeted, because most
  of them do not sponsor visas: use "none" and a fit under 40.
- "seniorityFit": "over" means the job wants more experience than the candidate
  has. The candidate has about 2 years full-time plus an MS (May 2026).
- "sponsorshipSignal" reflects only what the POSTING says about visa
  sponsorship or citizenship. Say "silent" if it does not mention it. Do not
  guess from the company name.
- "matched" lists concrete overlapping skills/technologies, "gaps" lists
  concrete requirements the candidate does not demonstrate.`;

export function candidateProfile(bank) {
  const p = bank.profile;
  const skills = new Set();
  for (const fam of Object.values(bank.skills || {})) {
    for (const v of Object.values(fam))
      String(v)
        .split(/,\s*/)
        .forEach((s) => skills.add(s.trim()));
  }
  const exp = (bank.experience || []).map(
    (e) => `${e.role} at ${e.company} (${e.dates})`,
  );
  return [
    `Name: ${p.name}. Location: ${p.location}.`,
    `Education: ${(bank.education || []).map((e) => `${e.degree}, ${e.school} (${e.dates})`).join("; ")}.`,
    `Experience: ${exp.join("; ")}.`,
    // Two years, not three. The overstatement shipped in every scoring call and
    // shifted every score against a bar he had not actually cleared.
    //
    // Stated as context rather than a cutoff on purpose: the MS and the depth of
    // the work close most of a three-to-four-year gap, and a scorer told only
    // "2 years" reads a 4-year posting as disqualifying when it is not. The
    // years screen in filter.js is the place for a hard bar; this line is for
    // judgement.
    `Just over 2 years of full-time professional experience, plus an MS in Computer Science (May 2026).`,
    `Treat stated years-of-experience bars as soft: the MS and the depth of the work close most of a 3-4 year gap. Only a bar well above that is genuinely disqualifying.`,
    `Skills: ${[...skills].join(", ")}.`,
    `Work authorization: on STEM OPT, will require H-1B sponsorship.`,
  ].join("\n");
}

function jobBlock(job) {
  const loc = (job.locations || []).slice(0, 4).join(" | ");
  // "The requirements are near the top" is not true and was measured not to be:
  // of 84 approved postings, 18 kept theirs past character 2200, and Scout Motors
  // opens an AI Infrastructure Engineer posting with two paragraphs about 1960s
  // trucks. jobExcerpt keeps a short head for framing and spends the rest of the
  // budget on the densest requirements window it can find — the same function the
  // bullet selector uses, so both halves of the pipeline read the same half of the
  // posting. Fewer tokens AND the ones that decide the answer.
  const desc = jobExcerpt(job.description, Number(process.env.JD_CHARS || 2200));
  return [
    `Company: ${job.companyName || job.companyToken}`,
    `Title: ${job.title}`,
    `Location: ${loc || "unspecified"}`,
    desc
      ? `Description:\n${desc}`
      : "Description: (not available from this source)",
  ].join("\n");
}

/** Deterministic offline scorer so tests and dry runs need no model at all. */
function stubFactory(seed, user) {
  const fit = 40 + (seed % 55);
  const fam = ["swe", "ai"][seed % 2];
  return {
    fit,
    family: fam,
    verdict:
      fit > 85 ? "strong" : fit > 65 ? "good" : fit > 45 ? "stretch" : "poor",
    reasons: ["stub scorer — deterministic output derived from input hash"],
    matched: ["python"],
    gaps: [],
    seniorityFit: "right",
    sponsorshipSignal: /sponsor/i.test(user) ? "positive" : "silent",
  };
}

export function scoreCacheKey(job, promptVersion = "v1") {
  return sha256(`${promptVersion}|${job.contentHash || job.title}`);
}

export async function scoreJob(job, bank, opts = {}) {
  const profile = opts.profile || candidateProfile(bank);
  const user = `CANDIDATE PROFILE:\n${profile}\n\nJOB POSTING:\n${jobBlock(job)}\n\nReturn JSON matching the required schema.`;

  const res = await complete({
    stage: "score",
    system: SYSTEM,
    user,
    schema: SCORE_SCHEMA,
    // Scoring is a bounded judgement against a fixed schema, and Sonnet 5 thinks
    // by DEFAULT — an omitted `thinking` parameter runs adaptive. The same fix was
    // applied to bullet selection with a measurement behind it (1,570 output
    // tokens with thinking, 204 without, for a one-id difference) and then not
    // applied here, so the higher-volume of the two paths kept paying for it:
    // roughly 250 scoring calls a day, all billing reasoning as output at $10/M.
    thinkingDisabled: true,
    // Thinking also counts against max_tokens, which is what truncated a resume
    // selection mid-JSON at a 2,000 ceiling. This one had 900.
    maxTokens: 900,
    stubFactory,
    ...opts.llm,
  });

  return {
    ...res.data,
    _meta: {
      provider: res.provider,
      model: res.model,
      attempts: res.attempts,
      cacheKey: scoreCacheKey(job),
    },
  };
}

/**
 * Score a batch, skipping anything already scored under the same prompt version.
 * Concurrency is deliberately low — local models are the dev default and will
 * thrash if hammered.
 */
export async function scoreBatch(
  jobs,
  bank,
  { concurrency = 3, onResult, ...opts } = {},
) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (i < jobs.length) {
        const idx = i++;
        const job = jobs[idx];
        try {
          const score = await scoreJob(job, bank, opts);
          out[idx] = { job, score };
        } catch (err) {
          out[idx] = { job, error: String(err?.message || err) };
        }
        if (onResult) onResult(out[idx], idx, jobs.length);
      }
    }),
  );
  return out;
}
