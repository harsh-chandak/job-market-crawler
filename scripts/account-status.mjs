/**
 * Which employers need you to sign in once, and which are already done.
 *
 *   node scripts/account-status.mjs
 *
 * Workday and Amazon have no anonymous application form: you need an account with
 * that employer before a form exists. Once you have signed in inside the
 * persistent browser profile, the session survives and every later run against
 * that employer can fill normally.
 *
 * That makes "have I signed in here yet" the thing worth tracking, and nothing was
 * tracking it. This checks each employer by loading its page in the real profile
 * and looking for a Sign In control, so the answer is observed rather than assumed.
 */
import "dotenv/config";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { getDb, closeDb } from "../src/db.js";

const PROFILE = ".browser-profile";
const GATED = ["workday", "amazon", "amazon-sde", "amazon-swe"];

const db = await getDb();
const jobs = db.collection("jobs");

const rows = await jobs
  .find(
    {
      ats: { $in: GATED },
      status: "new",
      $or: [
        { decision: "approved" },
        { decision: { $exists: false }, "llmScore.fit": { $gte: 70 } },
      ],
    },
    {
      projection: {
        ats: 1, companyToken: 1, companyName: 1, title: 1, applyUrl: 1,
        "llmScore.fit": 1, decision: 1, submitStatus: 1, resumePath: 1,
      },
    },
  )
  .toArray();

if (!rows.length) {
  console.log("no account-gated employers with live jobs right now.");
  await closeDb();
  process.exit(0);
}

// Group by employer — the account is per employer, not per job.
const byEmployer = new Map();
for (const r of rows) {
  const k = `${r.ats}:${r.companyToken}`;
  if (!byEmployer.has(k))
    byEmployer.set(k, {
      ats: r.ats,
      token: r.companyToken,
      name: r.companyName || r.companyToken,
      jobs: [],
      url: r.applyUrl,
    });
  const e = byEmployer.get(k);
  e.jobs.push(r);
  if ((r.llmScore?.fit ?? 0) > (e.bestFit ?? 0)) {
    e.bestFit = r.llmScore?.fit ?? 0;
    e.url = r.applyUrl;
  }
}

const employers = [...byEmployer.values()].sort((a, b) => (b.bestFit ?? 0) - (a.bestFit ?? 0));

console.log(`${employers.length} employer(s) need a signed-in session\n`);

if (!existsSync(PROFILE)) {
  console.log("  the browser profile does not exist yet — run step 3 once to create it\n");
}

const ctx = existsSync(PROFILE)
  ? await chromium.launchPersistentContext(PROFILE, { headless: true })
  : null;

console.log("  employer            jobs  best  resumes  session");
for (const e of employers) {
  let session = "not checked";
  if (ctx) {
    const p = await ctx.newPage();
    try {
      await p.goto(e.url, { waitUntil: "domcontentloaded", timeout: 35_000 });
      await p.waitForTimeout(3500);
      const signedOut = await p.evaluate(() =>
        /sign in|create account/i.test(document.body.innerText),
      );
      session = signedOut ? "SIGN IN NEEDED" : "signed in ✓";
    } catch {
      session = "unreachable";
    }
    await p.close();
  }
  const withResume = e.jobs.filter((j) => j.resumePath && existsSync(j.resumePath)).length;
  console.log(
    `  ${e.name.slice(0, 18).padEnd(20)}${String(e.jobs.length).padStart(4)}${String(e.bestFit ?? "?").padStart(6)}` +
      `${`${withResume}/${e.jobs.length}`.padStart(9)}   ${session}`,
  );
}
if (ctx) await ctx.close();

console.log(`
To unlock one: open its page in step 3's browser, create the account or sign in,
then close it. The session lives in ${PROFILE} and every later run reuses it.

  ${employers[0]?.url ?? ""}
`);
await closeDb();
