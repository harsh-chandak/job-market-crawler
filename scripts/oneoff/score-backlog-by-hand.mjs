/**
 * Score the backlog from this session's reading. No API call anywhere.
 *
 * A rubric applied consistently, not 178 separate deliberations — and it is
 * marked as such in _meta so a later reader can tell it apart from a model
 * score. It reads the same signals a screener would: title family, years asked,
 * stack overlap against the bank, and explicit work-authorisation language.
 */
import "dotenv/config";
import { getDb, closeDb } from "../../src/db.js";
import { jobExcerpt } from "../../src/tailor.js";
import { extractYoE } from "../../src/filter.js";

const OWN = ["python","typescript","javascript","react","node","fastapi","django","graphql","sql","postgres","mongodb","redis","aws","docker","kubernetes","llm","rag","langgraph","langchain","agent","kafka","pytorch"];
const FOREIGN = ["java","c++","c#",".net","go","golang","rust","scala","kotlin","swift","ruby","php","matlab","verilog"];
/**
 * Employers that can only hire US persons, whatever the posting says.
 *
 * SpaceX's ITAR notice sits at the very bottom of its postings, past the 5,000
 * character storage cut, so no amount of text analysis finds it — eight SpaceX
 * roles scored 88-90 on a first pass. Export-controlled defence and space work
 * requires citizen, permanent resident, asylee or refugee status. He is on F-1.
 * Kept deliberately short: only employers whose restriction is categorical.
 */
const US_PERSON_ONLY = /spacex|blue origin|anduril|lockheed|raytheon|northrop|l3harris|general dynamics|leidos|booz allen|mitre|aerospace corp|draper|sierra nevada|rocket lab/i;

/** A language in the TITLE is the job, not a passing mention in the body. */
const FOREIGN_TITLE =
  /\bc#(?![a-z])|\bc\/c\+\+|\bc\+\+|\bjava\b(?!script)|(?<![a-z0-9])\.net\b|\bgolang\b|\brust\b|\bscala\b|\bkotlin\b|\bswift\b|\bruby\b|\bphp\b|\bandroid\b|\bios\b/i;

const rx = (t) => new RegExp(`(^|[^a-z0-9+#./-])${t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}([^a-z0-9+#./-]|$)`,"i");

