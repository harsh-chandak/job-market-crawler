/**
 * A model's second look at borderline screen rejections.
 *
 * The screen is fixed rules over title and body text, and two of its rules are
 * guesses: a years-of-experience regex (it reads "5+ years preferred" the same
 * as "5+ years required") and a title table (it misses a real engineering
 * role under a name it has never seen). A wrong reject is permanent, because
 * nothing downstream ever looks at a screened_out job again.
 *
 * Only those two reasons are re-read, and only when they are the ONLY reasons.
 * Work authorization, export control, internships, future cohorts and the
 * forward-deployed exclusion are decisions, not guesses; the model never sees
 * them. Volume is a few a day, so this spends almost nothing of the Max plan.
 */

import { complete } from "./llm.js";
import { jobExcerpt } from "./tailor.js";

// Years-of-experience values close enough to the limit (3) that the regex may
// have misread them. A posting that says 6+ is not a borderline call.
const BORDERLINE_YOE = new Set([4, 5]);

export function isBorderlineRejection(screen) {
  const reasons = screen?.reasons || [];
  if (!reasons.length) return false;
  return reasons.every((r) => {
    if (r === "no_role_family") return true;
    const m = /^yoe:(\d+)$/.exec(r);
    return !!m && BORDERLINE_YOE.has(Number(m[1]));
  });
}

export const SECOND_LOOK_SCHEMA = {
  type: "object",
  required: ["requiredYears", "family", "rescue", "reason"],
  properties: {
    requiredYears: { type: "integer", minimum: -1, maximum: 20 },
    family: { type: "string", enum: ["swe", "ai", "none"] },
    rescue: { type: "boolean" },
    reason: { type: "string" },
  },
};

const SYSTEM = `You double-check one job-screening rejection. You return JSON only.

A fixed rule rejected this posting for one of two reasons:
- "yoe:N": a regex read N years of experience as required.
- "no_role_family": the title did not match a known software, ML or AI engineering title.

Read the posting and decide whether the rule was wrong.
- requiredYears: the MINIMUM years of experience the posting REQUIRES. Years that are
  preferred, a plus or nice to have do not count. Degree-substitution clauses ("or a
  Master's and 2 years") count at their lowest option. -1 if the posting states none.
- family: "swe" for software engineering, "ai" for ML, LLM, AI or data engineering,
  "none" for anything else (sales, support, research scientist, management, hardware).
- rescue: true only if family is swe or ai AND requiredYears is 3 or less (or -1).
- reason: one short sentence quoting the words that decided it.`;

export async function secondLook(job, profile, opts = {}) {
  const user = [
    `CANDIDATE: ${profile}`,
    ``,
    `REJECTED FOR: ${(job.screen?.reasons || []).join(", ")}`,
    ``,
    `POSTING: ${job.companyName || job.companyToken} | ${job.title}`,
    jobExcerpt(job.description) || "(no description)",
  ].join("\n");
  const res = await complete({
    stage: "secondlook",
    system: SYSTEM,
    user,
    schema: SECOND_LOOK_SCHEMA,
    maxTokens: 400,
    stubFactory: () => ({
      requiredYears: 3,
      family: "swe",
      rescue: true,
      reason: "stub",
    }),
    ...opts.llm,
  });
  const d = res.data || {};
  // The model's rescue flag is checked against its own extracted number, so a
  // loose "rescue: true" on a posting it read as 5 years required is refused.
  const yearsOk =
    d.requiredYears === -1 || (d.requiredYears >= 0 && d.requiredYears <= 3);
  const rescue =
    !!d.rescue && (d.family === "swe" || d.family === "ai") && yearsOk;
  return { ...d, rescue, model: res.model || null };
}
