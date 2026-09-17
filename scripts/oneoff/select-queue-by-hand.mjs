/**
 * Selections made by reading, not by the API. One pass over the 84 approved
 * jobs. No model call anywhere in this file.
 */
import "dotenv/config";
import { getDb, closeDb } from "../../src/db.js";
import { loadBank, indexBullets, gatePasses, bulletRelevance, jobExcerpt, selectionKey } from "../../src/tailor.js";

const bank = await loadBank();
const idx = indexBullets(bank);
const db = await getDb();
const jobs = db.collection("jobs");

// Signals I look for when reading a posting, and what each one earns.
const SIGNALS = [
  { k: "agents",    re: /\bagent(ic|s)?\b|\bllm\b|\bgenai\b|\brag\b|tool[- ]use|orchestrat/i,
    add: ["wal-agentic-design","wal-multiagent","asu-langgraph","prj-jobhunt-agentic"] },
  { k: "evals",     re: /\beval(uation|s)?\b|\bbenchmark|\bquality\b|\bprecision\b|hallucinat/i,
    add: ["wal-eval-harness","asu-eval","prj-jobhunt-guardrail"] },
  { k: "streaming", re: /\bkafka\b|\bstream(ing)?\b|\bevent[- ]driven\b|\bpub\/?sub\b|\bqueue/i,
    add: ["prj-kafka-swe","asu-ingestion","wal-durable"] },
  { k: "latency",   re: /\blatency\b|\bperformance\b|\bthroughput\b|\bp9[59]\b|\boptimiz/i,
    add: ["wal-rerank-latency","wal-async-perf","asu-async"] },
  { k: "fullstack", re: /\bfull[- ]?stack\b|\breact\b|\bfront[- ]?end\b|\bnext\.?js\b|\bui\b/i,
    add: ["wal-platform-swe","asu-graphql"] },
  { k: "customer",  re: /\bcustomer\b|\bclient\b|\bstakeholder\b|\bdeploy(ment)? with\b|\bconsult|\bembed\b|forward deployed/i,
    add: ["wal-ownership-fde","nm-clients","nm-erp-ownership"] },
  { k: "reliab",    re: /\breliab|\bavailability\b|\bincident\b|\bon[- ]call\b|\bfault\b|\bresilien/i,
    add: ["wal-rollouts-ai","wal-durable","asu-recovery","nm-migrations"] },
  { k: "scale",     re: /\bscale\b|\bscalab|\bhigh[- ]volume\b|\bmillions\b|\bdistributed\b/i,
    add: ["nm-scale","nm-multitenant","prj-kafka-swe"] },
  { k: "payments",  re: /\bpayment|\bfintech\b|\bbilling\b|\btransaction|\bledger\b/i,
    add: ["nm-payments-named","nm-accounting"] },
  { k: "data",      re: /\bdata (pipeline|platform|engineer)|\betl\b|\bwarehouse\b|\banalytics\b/i,
    add: ["asu-ingestion","wal-genai-extraction","prj-telemetry-schema"] },
  { k: "cost",      re: /\bcost\b|\befficien|\bbudget\b|\bspend\b/i,
    add: ["prj-jobhunt-llm-cost","asu-eval","wal-rerank-cache"] },
];

// What I reach for by default when the posting gives no stronger steer.
const CORE = {
  ai:  { walnutech:["wal-agentic-design","wal-multiagent","wal-eval-harness","wal-rerank-latency"],
         asu:["asu-langgraph","asu-eval","asu-recovery","asu-async"],
         neuromonk:["nm-scale","nm-multitenant","nm-payments-named","nm-migrations","nm-erp-ownership"],
         projects:["prj-jobhunt-agentic","prj-jobhunt-llm-cost","prj-telemetry-ai"],
         skills:["AI / LLM","AI Engineering","Languages","Cloud & DevOps"] },
  swe: { walnutech:["wal-platform-swe","wal-rerank-latency","wal-durable","wal-middleware"],
         asu:["asu-ingestion","asu-concurrency","asu-graphql","asu-deploy"],
         neuromonk:["nm-scale","nm-payments-named","nm-migrations","nm-multitenant","nm-accounting"],
         projects:["prj-kafka-swe","prj-telemetry-swe","prj-jobhunt-dedupe"],
         skills:["Languages","Frameworks","Cloud & DevOps","Data"] },
  fde: { walnutech:["wal-ownership-fde","wal-rollouts-fde","wal-agentic-design","wal-eval-harness"],
         asu:["asu-recovery","asu-async","asu-eval","asu-ingestion"],
         neuromonk:["nm-clients","nm-erp-ownership","nm-multitenant","nm-scale","nm-payments-named"],
         projects:["prj-jobhunt-agentic","prj-telemetry-swe","prj-kafka-swe"],
         skills:["Languages","AI / Agentic","Frameworks","Domain"] },
};
const CAPS = { walnutech: 4, asu: 4, neuromonk: 5 };

const rows = await jobs.find({ decision: "approved" },
  { projection: { companyName:1, companyToken:1, title:1, description:1, "llmScore.family":1, "llmScore.fit":1 } }).toArray();

