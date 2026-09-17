/**
 * Check the things that stop a run before it starts, and say what to do.
 *
 *   node scripts/preflight.mjs        exits 0 if good, 1 if not
 *
 * Exists because the .command launchers are double-clicked by a human, and the
 * raw driver failure for the most common problem — a changed IP against the
 * Atlas Access List — is a 200-line stack dump whose one actionable line is
 * buried and whose signature (a TLS alert) points at the wrong cause.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { getDb, closeDb } from "../src/db.js";

const fail = (msg) => {
  console.log(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

if (!existsSync(".env")) fail(".env is missing. Copy .env.example and fill it in.");
const REQUIRED = process.argv.includes("--skip-telegram")
  ? ["MONGODB_URI"]
  : ["MONGODB_URI", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
for (const k of REQUIRED)
  if (!process.env[k]) fail(`${k} is not set in .env`);

// Report the current public IP up front: when Atlas rejects the connection this
// is the value that has to go in the Access List, and looking it up afterwards
// is an extra step at the worst moment.
let ip = null;
let telegramBlocked = false;
try {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  ip = (await (await fetch("https://api.ipify.org", { signal: c.signal })).text()).trim();
  clearTimeout(t);
} catch {}

// Telegram is only checked when the caller actually needs it. The submit steps
// read approvals out of the database and never touch the API, so warning them
// about a blocked network would be noise — and worse, an earlier version made
// them abort on it, refusing to prepare applications over a channel they do not
// use.
const skipTelegram =
  process.argv.includes("--skip-telegram") ||
  !process.env.TELEGRAM_BOT_TOKEN;

// Checked because the failure is silent and misread:
// the loop polls happily, finds matches, and the only symptom is "notify
// failed: timeout" thirty seconds in — while the user concludes the buttons are
// broken. ASU campus wifi blocks TCP 443 to api.telegram.org outright (DNS
// resolves; the connection is dropped), and locked-down networks commonly do.
if (!skipTelegram) try {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`,
    { signal: c.signal },
  );
  clearTimeout(t);
  const body = await res.json();
  if (!body.ok) fail(`Telegram rejected the bot token: ${body.description || res.status}`);
  console.log(`  ✓ telegram reachable — bot @${body.result.username}`);
} catch {
  console.log("\n  ✗ Cannot reach api.telegram.org.");
  console.log("");
  console.log("  This network blocks Telegram. DNS resolves but the connection to");
  console.log("  port 443 is dropped, which is normal on locked-down campus and");
  console.log("  corporate wifi. Nothing is wrong with the bot or the token.");
  console.log("");
  console.log("  Consequence: cards cannot be sent and button presses cannot be");
  console.log("  read. Presses you already made are NOT lost — Telegram queues");
  console.log("  them for 24 hours and the loop will pick them up as soon as it");
  console.log("  can reach the API again.");
  console.log("");
  console.log("  Fix: switch to a network that allows Telegram — home wifi or");
  console.log("  your phone's hotspot. Polling and scoring work fine here, so if");
  console.log("  you want to keep collecting jobs on campus, run it anyway and");
  console.log("  reconnect later to receive the cards.");
  console.log("");
  // Not a hard failure: the caller decides. Polling and scoring are unaffected,
  // and detection latency is the thing that cannot be recovered later, so a
  // Telegram block is a reason to warn rather than a reason to refuse to run.
  telegramBlocked = true;
}

try {
  const db = await getDb();
  const n = await db.collection("jobs").estimatedDocumentCount();
  console.log(`  ✓ database reachable${ip ? ` from ${ip}` : ""} — ${n.toLocaleString()} jobs`);
  // Claude: the loop only calls it from the scoring stage, so without this line
  // nothing at startup says whether it can. A warning, not a stop: polling and
  // screening work without it.
  try {
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const st = JSON.parse(execFileSync(process.env.CLAUDE_CODE_BIN || "claude", ["auth", "status"], { env, timeout: 15_000 }).toString());
    const model = process.env.LLM_MODEL || "claude-fable-5-1";
    if (st.loggedIn)
      console.log(`  ✓ claude connected — ${st.authMethod === "claude.ai" ? `${st.subscriptionType || "claude.ai"} plan` : st.authMethod}, scoring on ${model}`);
    else console.log("  ⚠ claude is not logged in — scoring waits until you run: claude auth login");
  } catch {
    console.log("  ⚠ claude CLI not found or not responding — scoring cannot run until it is");
  }
  await closeDb();
  if (telegramBlocked) {
    console.log(
      "  ! continuing without Telegram — jobs will still be collected and scored\n",
    );
    // Exit 2, not 0: everything required is present, but the approval channel is
    // gone. The caller needs to know that specifically so it can stand up the
    // local review page instead of leaving the one manual step unreachable.
    process.exit(2);
  }
} catch (err) {
  console.log(`\n  ✗ ${err.message}`);
  if (ip) console.log(`  The IP to add is:  ${ip}\n`);
  process.exit(1);
}
