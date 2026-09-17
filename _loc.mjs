import "dotenv/config";
import { getDb, closeDb } from "./src/db.js";

// A posting that lists several cities is reachable if ANY of them works, so
// bucket by the best option rather than the first string.
const bucket = (locs) => {
  const s = (locs || []).join(" ; ").toLowerCase();
  if (!s.trim()) return "unstated";
  if (/\bremote\b|work from home|anywhere/.test(s)) return "remote";
  if (/phoenix|tempe|scottsdale|chandler|mesa|arizona|\baz\b/.test(s)) return "phoenix/AZ";
  if (/san francisco|bay area|sunnyvale|mountain view|palo alto|menlo park|san jose|santa clara|cupertino|redwood|oakland|\bsf\b/.test(s)) return "bay area";
  if (/new york|\bnyc\b|brooklyn|manhattan|\bny\b/.test(s)) return "NYC";
  if (/seattle|bellevue|redmond|kirkland|\bwa\b/.test(s)) return "seattle";
  if (/austin|dallas|houston|texas|\btx\b/.test(s)) return "texas";
  if (/boston|cambridge|\bma\b/.test(s)) return "boston";
  if (/los angeles|san diego|irvine|santa monica|rancho|sacramento|california|\bca\b/.test(s)) return "other CA";
  return "other US";
};

const db = await getDb();
const rows = await db.collection("jobs").find(
  { submitStatus: "submitted" },
  { projection: { locations: 1, companyName: 1, companyToken: 1, title: 1, reply: 1, submitAttemptAt: 1, "llmScore.fit": 1 } },
).toArray();

const t = {};
for (const r of rows) {
  const b = bucket(r.locations);
  const e = (t[b] ??= { sent: 0, rejected: 0, answered: 0, ripe: 0 });
  e.sent++;
  if (r.reply?.state) e.answered++;
  if (r.reply?.state === "rejected") e.rejected++;
  const days = r.submitAttemptAt ? (Date.now() - new Date(r.submitAttemptAt)) / 864e5 : 0;
  if (days >= 7) e.ripe++;
}

console.log(`\n  ${rows.length} applications by location reachable from Phoenix\n`);
console.log(`  ${"bucket".padEnd(13)}${"sent".padStart(5)}${"  %".padStart(6)}${"7d+".padStart(6)}${"answered".padStart(10)}${"rejected".padStart(10)}`);
for (const [k, v] of Object.entries(t).sort((a, b) => b[1].sent - a[1].sent)) {
  console.log(
    `  ${k.padEnd(13)}${String(v.sent).padStart(5)}${(Math.round((v.sent / rows.length) * 100) + "%").padStart(6)}` +
    `${String(v.ripe).padStart(6)}${String(v.answered).padStart(10)}${String(v.rejected).padStart(10)}`,
  );
}

const local = rows.filter((r) => ["remote", "phoenix/AZ"].includes(bucket(r.locations)));
console.log(`\n  reachable without relocating (remote or AZ): ${local.length} of ${rows.length} — ${Math.round((local.length / rows.length) * 100)}%`);
console.log(`  requires relocating:                         ${rows.length - local.length} — ${Math.round(((rows.length - local.length) / rows.length) * 100)}%`);
await closeDb();
