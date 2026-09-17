/** Employer-reply classification. No network, no DB. node scripts/test-status-email.mjs */
import { classifyStatusEmail, senderCompany, mailRole, mailText } from "../src/adapters/status-email.js";

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = "") => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`)));
const st = (subject, from, body) => classifyStatusEmail({ subject, from, body }).status;

/* ---- the five outcomes ---- */
ok("rejection", st("x", "a@b.com", "Unfortunately we will not be moving forward.") === "rejected");
ok("rejection: filled", st("x", "a@b.com", "The position has been filled.") === "rejected");
ok("rejection: other candidates", st("x", "a@b.com", "We decided to move forward with other candidates.") === "rejected");
ok("offer", st("x", "a@b.com", "We are pleased to offer you the position.") === "offer");
ok("interview", st("x", "a@b.com", "We would like to schedule a call.") === "interview");
ok("assessment", st("x", "a@b.com", "Please complete the online assessment.") === "assessment");
ok("acknowledgement", st("x", "a@b.com", "We have received your application.") === "acknowledged");
ok("unrelated mail is not guessed", st("Sale", "a@b.com", "50% off shoes today") === null);

/* ---- order matters: a rejection wrapped in kind words is a rejection ---- */
ok("soft rejection still rejects",
  st("x", "a@b.com", "Thank you for applying. Unfortunately we will not be moving forward, but we will keep your resume on file.") === "rejected");
ok("rejection beats acknowledgement",
  st("x", "a@b.com", "We have received your application. Unfortunately we regret to inform you.") === "rejected");

/* ---- sender: the display name beats the ATS domain ---- */
ok("display name wins over greenhouse",
  senderCompany({ from: '"Stripe Careers" <no-reply@greenhouse.io>' }) === "Stripe");
ok("noise words stripped",
  senderCompany({ from: '"Notion Recruiting Team" <talent@notion.so>' }) === "Notion");
ok("own domain used when not an ATS",
  senderCompany({ from: "careers@plaid.com" }).toLowerCase() === "plaid");
ok("ats domain not treated as employer",
  senderCompany({ from: "no-reply@greenhouse.io", subject: "Your application to Acme" }) === "Acme");

/* ---- role extraction ---- */
ok("full title with a comma survives",
  mailRole({ subject: "", text: "your application for the Software Engineer, Full Stack position" })
    === "Software Engineer, Full Stack");
ok("role noun required",
  mailRole({ subject: "Your application to Plaid", text: "application to Plaid Hi Harsh, thanks" }) === "");
ok("role of X form", mailRole({ subject: "", text: "the position of Backend Developer." }) === "Backend Developer");
ok("no role is empty, not a guess", mailRole({ subject: "Update", text: "Thanks for applying." }) === "");

/* ---- html stripped before phrase rules run ---- */
ok("html rejected mail still classifies",
  st("x", "a@b.com", "<div><p>Unfortunately</p><p>we will not be moving forward.</p></div>") === "rejected");
ok("script contents ignored", !mailText("<script>var unfortunately=1</script>hello").includes("unfortunately"));

/* ---- nothing throws on junk ---- */
ok("empty input safe", classifyStatusEmail({}).status === null);
ok("undefined input safe", classifyStatusEmail().status === null);

console.log(failures.map((f) => `  FAIL ${f}`).join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? "  FAILURES" : "  all green");
process.exit(fail ? 1 : 0);
