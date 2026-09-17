/**
 * Continuous poller. This is the process that runs on the VPS.
 *
 *   node scripts/poll-loop.mjs                 # forever
 *   node scripts/poll-loop.mjs --minutes 10    # stop after 10 minutes
 *
 * It wakes every TICK_SECONDS, polls whatever is due, and sleeps. Tier cadence
 * lives on each company row, so nothing here needs to know about tiers.
 */

import "dotenv/config";
import { pollDue } from "../src/poller.js";
import { closeDb } from "../src/db.js";

const TICK_SECONDS = Number(process.env.TICK_SECONDS || 30);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const stopAfterMs = Number(arg("minutes", 0)) * 60_000;
const startedAt = Date.now();

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // second Ctrl-C is a hard exit
    stopping = true;
    console.log(`\n[loop] ${sig} — finishing current tick…`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

const totals = {
  ticks: 0,
  polls: 0,
  notModified: 0,
  inserted: 0,
  matches: 0,
  errors: 0,
};

async function tick() {
  const { polled, summary, results } = await pollDue({ limit: 500 });
  if (!polled) return;

  totals.ticks++;
  totals.polls += polled;
  totals.notModified += summary.not_modified || 0;
  totals.inserted += summary.inserted || 0;
  totals.matches += summary.screenedIn || 0;
  totals.errors += (summary.error || 0) + (summary.throw || 0);

  const changed = (summary.ok || 0) + (summary.burst || 0);
  console.log(
    `[${ts()}] polled ${String(polled).padStart(4)}  ` +
      `304:${String(summary.not_modified || 0).padStart(4)}  ` +
      `changed:${String(changed).padStart(3)}  ` +
      `new:${String(summary.inserted || 0).padStart(3)}  ` +
      `match:${String(summary.screenedIn || 0).padStart(3)}  ` +
      `err:${String((summary.error || 0) + (summary.throw || 0)).padStart(3)}`,
  );

  // Anything that clears the screen is worth printing immediately — this is
  // where the Telegram/Discord push will hook in.
  for (const r of results) {
    for (const j of r.newJobs || []) {
      const fam = (j.screen.roleFamily || "?").toUpperCase().padEnd(3);
      const phx = j.screen.location?.phoenix ? " 📍PHX" : "";
      console.log(`    → [${fam}] ${j.companyName} — ${j.title}${phx}`);
      console.log(`         ${j.applyUrl}`);
    }
  }

  for (const r of results) {
    if (r.outcome === "burst") {
      console.log(
        `    ⚡ BURST  ${r.company} — batch drop detected, now on 3m cadence for 24h`,
      );
    }
  }
}

console.log(
  `[loop] starting — tick every ${TICK_SECONDS}s${stopAfterMs ? `, stopping after ${stopAfterMs / 60000}m` : ""}`,
);

while (!stopping) {
  try {
    await tick();
  } catch (err) {
    console.error(`[${ts()}] tick failed:`, err?.message || err);
  }
  if (stopAfterMs && Date.now() - startedAt >= stopAfterMs) break;

  // Sleep in slices so Ctrl-C is responsive.
  for (let i = 0; i < TICK_SECONDS && !stopping; i++) await sleep(1000);
}

console.log(
  `\n[loop] stopped. ticks=${totals.ticks} polls=${totals.polls} ` +
    `304=${totals.notModified} new=${totals.inserted} matches=${totals.matches} errors=${totals.errors}`,
);
await closeDb();
process.exit(0);
