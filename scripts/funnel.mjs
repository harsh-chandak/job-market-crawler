/**
 * The application funnel, split by whether a person was attached.
 *
 *   node scripts/funnel.mjs [--days 90]
 *
 * warm     referred, already talking with someone there, or messaged someone before applying
 * rescued  messaged someone there only after applying
 * cold     nobody
 *
 * If cold applications do not turn into interviews, more cold applications
 * are not the answer; that is the question this report exists to answer.
 * Funnel doctrine adapted from JobFinderOS (MIT, (c) 2026 Matthew Price),
 * recruiter_playbook.md sections 5 and 9.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import {
  addDays,
  attachedAtApply,
  jobCompanyKeys,
  WARM_TARGET,
} from "../src/warm-path.js";
import { objectionPatterns, CLASSES } from "../src/postmortem.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const days = Number(arg("days", 0));
const now = new Date();
const db = await getDb();
const jobs = db.collection("jobs");
const contacts = await db.collection("contacts").find({}).toArray();
const byKey = new Map();
for (const c of contacts) {
  if (!byKey.has(c.companyKey)) byKey.set(c.companyKey, []);
  byKey.get(c.companyKey).push(c);
}

const sent = await jobs
  .find(
    {
      submitStatus: "submitted",
      ...(days ? { submitAttemptAt: { $gte: addDays(now, -days) } } : {}),
    },
    {
      projection: {
        companyName: 1,
        companyToken: 1,
        companyNorm: 1,
        title: 1,
        ats: 1,
        submitAttemptAt: 1,
        reply: 1,
        outcome: 1,
        outcomeAt: 1,
        outcomeDateKnown: 1,
        referral: 1,
        warmPath: 1,
        postmortem: 1,
      },
    },
  )
  .toArray();

const GROUP = {
  referral: "warm",
  warm_active: "warm",
  contacted_before: "warm",
  contacted_after: "rescued",
  cold: "cold",
};
const MOVING = ["interview", "assessment", "offer"];
const rows = sent.map((j) => {
  const attached = attachedAtApply(
    j,
    jobCompanyKeys(j).flatMap((k) => byKey.get(k) || []),
  );
  const st = j.reply?.state;
  const moving = MOVING.includes(st) || MOVING.includes(j.outcome);
  const offer = st === "offer" || j.outcome === "offer";
  const rejected = !moving && (st === "rejected" || j.outcome === "rejected");
  const age = Math.floor((now - new Date(j.submitAttemptAt)) / 864e5);
  const silent = !moving && !rejected && (st === "ghosted" || age >= 21);
  return {
    j,
    group: GROUP[attached],
    moving,
    offer,
    rejected,
    silent,
    waiting: !moving && !rejected && !silent,
  };
});

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const tally = (list) => ({
  sent: list.length,
  moving: list.filter((r) => r.moving).length,
  offer: list.filter((r) => r.offer).length,
  rejected: list.filter((r) => r.rejected).length,
  silent: list.filter((r) => r.silent).length,
  waiting: list.filter((r) => r.waiting).length,
});
const line = (label, t) =>
  `  ${label.padEnd(12)} ${String(t.sent).padStart(5)} ${`${t.moving} (${pct(t.moving, t.sent)})`.padStart(12)} ${String(t.offer).padStart(6)} ` +
  `${`${t.rejected} (${pct(t.rejected, t.sent)})`.padStart(12)} ${`${t.silent} (${pct(t.silent, t.sent)})`.padStart(13)} ${String(t.waiting).padStart(8)}`;

console.log(
  `\nFUNNEL${days ? `, last ${days} days` : ""}: ${sent.length} applications sent`,
);
console.log(
  `  ${"".padEnd(12)} ${"sent".padStart(5)} ${"interview+".padStart(12)} ${"offer".padStart(6)} ${"rejected".padStart(12)} ${"silent 21d+".padStart(13)} ${"waiting".padStart(8)}`,
);
for (const g of ["warm", "rescued", "cold"])
  line && console.log(line(g, tally(rows.filter((r) => r.group === g))));
console.log(line("all", tally(rows)));
const warm = rows.filter((r) => r.group === "warm").length;
console.log(
  `\n  a person attached before applying: ${warm}/${sent.length} (${pct(warm, sent.length)}); target ${Math.round(WARM_TARGET * 100)}%`,
);

console.log(`\nBY APPLICATION SYSTEM`);
const byAts = {};
for (const r of rows) (byAts[r.j.ats || "?"] ??= []).push(r);
for (const [a, list] of Object.entries(byAts).sort(
  (x, y) => y[1].length - x[1].length,
)) {
  const t = tally(list);
  console.log(
    `  ${a.padEnd(16)} ${String(t.sent).padStart(4)} sent · rejected ${pct(t.rejected, t.sent).padStart(4)} · silent ${pct(t.silent, t.sent).padStart(4)} · interview+ ${t.moving}`,
  );
}

const dated = rows
  .filter(
    (r) =>
      r.rejected &&
      r.j.outcome === "rejected" &&
      r.j.outcomeDateKnown &&
      r.j.outcomeAt,
  )
  .map((r) =>
    Math.max(
      0,
      Math.round(
        (new Date(r.j.outcomeAt) - new Date(r.j.submitAttemptAt)) / 864e5,
      ),
    ),
  );
if (dated.length) {
  const b = { "0-2 days": 0, "3-7 days": 0, "8-21 days": 0, "22+ days": 0 };
  for (const x of dated)
    b[
      x <= 2
        ? "0-2 days"
        : x <= 7
          ? "3-7 days"
          : x <= 21
            ? "8-21 days"
            : "22+ days"
    ]++;
  console.log(
    `\nTIME TO REJECTION (${dated.length} with the email's own date)`,
  );
  for (const [k, n] of Object.entries(b))
    console.log(
      `  ${k.padEnd(10)} ${String(n).padStart(4)}  ${"█".repeat(Math.round((40 * n) / dated.length))}`,
    );
  console.log(
    `  Within 2 days usually means an automated screen or a knockout question, not a person reading the resume.`,
  );
}

const pms = rows.filter((r) => r.j.postmortem).map((r) => r.j.postmortem);
const unanalysed = rows.filter((r) => r.rejected && !r.j.postmortem).length;
const { byClass, patterns, unknownOrLow } = objectionPatterns(pms);
console.log(
  `\nOBJECTION LOG: ${pms.length} analysed${unanalysed ? `, ${unanalysed} rejection(s) not yet (node scripts/postmortem.mjs)` : ""}`,
);
for (const c of CLASSES)
  if (byClass[c]) console.log(`  ${c.padEnd(22)} ${byClass[c]}`);
if (unknownOrLow)
  console.log(`  ${"unknown or low confidence".padEnd(22)} ${unknownOrLow}`);
for (const p of patterns) {
  console.log(
    `\n  ⚠ ${p.n} × ${p.class}: three of a kind is a positioning problem, not luck`,
  );
  const fixes = [
    ...new Set(
      pms
        .filter((x) => x.class === p.class && x.confidence !== "low")
        .map((x) => x.fix)
        .filter(Boolean),
    ),
  ];
  for (const f of fixes.slice(0, 3)) console.log(`    fix: ${f}`);
}
await closeDb();
