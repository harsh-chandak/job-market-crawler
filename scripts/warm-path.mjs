/**
 * Warm path: find and track the people who can carry an application.
 *
 *   node scripts/warm-path.mjs list [--min 70] [--limit 25]
 *   node scripts/warm-path.mjs show <job id | company>
 *   node scripts/warm-path.mjs record <job id> <file.json | ->
 *   node scripts/warm-path.mjs add <company> "<Full Name>" --rung recruiter [--title ..] [--linkedin ..] [--source ..] [--route ..]
 *   node scripts/warm-path.mjs touch <company> "<Full Name>" --kind outreach|bump|reply|call|referral|declined|park [--note ..]
 *   node scripts/warm-path.mjs referral <job id> --by "<Name>" [--note ..]
 *   node scripts/warm-path.mjs import-linkedin <Connections.csv>
 *   node scripts/warm-path.mjs caps
 *   node scripts/warm-path.mjs audit
 *
 * The finding happens in the warm-path skill, in an interactive Claude session;
 * this script records and enforces. It never sends anything and never reads
 * LinkedIn: connections come from LinkedIn's own data export.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { getDb, closeDb } from "../src/db.js";
import { loadBank } from "../src/tailor.js";
import { findJobs } from "../src/job-lookup.js";
import {
  CAPS,
  RUNGS,
  TOUCH_KINDS,
  WARM_TARGET,
  startOfDay,
  addDays,
  companyKey,
  jobCompanyKeys,
  nameNorm,
  ladderTerms,
  searchLinks,
  validateRecord,
  planDates,
  capsStatus,
  applyTouch,
  attachedAtApply,
  parseLinkedInConnections,
} from "../src/warm-path.js";

const VALUE_FLAGS = new Set([
  "min",
  "limit",
  "kind",
  "note",
  "rung",
  "title",
  "linkedin",
  "source",
  "route",
  "by",
]);
const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    opts[k] = VALUE_FLAGS.has(k) ? argv[++i] : true;
  } else args.push(a);
}

const USAGE = `warm path: people who can carry an application
  list [--min 70]                        jobs worth a person, and where the caps stand
  show <job id | company>                the job, people known there, search links, caps
  record <job id> <file.json | ->        the verdict and the people found
  add <company> "<Full Name>" --rung ${RUNGS.join("|")} [--title] [--linkedin] [--source] [--route]
  touch <company> "<Full Name>" --kind ${TOUCH_KINDS.join("|")} [--note]
  referral <job id> --by "<Name>"        a referral that was actually submitted
  import-linkedin <Connections.csv>      your LinkedIn data export
  caps                                   caps, open threads, follow-ups due
  audit                                  share of applications with a person attached`;

if (!cmd || cmd === "help" || opts.help) {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}

const db = await getDb();
const jobs = db.collection("jobs");
const contacts = db.collection("contacts");
const now = new Date();
const d = (x) => {
  if (!x) return "—";
  const t = new Date(x);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
async function fail(msg) {
  console.error(`  ✗ ${msg}`);
  await closeDb();
  process.exit(1);
}
async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}
const allContacts = () => contacts.find({}).toArray();
const atCompany = (list, job) => {
  const keys = new Set(jobCompanyKeys(job));
  return list.filter((c) => keys.has(c.companyKey));
};
const coName = (j) => j.companyName || j.companyToken;
const ageDays = (x) => Math.floor((now - new Date(x)) / 864e5);
const LIVE = {
  status: "new",
  decision: { $ne: "skipped" },
  submitStatus: { $ne: "submitted" },
};
const RESCUABLE = {
  submitStatus: "submitted",
  "reply.state": { $exists: false },
  outcome: { $ne: "rejected" },
  submitAttemptAt: { $gte: addDays(now, -21) },
};
const PROJ = {
  companyName: 1,
  companyToken: 1,
  companyNorm: 1,
  title: 1,
  applyUrl: 1,
  locations: 1,
  "llmScore.fit": 1,
  submitStatus: 1,
  submitAttemptAt: 1,
  warmPath: 1,
  referral: 1,
  reply: 1,
  outcome: 1,
  decision: 1,
  status: 1,
};

function verdictLabel(j) {
  if (j.referral)
    return `referred${j.referral.by ? ` by ${j.referral.by}` : ""}`;
  if (!j.warmPath) return "not checked";
  const people = j.warmPath.people || [];
  return `${j.warmPath.verdict.replace("_", " ")}${people.length ? ` (${people.map((p) => p.name).join(", ")})` : ""}`;
}
function printCaps(c, companyLabel = null) {
  const later =
    c.nextAllowed > startOfDay(now)
      ? ` · next new person allowed ${d(c.nextAllowed)}`
      : "";
  console.log(
    `  new people messaged: ${c.newToday}/${c.perDay} today · ${c.newThisWeek}/${c.perWeek} this week${later}`,
  );
  if (companyLabel && c.blockedByThread)
    console.log(
      `  ⚠ open thread at ${companyLabel}: ${c.blockedByThread.name}, last message ${d(c.blockedByThread.lastTouchAt)}. ` +
        `One unanswered thread per company: no second person until they answer or ${d(addDays(c.blockedByThread.lastTouchAt, CAPS.parkDays))}.`,
    );
}
function printPlan(plan) {
  const rows = [
    ["outreachOn", "reach out"],
    ["applyAfter", "apply after"],
    ["applyBy", "apply by"],
    ["bumpOn", "one follow-up if silent"],
    ["recheckOn", "look again"],
  ];
  for (const [k, label] of rows)
    if (plan[k]) console.log(`    ${label.padEnd(24)} ${d(plan[k])}`);
  console.log(`    ${plan.note}`);
}
async function upsertContact(company, p, jobId = null) {
  const key = companyKey(company);
  const set = { name: p.name, company, companyKey: key, updatedAt: now };
  for (const f of ["title", "linkedin", "source", "route"])
    if (p[f]) set[f] = p[f];
  if (p.rung) set.rung = p.rung;
  const update = {
    $set: set,
    $setOnInsert: {
      status: "not_contacted",
      touches: [],
      origin: "warm-path",
      createdAt: now,
    },
  };
  if (jobId) update.$addToSet = { jobIds: jobId };
  const r = await contacts.findOneAndUpdate(
    { nameNorm: nameNorm(p.name), companyKey: key },
    update,
    {
      upsert: true,
      returnDocument: "after",
    },
  );
  return r?.value ?? r;
}

if (cmd === "list") {
  const min = Number(opts.min ?? 70);
  const limit = Number(opts.limit ?? 25);
  const all = await allContacts();
  const pending = await jobs
    .find({ ...LIVE, "llmScore.fit": { $gte: min } }, { projection: PROJ })
    .sort({ "llmScore.fit": -1, firstSeenAt: -1 })
    .limit(limit)
    .toArray();
  const sent = await jobs
    .find({ ...RESCUABLE, "llmScore.fit": { $gte: min } }, { projection: PROJ })
    .sort({ "llmScore.fit": -1, submitAttemptAt: -1 })
    .limit(limit)
    .toArray();
  const row = (j, extra = "") => {
    const n = atCompany(all, j).length;
    return (
      `  ${String(j._id)}  ${String(j.llmScore?.fit ?? "?").padStart(3)}  ${coName(j).slice(0, 20).padEnd(20)} ` +
      `${j.title.slice(0, 44).padEnd(44)} ${extra}${verdictLabel(j)}${n ? ` · ${n} known there` : ""}`
    );
  };
  console.log(`\nNOT APPLIED YET, fit ${min}+ (${pending.length})`);
  for (const j of pending) console.log(row(j));
  if (!pending.length) console.log("  none");
  console.log(
    `\nAPPLIED UNDER 21 DAYS AGO, NO REPLY, fit ${min}+ (${sent.length}): a person can still pull these out of the pile`,
  );
  for (const j of sent)
    console.log(row(j, `applied ${ageDays(j.submitAttemptAt)}d ago · `));
  if (!sent.length) console.log("  none");
  console.log("");
  printCaps(capsStatus(all, now));
  console.log(
    `\n  next: node scripts/warm-path.mjs show <id>   (or /warm-path <company> in Claude Code)`,
  );
} else if (cmd === "show") {
  if (!args.length) await fail("show needs a job id or a company name");
  const found = await findJobs(jobs, args.join(" "), { limit: 6 });
  if (!found.length) await fail(`no job matches "${args.join(" ")}"`);
  const bank = await loadBank();
  const all = await allContacts();
  const j0 = found[0];
  const company = coName(j0);
  console.log(`\nJOBS AT ${company}`);
  for (const j of found) {
    const state =
      j.submitStatus === "submitted"
        ? `applied ${d(j.submitAttemptAt)}${j.reply?.state ? ` · ${j.reply.state}` : j.outcome ? ` · ${j.outcome}` : " · no reply"}`
        : j.decision === "skipped"
          ? "skipped"
          : j.status;
    console.log(
      `  ${String(j._id)}  fit ${j.llmScore?.fit ?? "?"}  ${j.title}  [${state}]`,
    );
    if (j.applyUrl) console.log(`    ${j.applyUrl}`);
    console.log(
      `    warm path: ${verdictLabel(j)}${j.warmPath?.recordedAt ? ` (checked ${d(j.warmPath.recordedAt)})` : ""}`,
    );
    if (j.warmPath?.plan) printPlan(j.warmPath.plan);
  }
  const people = atCompany(all, j0);
  console.log(`\nPEOPLE ALREADY KNOWN AT ${company} (${people.length})`);
  for (const p of people)
    console.log(
      `  ${p.name}${p.title ? ` · ${p.title}` : ""} · ${p.rung || "?"} · ${p.status}` +
        `${p.lastTouchAt ? ` · last message ${d(p.lastTouchAt)}` : ""}${p.nextTouchAt ? ` · next ${d(p.nextTouchAt)}` : ""}` +
        `${p.linkedin ? `\n    ${p.linkedin}` : ""}`,
    );
  if (!people.length)
    console.log(
      "  none yet (import your LinkedIn connections to fill this: import-linkedin)",
    );
  console.log(
    `\nLADDER SEARCHES: open these yourself; nothing here reads LinkedIn`,
  );
  for (const l of searchLinks(company, ladderTerms(bank)))
    console.log(`  ${l.rung.padEnd(9)} ${l.label}\n            ${l.url}`);
  console.log(`\nCAPS`);
  printCaps(capsStatus(all, now, jobCompanyKeys(j0)), company);
} else if (cmd === "record") {
  const [id, file] = args;
  if (!/^[a-f0-9]{24}$/i.test(id || "") || !file)
    await fail("record needs <job id (24 hex)> <file.json | ->");
  const job = (await findJobs(jobs, id))[0];
  if (!job) await fail(`no job ${id}`);
  let input;
  try {
    input = JSON.parse(
      file === "-" ? await readStdin() : await readFile(file, "utf8"),
    );
  } catch (e) {
    await fail(`could not read JSON: ${e.message}`);
  }
  const v = validateRecord(input);
  if (!v.ok) await fail(`record refused:\n    ${v.errors.join("\n    ")}`);
  const company = coName(job);
  const people = [];
  for (const p of v.record.people) {
    const c = await upsertContact(company, p, job._id);
    people.push({
      contactId: c._id,
      name: p.name,
      rung: p.rung,
      title: p.title,
    });
  }
  const caps = capsStatus(await allContacts(), now, jobCompanyKeys(job));
  const plan = planDates(v.record.verdict, now, {
    nextAllowed: caps.nextAllowed,
    closingWindow: v.record.closingWindow,
    applied: job.submitStatus === "submitted",
  });
  await jobs.updateOne(
    { _id: job._id },
    { $set: { warmPath: { ...v.record, people, plan, recordedAt: now } } },
  );
  console.log(
    `  recorded: ${company} — ${job.title}: ${v.record.verdict.replace("_", " ")}`,
  );
  for (const p of people)
    console.log(`    ${p.name}${p.title ? `, ${p.title}` : ""} (${p.rung})`);
  printPlan(plan);
  printCaps(caps, company);
  if (v.record.verdict !== "cold")
    console.log(
      `\n  Drafts are written only when you ask, and you send them yourself. After sending:\n` +
        `    node scripts/warm-path.mjs touch "${company}" "<Full Name>" --kind outreach`,
    );
} else if (cmd === "add") {
  const [company, name] = args;
  if (!company || !name || !opts.rung)
    await fail(`add needs <company> "<Full Name>" --rung ${RUNGS.join("|")}`);
  const v = validateRecord({
    verdict: "cold",
    people: [
      {
        name,
        rung: opts.rung,
        title: opts.title,
        linkedin: opts.linkedin,
        source: opts.source,
        route: opts.route,
      },
    ],
  });
  if (!v.ok) await fail(v.errors.join("; "));
  const c = await upsertContact(company, v.record.people[0]);
  console.log(
    `  saved ${c.name} at ${company} (${c.rung}), status ${c.status}`,
  );
} else if (cmd === "touch") {
  const [company, name] = args;
  if (!company || !name || !opts.kind)
    await fail(
      `touch needs <company> "<Full Name>" --kind ${TOUCH_KINDS.join("|")}`,
    );
  const key = companyKey(company);
  const c = await contacts.findOne({
    nameNorm: nameNorm(name),
    companyKey: key,
  });
  if (!c) {
    const there = await contacts
      .find({ companyKey: key })
      .project({ name: 1 })
      .toArray();
    await fail(
      `no "${name}" saved at ${company}.${there.length ? ` Saved there: ${there.map((x) => x.name).join(", ")}.` : ""} ` +
        `Save them first with add or record.`,
    );
  }
  const before = capsStatus(await allContacts(), now, [key]);
  let upd;
  try {
    upd = applyTouch(c, opts.kind, now, opts.note || null);
  } catch (e) {
    await fail(e.message);
  }
  if (opts.kind === "outreach" && !c.firstTouchAt) {
    if (before.newToday >= CAPS.newPerDay)
      upd.warnings.push(
        `this is new person ${before.newToday + 1} today; the limit is ${CAPS.newPerDay}`,
      );
    if (before.newThisWeek >= CAPS.newPerWeek)
      upd.warnings.push(
        `this is new person ${before.newThisWeek + 1} this week; the limit is ${CAPS.newPerWeek}`,
      );
    const other = before.openThreads.find(
      (t) => String(t._id) !== String(c._id),
    );
    if (other)
      upd.warnings.push(
        `${other.name} at ${company} has not answered yet (last message ${d(other.lastTouchAt)}); one open thread per company`,
      );
  }
  const { warnings, ...fields } = upd;
  await contacts.updateOne(
    { _id: c._id },
    { $set: { ...fields, updatedAt: now } },
  );
  if (opts.kind === "referral" && c.jobIds?.length)
    await jobs.updateMany(
      { _id: { $in: c.jobIds }, referral: { $exists: false } },
      { $set: { referral: { by: c.name, at: now, note: opts.note || null } } },
    );
  console.log(
    `  ${c.name} at ${company}: ${opts.kind} recorded · status ${fields.status}${fields.nextTouchAt ? ` · next ${d(fields.nextTouchAt)}` : ""}`,
  );
  for (const w of warnings) console.log(`  ⚠ ${w}`);
} else if (cmd === "referral") {
  const id = args[0];
  if (!/^[a-f0-9]{24}$/i.test(id || ""))
    await fail(`referral needs a job id (24 hex)`);
  const r = await jobs.updateOne(
    { _id: (await findJobs(jobs, id))[0]?._id },
    {
      $set: {
        referral: { by: opts.by || null, at: now, note: opts.note || null },
      },
    },
  );
  if (!r.matchedCount) await fail(`no job ${id}`);
  console.log(`  referral recorded${opts.by ? ` (by ${opts.by})` : ""}`);
} else if (cmd === "import-linkedin") {
  const file = args[0];
  if (!file) await fail("import-linkedin needs the path to Connections.csv");
  let rows;
  try {
    rows = parseLinkedInConnections(await readFile(file, "utf8"));
  } catch (e) {
    await fail(e.message);
  }
  const ops = rows.map((r) => ({
    updateOne: {
      filter: { nameNorm: nameNorm(r.name), companyKey: companyKey(r.company) },
      update: {
        $set: {
          name: r.name,
          company: r.company,
          companyKey: companyKey(r.company),
          isConnection: true,
          ...(r.title ? { title: r.title } : {}),
          ...(r.linkedin ? { linkedin: r.linkedin } : {}),
          ...(r.connectedOn ? { connectedOn: r.connectedOn } : {}),
          updatedAt: now,
        },
        $setOnInsert: {
          rung: "connection",
          status: "not_contacted",
          touches: [],
          origin: "linkedin-export",
          createdAt: now,
        },
      },
      upsert: true,
    },
  }));
  for (let i = 0; i < ops.length; i += 500)
    await contacts.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  const byKey = new Map();
  for (const r of rows) {
    const k = companyKey(r.company);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const candidates = await jobs
    .find(
      { $or: [LIVE, RESCUABLE], "llmScore.fit": { $gte: 60 } },
      { projection: PROJ },
    )
    .sort({ "llmScore.fit": -1 })
    .limit(2000)
    .toArray();
  const hits = new Map();
  for (const j of candidates) {
    const people = jobCompanyKeys(j).flatMap((k) => byKey.get(k) || []);
    if (!people.length) continue;
    const k = jobCompanyKeys(j)[0];
    if (!hits.has(k)) hits.set(k, { company: coName(j), people, jobs: [] });
    hits.get(k).jobs.push(j);
  }
  console.log(
    `  imported ${rows.length} connections at ${byKey.size} companies`,
  );
  console.log(
    `\nYOU KNOW SOMEONE AT ${hits.size} COMPANY(IES) WITH A LIVE JOB, fit 60+`,
  );
  for (const h of [...hits.values()]
    .sort(
      (a, b) => (b.jobs[0].llmScore?.fit ?? 0) - (a.jobs[0].llmScore?.fit ?? 0),
    )
    .slice(0, 30)) {
    console.log(
      `  ${h.company}: ${h.people.map((p) => `${p.name}${p.title ? ` (${p.title})` : ""}`).join(", ")}`,
    );
    for (const j of h.jobs.slice(0, 3))
      console.log(
        `    ${String(j._id)}  fit ${j.llmScore?.fit}  ${j.title}${j.submitStatus === "submitted" ? `  [applied ${ageDays(j.submitAttemptAt)}d ago]` : ""}`,
      );
  }
} else if (cmd === "caps") {
  const all = await allContacts();
  const c = capsStatus(all, now);
  printCaps(c);
  console.log(`\nOPEN THREADS (${c.openThreads.length})`);
  for (const t of c.openThreads)
    console.log(`  ${t.company}: ${t.name}, last message ${d(t.lastTouchAt)}`);
  const due = all.filter(
    (x) =>
      x.status === "contacted" &&
      x.nextTouchAt &&
      new Date(x.nextTouchAt) <= now,
  );
  console.log(`\nFOLLOW-UPS DUE (${due.length})`);
  for (const x of due) {
    const bumps = (x.touches || []).filter((t) => t.kind === "bump").length;
    console.log(
      `  ${x.company}: ${x.name} · ${bumps >= CAPS.maxBumps ? "no more follow-ups: leave it or mark --kind park" : `follow-up ${bumps + 1} of ${CAPS.maxBumps}, one sentence, a new angle`}`,
    );
  }
} else if (cmd === "audit") {
  const all = await allContacts();
  const sent = await jobs
    .find({ submitStatus: "submitted" }, { projection: PROJ })
    .toArray();
  const count = (list) => {
    const out = {
      referral: 0,
      warm_active: 0,
      contacted_before: 0,
      contacted_after: 0,
      cold: 0,
    };
    for (const j of list) out[attachedAtApply(j, atCompany(all, j))]++;
    return out;
  };
  for (const [label, list] of [
    ["all applications", sent],
    ["last 30 days", sent.filter((j) => ageDays(j.submitAttemptAt) <= 30)],
  ]) {
    const c = count(list);
    const warm = c.referral + c.warm_active + c.contacted_before;
    console.log(`\n${label.toUpperCase()}: ${list.length}`);
    console.log(
      `  referred ${c.referral} · already talking ${c.warm_active} · messaged someone first ${c.contacted_before} · messaged someone after ${c.contacted_after} · cold ${c.cold}`,
    );
    console.log(
      `  person attached before applying: ${warm}/${list.length} (${list.length ? Math.round((100 * warm) / list.length) : 0}%), target ${Math.round(WARM_TARGET * 100)}%`,
    );
  }
} else {
  console.log(USAGE);
  await closeDb();
  process.exit(1);
}
await closeDb();
