/**
 * Re-tailor and re-render every resume in the approved queue.
 *
 *   node scripts/regen-queue-resumes.mjs
 *
 * Needed after a bank or renderer change: the PDFs in out/ were generated with
 * whatever the rules were at the time, and a queued job carries a resumePath
 * pointing at one. Nothing else re-renders them, so a fix to the bullet shape
 * would otherwise only apply to jobs approved after it.
 *
 * Verifies the shape it produced rather than assuming, and refuses to write a
 * resume that fails the fabrication check.
 */
import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getDb, closeDb } from "../src/db.js";
import {
  loadBank,
  tailorForJob,
  verifyNoFabrication,
  selectionKey,
} from "../src/tailor.js";
import { renderPdf } from "../src/render-pdf.js";
import * as llm from "../src/llm.js";
import { MIN_EXPERIENCE_BULLETS, MIN_PROJECT_BULLETS } from "../src/render-pdf.js";

// A bounded first run matters once calls cost money: verify on a few, read the
// real usage numbers, then do the rest.
const limArg = process.argv.indexOf("--limit");
const LIMIT = limArg > -1 ? Number(process.argv[limArg + 1]) : Infinity;

const OUT = "out";
await mkdir(OUT, { recursive: true });

const db = await getDb();
const jobs = db.collection("jobs");
const bank = await loadBank();

const all = await jobs
  .find({ decision: "approved", submitStatus: "queued" })
  .sort({ "llmScore.fit": -1 })
  .toArray();
const queue = Number.isFinite(LIMIT) ? all.slice(0, LIMIT) : all;

console.log(
  `re-rendering ${queue.length} of ${all.length} queued resume(s)` +
    (queue.length < all.length ? `  [--limit ${LIMIT}]` : "") +
    `\nprovider: ${process.env.LLM_PROVIDER}/${process.env.LLM_MODEL}\n`,
);

let ok = 0;
let reused = 0;
const spend = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0 };
const bad = [];
for (const job of queue) {
  const tag = String(job.companyName || job.companyToken).slice(0, 18);
  try {
    // Reuse the stored selection when the posting, the bank and the prompt are
    // all unchanged. Re-rendering is free; re-selecting costs a model call.
    const key = selectionKey(job, bank);
    const cached =
      job.selectionKey === key && job.selection ? job.selection : null;
    if (cached) reused++;
    const t = await tailorForJob(job, bank, { cachedSelection: cached });
    const r = t.rendered ?? t;
    // Report degraded selection rather than hiding it behind a healthy-looking
    // shape. The renderer now guarantees 6/6/6 either way, so without this line a
    // resume tailored by a 7B fallback is indistinguishable from a good one.
    const sel = t.selection || {};
    const u = llm.lastAnthropicUsage;
    if (u && !cached) {
      spend.input += u.input;
      spend.cacheWrite += u.cacheWrite;
      spend.cacheRead += u.cacheRead;
      spend.output += u.output;
      spend.calls++;
    }
    const degraded = sel._meta?.fellBackFrom
      ? ` [selector fell back to ${sel._meta.model}: ${String(sel._meta.fallbackReason).slice(0, 40)}]`
      : "";
    const ids = (sel.bulletIds || []).length;
    const check = verifyNoFabrication(r, bank);
    if (!check.ok) {
      bad.push(`${tag}: fabrication check failed`);
      console.log(`  ✗ ${tag.padEnd(18)} FABRICATION — ${check.violations.length} violation(s), not written`);
      continue;
    }
    const safe = `${job.companyToken}-${job._id}`.replace(/[^a-z0-9-]/gi, "_");
    const pdfPath = join(OUT, `${safe}.pdf`);
    const pdf = await renderPdf(r, pdfPath);

    const thin =
      pdf.bulletsPerRole.some((n) => n < MIN_EXPERIENCE_BULLETS) ||
      pdf.bulletsPerProject.some((n) => n < MIN_PROJECT_BULLETS);
    console.log(
      `  ${thin ? "!" : "✓"} ${tag.padEnd(18)} ${pdf.pages}p @${String(pdf.density).padEnd(4)} ` +
        `roles=[${pdf.bulletsPerRole}] prj=[${pdf.bulletsPerProject}] ${String(ids).padStart(2)} ids` +
        `${thin ? "  ← THIN" : ""}${cached ? "  (cached, no LLM call)" : ""}${degraded}`,
    );
    if (thin) bad.push(`${tag}: thin (${pdf.bulletsPerRole})`);
    await jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          resumePath: pdfPath,
          resumeRenderedAt: new Date(),
          selection: t.selection,
          selectionKey: key,
        },
      },
    );
    if (!thin) ok++;
  } catch (e) {
    bad.push(`${tag}: ${e.message.slice(0, 60)}`);
    console.log(`  ✗ ${tag.padEnd(18)} ${String(e.message).slice(0, 60)}`);
  }
}

console.log(`\n${ok}/${queue.length} rendered at full shape`);
console.log(
  `${reused}/${queue.length} reused a cached selection — ${queue.length - reused} model call(s) made`,
);

if (spend.calls) {
  // Sonnet 5 introductory rates, per million tokens. Cache reads bill at a
  // tenth of the input rate; writes at 1.25x.
  const IN = 2 / 1e6,
    OUT_ = 10 / 1e6;
  const cost =
    spend.input * IN +
    spend.cacheWrite * IN * 1.25 +
    spend.cacheRead * IN * 0.1 +
    spend.output * OUT_;
  const hit = spend.cacheRead / Math.max(1, spend.cacheRead + spend.cacheWrite);
  console.log(`
tokens over ${spend.calls} call(s)
  uncached input   ${spend.input.toLocaleString().padStart(8)}
  cache WRITE      ${spend.cacheWrite.toLocaleString().padStart(8)}   (billed 1.25x)
  cache READ       ${spend.cacheRead.toLocaleString().padStart(8)}   (billed 0.1x)
  output           ${spend.output.toLocaleString().padStart(8)}
  cache hit rate   ${(hit * 100).toFixed(0).padStart(7)}%
  cost             $${cost.toFixed(4)}   ($${(cost / spend.calls).toFixed(4)}/resume)`);
  if (spend.cacheRead === 0)
    console.log("  ⚠ zero cache reads — the prefix is not being reused");
}
if (bad.length) {
  console.log("needs attention:");
  for (const b of bad) console.log(`  · ${b}`);
}
await closeDb();