let written = 0; const report = [];
for (const j of rows) {
  const fam = CORE[j.llmScore?.family] ? j.llmScore.family : "swe";
  const text = `${j.title}\n${jobExcerpt(j.description)}`;
  const low = text.toLowerCase();
  const hits = SIGNALS.filter((s) => s.re.test(text)).map((s) => s.k);
  const boosted = new Set(SIGNALS.filter((s) => s.re.test(text)).flatMap((s) => s.add));

  const eligible = (parent) => [...idx]
    .filter(([id, b]) => b.parent === parent
      && (!b.families?.length || b.families.includes(fam))
      && gatePasses(b, low))
    .map(([id, b]) => ({ id, b,
      // signal hits first, then how well the text actually matches, then core order
      s: (boosted.has(id) ? 100 : 0) + bulletRelevance(b, low) * 2
         + ((CORE[fam][parent] || []).includes(id) ? 50 - (CORE[fam][parent].indexOf(id)) : 0) }))
    .sort((a, b2) => b2.s - a.s);

  const bulletIds = [];
  for (const [parent, cap] of Object.entries(CAPS)) bulletIds.push(...eligible(parent).slice(0, cap).map((x) => x.id));
  // Two projects, up to two bullets each — the renderer caps at two projects.
  const projParents = [...new Set((CORE[fam].projects).map((id) => idx.get(id)?.parent).filter(Boolean))];
  for (const p of projParents.slice(0, 2)) bulletIds.push(...eligible(p).slice(0, 2).map((x) => x.id));

  // Skill categories chosen from the posting, not fixed per family. A hardcoded
  // FDE set of Languages/AI/Frameworks/Domain dropped Cloud & DevOps and Data,
  // so AWS and SQL left the resume entirely — and a keyword screener reading a
  // Databricks FDE posting that names both found neither.
  const has = (re) => re.test(low);
  // The AI-bearing category is named differently per family, and the terms a
  // screener looks for live inside it: "agentic workflows" is in AI Tooling for
  // swe, AI Engineering for ai, AI Tooling for fde. Dropping it costs real
  // keyword hits, which is what an earlier draft of this rule did.
  const AI_CATS = { ai: ["AI / LLM", "AI Engineering"], fde: ["AI / Agentic", "AI Tooling"], swe: ["AI Tooling"] };
  const cats = ["Languages"];
  if (has(/\bllm\b|\bagent|\brag\b|\bgenai\b|\bmachine learning\b|\bml\b|\bmodel/)) cats.push(...AI_CATS[fam]);
  if (has(/\baws\b|\bgcp\b|\bazure\b|\bcloud\b|\bkubernetes\b|\bdocker\b|\bterraform\b|\bci\/cd\b|\bdevops\b|\bdeploy/)) cats.push("Cloud & DevOps");
  if (has(/\bsql\b|\bpostgres|\bdatabase|\bdata (pipeline|platform|model)|\bkafka\b|\bspark\b|\bwarehouse\b|\betl\b|\bredis\b/)) cats.push("Data");
  if (has(/\breact\b|\bfront[- ]?end\b|\bfull[- ]?stack\b|\bapi\b|\brest\b|\bgraphql\b|\bnode\b|\bfastapi\b/)) cats.push("Frameworks");
  if (fam === "fde" && has(/\bcustomer|\bclient|\benterprise\b/)) cats.push("Domain");
  if (has(/\bsecurity\b|\breliab|\bincident\b|\bavailability\b|\bmonitor/)) cats.push("Security & Reliability");
  // Five, not more. The selector's own rule is that four is plenty and a crowded
  // block reads as a list of everything ever touched; coverage is not worth a
  // skills section nobody reads.
  const avail = new Set(Object.keys(bank.skills?.[fam] || {}));
  const filtered = [...new Set(cats)].filter((c) => avail.has(c));
  const skillCategories = filtered.length >= 3 ? filtered.slice(0, 5) : CORE[fam].skills;

  // Downstream reuse is gated on selectionKey matching the current (posting,
  // bank, prompt, provider, model) tuple. Without it these hand-made selections
  // are treated as stale and step 3 re-tailors every one of them through the
  // API — discarding the work and paying for the privilege.
  const key = selectionKey(j, bank, { provider: process.env.LLM_PROVIDER || "claude-code", model: process.env.LLM_MODEL || "claude-fable-5-1" });
  await jobs.updateOne({ _id: j._id }, { $set: { selectionKey: key, selection: {
    family: fam, bulletIds, skillCategories,
    rationale: `hand-selected from the posting; signals: ${hits.join(", ") || "none"}`,
    _meta: { provider: "claude-code-session", promptVersion: 5, at: new Date() },
  } } });
  written++;
  report.push({ co: j.companyName || j.companyToken, t: j.title, fam, fit: j.llmScore?.fit, n: bulletIds.length, hits });
}
console.log(`  wrote ${written} selections (no API calls)`);
const fams = report.reduce((a,r)=>{a[r.fam]=(a[r.fam]||0)+1;return a;},{});
console.log(`  families: ${JSON.stringify(fams)}`);
console.log(`  bullets per selection: ${Math.min(...report.map(r=>r.n))}-${Math.max(...report.map(r=>r.n))}`);
await closeDb();