function score(title, jd, company = "") {
  const t = title.toLowerCase(), low = `${title}\n${jd}`.toLowerCase();
  let base, family;
  // Role type is decided before the AI keyword. "DevOps Engineer - AI Runtime
  // Services" is a DevOps job; matching on "AI" first scored it 90.
  if (/forward deployed|solutions engineer|customer engineer|deployment engineer/.test(t)) { base = 62; family = "fde"; }
  else if (/\bsre\b|site reliability|devops|infrastructure engineer|cloud engineer|platform reliability/.test(t)) { base = 48; family = "swe"; }
  else if (/\btest\b|\bqa\b|validation|quality assurance/.test(t)) { base = 40; family = "swe"; }
  else if (/\bai\b|\bml\b|machine learning|llm|genai|agentic|applied scientist|data scientist/.test(t)) { base = 62; family = "ai"; }
  else if (/software (engineer|developer)|swe\b|sde\b|full.?stack|backend|front.?end|platform engineer|product engineer/.test(t)) { base = 60; family = "swe"; }
  else if (/data engineer|analytics engineer/.test(t)) { base = 50; family = "swe"; }
  else if (/\bsre\b|site reliability|devops|infrastructure engineer|cloud engineer/.test(t)) { base = 48; family = "swe"; }
  else { base = 33; family = "swe"; }             // test, QA, security, systems, devrel, hardware

  // Roles whose day-to-day is not what he has done, whatever the title says.
  if (/\btest\b|\bqa\b|validation|quality assurance/.test(t)) base -= 8;
  // A language he does not write, named in the title. "Software Engineer, C#"
  // and "Software Engineer, Backend (C/C++)" both scored 88 because the body
  // mentioned his stack somewhere.
  if (FOREIGN_TITLE.test(t)) base -= 30;
  if (/developer relations|advocate|evangelist/.test(t)) base -= 20;
  if (/embedded|firmware|packaging|hardware|mechanical|electrical/.test(t)) base -= 22;
  if (/intern\b|internship/.test(t)) base -= 30;
  if (/senior|staff|principal|lead\b|manager|director/.test(t)) base -= 22;

  const yrs = extractYoE(jd);
  if (yrs == null || yrs <= 2) base += 8;
  else if (yrs === 3) base += 2;
  else if (yrs === 4) base -= 6;
  else if (yrs === 5) base -= 12;
  else base -= 26;

  const own = OWN.filter((x) => rx(x).test(low));
  const foreign = FOREIGN.filter((x) => rx(x).test(low));
  base += Math.min(20, own.length * 4);
  if (!own.length && foreign.length) base -= Math.min(18, foreign.length * 6);

  let verdict = "fair";
  if (US_PERSON_ONLY.test(company)) { base -= 55; verdict = "US-person-only employer (export control)"; }
  if (/(do not|does not|cannot|unable to|not able to)\s+(provide|offer|sponsor)/.test(low)
      || /no visa sponsorship|without sponsorship|must be a? ?(us|u\.s\.) citizen|security clearance|green card holder/.test(low)) {
    base -= 45; verdict = "blocked on work authorisation";
  }

  const fit = Math.max(0, Math.min(100, Math.round(base)));
  if (fit >= 78) verdict = "strong";
  else if (fit >= 68) verdict = "good";
  else if (fit >= 55) verdict = "fair";
  else if (verdict === "fair") verdict = "poor";
  return { fit, family, verdict, yrs, own, foreign };
}

const db = await getDb();
const jobs = db.collection("jobs");
const rows = await jobs.find(
  // No prerank floor. Leaving low-preranked rows unscored did not hide them —
  // it made them look UNJUDGED, and the "Newest found" view deliberately shows
  // unjudged postings. Forty-two unscored SpaceX rows, all US-person-only, sat
  // at the top of that view for days.
  { status: "new",
    $or: [{ "llmScore.fit": { $exists: false } }, { "llmScore._meta.rubric": { $in: ["session-v1", "session-v2", "session-v3"] } }] },
  { projection: { title: 1, description: 1, companyName: 1, companyToken: 1 } },
).toArray();

let n = 0; const dist = {};
for (const r of rows) {
  const jd = jobExcerpt(r.description);
  const s = score(r.title || "", jd, r.companyName || r.companyToken || "");
  const band = s.fit >= 78 ? "78+" : s.fit >= 70 ? "70-77" : s.fit >= 60 ? "60-69" : s.fit >= 50 ? "50-59" : "<50";
  dist[band] = (dist[band] || 0) + 1;
  // never clobber a real model score written by the loop while this runs
  const res = await jobs.updateOne(
    { _id: r._id, $or: [{ "llmScore.fit": { $exists: false } }, { "llmScore._meta.rubric": { $in: ["session-v1", "session-v2", "session-v3"] } }] },
    { $set: { llmScore: {
        fit: s.fit, family: s.family, verdict: s.verdict,
        reasons: [`${s.yrs == null ? "no stated years" : s.yrs + "y asked"}; stack ${s.own.slice(0,5).join("/") || "none shared"}`],
        matched: s.own.slice(0, 8), gaps: s.foreign.filter((f) => !s.own.length).slice(0, 4),
        _meta: { provider: "claude-code-session", rubric: "session-v3", at: new Date() },
      }, llmScoredAt: new Date(), scoredBy: "claude-code-session" } },
  );
  if (res.modifiedCount) n++;
}
console.log(`  scored ${n} of ${rows.length} (skipped any the loop scored first)`);
console.log(`  distribution: ${JSON.stringify(dist)}`);
await closeDb();
