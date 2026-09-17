/**
 * Model answers for the multiple-choice questions the rule-based filler leaves.
 *
 * The label-matching filler answers name, contact, education, work
 * authorization and EEO from data/answers.yaml. Everything employer-specific
 * ("How did you hear about us?", "Which office?", "Are you open to relocating?")
 * it leaves blank, and 83 applications went out or were handed back with a
 * required "Select..." still showing.
 *
 * What the model may and may not touch is decided HERE, in code, not in the
 * prompt:
 *   - it only ever picks one of the options the form itself offers, checked
 *     after the fact against that list;
 *   - it never sees, and is never asked, anything about work authorization,
 *     sponsorship, citizenship, clearance, EEO, disability, veteran status,
 *     salary, criminal history, or a consent or acknowledgement;
 *   - "" means leave it for the candidate, and that is the right answer
 *     whenever the facts do not settle the question.
 * Nothing here submits anything. The candidate reviews every AI answer.
 */

import { complete } from "./llm.js";

// Questions the model is never shown. Legal assertions, protected traits,
// negotiation, and anything that agrees to something. These stay with the
// deterministic answers from data/answers.yaml or with the candidate.
const OFF_LIMITS =
  /sponsor|visa|work (permit|authori[sz])|authori[sz]ed to work|eligib\w* to work|right to work|citizen|green card|permanent resident|clearance|export|itar|u\.?s\.? person|gender|transgender|pronoun|race|ethnic|hispanic|latin|veteran|military|disabilit|sexual orientation|salary|compensation|pay (range|expectation)|expected pay|desired pay|criminal|convict|felony|arrest|background check|drug|acknowledg|consent|i agree|agree to|terms|privacy|e-?sign|signature|certify|attest/i;

export function modelMayAnswer(label) {
  const t = String(label || "").trim();
  if (t.length < 3) return false;
  return !OFF_LIMITS.test(t);
}

const norm = (s) =>
  String(s ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\*/g, "")
    .trim()
    .toLowerCase();

/**
 * Keep only answers that are exactly one of the question's offered options,
 * returned as the form's own option string.
 */
export function validateChoices(questions, answers) {
  const out = [];
  for (const a of answers || []) {
    const q = questions[a?.index];
    if (!q) continue;
    const want = norm(a.option);
    if (!want) continue;
    const hits = q.options.filter((o) => norm(o) === want);
    if (hits.length !== 1) continue;
    out.push({
      index: a.index,
      option: hits[0],
      why: String(a.why || "").slice(0, 160),
    });
  }
  return out;
}

/** The candidate facts the model may answer from. No EEO, no work authorization. */
export function buildFormFacts(answers = {}, rendered = null) {
  const id = answers.identity || {};
  const pref = answers.preferences || {};
  const lines = [];
  const loc = [id.city, id.state, id.country].filter(Boolean).join(", ");
  if (loc) lines.push(`Lives in: ${loc}`);
  for (const e of answers.education || []) {
    lines.push(
      `Education: ${[e.degree, e.field].filter(Boolean).join(" ")}, ${e.school}` +
        (e.end ? `, ${e.end}` : "") +
        (e.gpa != null ? ` (GPA ${e.gpa})` : ""),
    );
  }
  if (pref.earliest_start)
    lines.push(`Earliest start date: ${pref.earliest_start}`);
  if (pref.willing_to_relocate != null)
    lines.push(
      `Willing to relocate: ${pref.willing_to_relocate ? "yes" : "no"}`,
    );
  lines.push("Found this job on the company's own careers site.");
  if (rendered) {
    for (const [k, v] of Object.entries(rendered.skills || {}))
      lines.push(`Skill (${k}): ${Array.isArray(v) ? v.join(", ") : v}`);
    for (const e of rendered.experience || [])
      for (const b of e.bullets || [])
        lines.push(`Did at ${e.company.split(" (")[0]}: ${b}`);
  }
  return lines.join("\n");
}

export const FORM_SCHEMA = {
  type: "object",
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "option"],
        properties: {
          index: { type: "integer", minimum: 0 },
          option: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `You answer the leftover multiple-choice questions on one job application, for the candidate. You return JSON only.

For each question return exactly one option copied character for character from that question's OPTIONS, or "" to leave it for the candidate.
- Answer only when the candidate facts clearly settle it. When they do not, return "".
- Yes/No about experience with a skill or tool: "Yes" only if the facts show it.
- Office or location preference: pick an offered option only if it matches where the candidate lives or the facts say they will relocate.
- "How did you hear about us": the candidate found it on the company's careers site.
- Never infer anything about legal status, identity, health, pay or history. Those return "".
Give "why" as a few words naming the fact you used.`;

/**
 * questions: [{ label, options: [string] }]
 * Returns only validated answers: [{ index, option, why }].
 */
export async function chooseFormAnswers(questions, { facts, job }, opts = {}) {
  if (!questions.length) return [];
  const user = [
    `CANDIDATE FACTS:`,
    facts,
    ``,
    `JOB: ${job?.company || ""} | ${job?.title || ""}${job?.location ? ` | ${job.location}` : ""}`,
    ``,
    `QUESTIONS:`,
    ...questions.map(
      (q, i) =>
        `${i}. ${q.label}\n   OPTIONS: ${q.options.map((o) => JSON.stringify(o)).join(" | ")}`,
    ),
  ].join("\n");
  const res = await complete({
    stage: "formfill",
    system: SYSTEM,
    user,
    schema: FORM_SCHEMA,
    maxTokens: 800,
    stubFactory: () => ({ answers: [] }),
    ...opts.llm,
  });
  return validateChoices(questions, res.data?.answers);
}
