/**
 * Deterministic pre-ranking.
 *
 * The LLM scorer costs roughly 36s and a hosted-quota call per job. Running it
 * over a 3,600-job backlog to surface the ~200 worth applying to spends almost
 * all of that budget on jobs that were never going to clear the bar — and the
 * things that disqualify most of them are decidable without a model: the title
 * says Principal, the posting demands eight years, the employer has never filed
 * an H-1B.
 *
 * So: rank everything here for free, then spend the model only on the top slice.
 * This is a triage score, not a fit score. It is deliberately coarse and it
 * never writes to `llmScore` — a job that scores 90 here has only earned the
 * right to be looked at properly.
 *
 * Signals, in rough order of weight:
 *   sponsorship  — an employer that has never sponsored is a dead end for a
 *                  candidate who definitely needs it, whatever the role match
 *   seniority    — the single strongest disqualifier in practice
 *   skills       — overlap with the bullet bank, which is the real skill set
 *   target       — pinned employers are why the system exists
 *   freshness    — first-mover advantage decays fast
 */

// Drawn from the bank rather than invented, so this tracks the real profile.
const SKILL_WEIGHTS = {
  python: 3,
  typescript: 3,
  javascript: 2,
  react: 3,
  "next.js": 3,
  nextjs: 3,
  node: 2,
  "node.js": 2,
  fastapi: 3,
  express: 2,
  fastify: 2,
  graphql: 2,
  rest: 1,
  postgres: 2,
  postgresql: 2,
  mysql: 1,
  mongodb: 2,
  redis: 2,
  neo4j: 1,
  aws: 3,
  docker: 3,
  kubernetes: 2,
  ecs: 1,
  lambda: 1,
  s3: 1,
  kafka: 2,
  "event-driven": 2,
  microservices: 2,
  "ci/cd": 1,
  llm: 3,
  langgraph: 3,
  rag: 3,
  "multi-agent": 3,
  genai: 2,
  "machine learning": 2,
  pytorch: 1,
  tensorflow: 1,
  embeddings: 2,
  erp: 1,
  "multi-tenant": 2,
  idempoten: 2,
  backpressure: 2,
};

/**
 * Engineering, but not this kind of engineering.
 *
 * These are domain nouns, not job titles, and they are deliberately separate
 * from filter.js's EXCLUDE_DISCIPLINE. That list rejects a title whose
 * profession is wrong ("Mechanical Engineer"). This list catches the other
 * shape: a genuine software title doing software work in a physical domain —
 * "Software Engineer, GPU Infrastructure", "Software Engineer, Robotics Data",
 * "Applied AI Engineer, Silicon Engineering". Those are real software jobs and
 * rejecting them outright would be wrong, so they stay in the corpus and lose
 * rank instead. That is the same call already made for research-track reqs
 * below, for the same reason: the blocker is the domain, not the work.
 *
 * The measurement is unambiguous. Across the scored postings that pass the
 * screen, 116 carried one of these tokens in the title and **none** reached fit
 * 70 — the best was 64. The bullet bank has no robotics, silicon, autonomy or
 * plant-floor content, so the model consistently scores them as partial fits,
 * and every one of those calls was spent to be told so.
 *
 * "embedded" is deliberately absent: 27 titles, 1 match at fit 72, which is not
 * a rate that justifies a penalty.
 */
const NON_SOFTWARE_DOMAIN = [
  "robotics",
  "robot",
  "mechatronic",
  "perception",
  "autonomy",
  "autonomous vehicle",
  "gpu",
  "asic",
  "fpga",
  "verilog",
  "rtl",
  "silicon",
  "semiconductor",
  "wafer",
  "pcb",
  "analog",
  "photonics",
  "laser",
  "optical",
  "thermal",
  "hydraulic",
  "pneumatic",
  "hvac",
  "injection molding",
  "servo",
  "turbine",
  "substation",
  "spacecraft",
  "avionics",
  "propulsion",
  "powertrain",
  "weld",
  "cnc",
  "plc",
  "scada",
  "metallurg",
  "geotechnical",
  "drilling",
  "nuclear",
  "medical imaging",
  "electron microscopy",
  "clinical",
  "biomedical",
  "manufacturing",
  "industrial",
  "electrical",
  "mechanical",
  "chemical",
  "civil",
  "process integration",
  "physical design",
  "commissioning",
  "calibration",
  "hardware",
];
const DOMAIN_RE = new RegExp(
  `(?<![a-z0-9])(?:${NON_SOFTWARE_DOMAIN.map((d) =>
    d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
  ).join("|")})`,
  "i",
);

/** The physical-domain token in a title, or null. */
export function nonSoftwareDomain(title = "") {
  const m = DOMAIN_RE.exec(String(title));
  return m ? m[0].toLowerCase() : null;
}

// Titles that disqualify regardless of body text.
const SENIOR_RE =
  /\b(senior|staff|principal|lead|director|manager|head of|architect|vp|sr\.?|iii|iv|distinguished|fellow)\b/i;
const JUNIOR_RE =
  /\b(new ?grad|graduate|entry[- ]level|early career|university|campus|junior|associate|intern|apprentice|i{1,2}\b|\b1\b|\b2\b)\b/i;

// "8+ years", "minimum of 5 years", "5-7 years"
const YEARS_RE = /(\d{1,2})\s*(?:\+|plus|-\s*\d{1,2})?\s*(?:or more\s*)?year/gi;

/** Highest "N years" requirement in the body, or null. */
export function yearsRequired(text = "") {
  let max = null;
  for (const m of String(text).matchAll(YEARS_RE)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 20) max = max === null ? n : Math.max(max, n);
  }
  return max;
}

/** 0..1 — how much of the candidate's stack the posting actually asks for. */
export function skillOverlap(text = "") {
  const hay = String(text).toLowerCase();
  let got = 0;
  let total = 0;
  for (const [skill, w] of Object.entries(SKILL_WEIGHTS)) {
    total += w;
    if (hay.includes(skill)) got += w;
  }
  return total ? got / total : 0;
}

/**
 * Sponsorship contribution, -30..+15.
 *
 * Asymmetric on purpose. A confirmed sponsor is a mild positive — plenty of
 * sponsors still reject. A confirmed non-sponsor is close to fatal, because no
 * amount of role fit survives an employer that will not file. Unknown sits near
 * zero rather than negative: absence of a filing record is weak evidence, and
 * the H-1B data is lagging and name-matched, so treating silence as refusal
 * would discard real opportunities.
 */
export function sponsorshipPoints(sp) {
  if (!sp || sp.status == null) return 0;

  // classifySponsorship emits exactly: cap_exempt | strong | yes | none.
  //
  // This tested for "no", which that function has never once returned, so the
  // -30 penalty described above as "close to fatal" has never fired and a
  // confirmed zero-H-1B employer has scored identically to one nobody checked.
  // Verified against the live database: none 2,136 · strong 957 · yes 402 ·
  // cap_exempt 13 · null 33 — and no "no" anywhere.
  // "none" means no USCIS filing record was found — absence of evidence, not a
  // refusal. Plenty of smaller employers sponsor without ever appearing in the
  // data, and the candidate's stated rule is to apply unless the posting itself
  // says no. A -30 pushed those under the scoring floor and hid them entirely,
  // which is a stronger claim than the data supports. The postings that DO say no
  // are caught by workAuthKnockout, which is a hard screen and does not need help
  // from a ranking penalty.
  if (sp.status === "none") return -8;

  if (sp.staffing) return -10; // body shops: sponsor freely, poor outcomes
  if (sp.status === "yes" || sp.status === "strong" || sp.status === "cap_exempt") {
    let p = 8;
    if ((sp.h1bApprovals || 0) >= 10) p += 4;
    if ((sp.h1bApprovals || 0) >= 100) p += 3;
    // cap_exempt is its own status, not only a boolean flag.
    if (sp.capExempt || sp.status === "cap_exempt") p += 5;
    if (sp.eVerify) p += 3; // required for the STEM OPT extension
    if (sp.confidence === "stale") p -= 3;
    return Math.min(15, p);
  }
  return 0;
}

/**
 * Bump whenever the scoring above changes in a way that would move a job across
 * the floor. Stored on every result so the loop can tell a stale rank from a
 * current one and recompute it — this is free and deterministic, whereas the
 * `llmScore` it gates is neither. Without it a rule added here only ever applies
 * to jobs ingested after the change, and the 4,700 rows already ranked keep
 * their old verdict forever.
 *
 *   1 — original
 *   2 — physical-domain penalty; ambiguous-title and work-auth-soft raised
 */
export const PRERANK_VERSION = 3;

/**
 * Triage score 0..100 plus the reasons, so a low rank is explainable rather
 * than mysterious.
 */
/**
 * Languages the candidate does not write, weighted by how load-bearing they are
 * when a posting leads with them.
 *
 * Prerank scores title shape and company shape well and reads the required stack
 * barely at all. Four Torc Robotics roles pre-ranked 80-85 and were worth 20-29 on
 * reading: C++ device drivers, an operating system, and robotics simulation for
 * autonomous trucks. A Microsoft role pre-ranked 89 whose one required
 * qualification is "C# and .NET". In every case the title said Software Engineer II
 * and the company looked right, so everything the pre-rank could see was positive.
 *
 * Word boundaries matter more than usual here. "java" is a prefix of "javascript"
 * and "go" is a word that appears in every posting ever written. Each pattern
 * below is anchored so it cannot fire on ordinary prose.
 */
const FOREIGN_STACK = [
  // Trailing \b cannot match after "+" — same non-word-boundary trap as c#.
  [/\bc\+\+/, 3, "C++"],
  // \b after "#" never matches: both sides are non-word characters, so there is no
  // boundary there. Same for \b before ".net". Written with \b on both ends these
  // two patterns could not fire at all, and a Microsoft role whose single required
  // qualification is "C# and .NET" scored zero penalty.
  // The lookbehind is load-bearing: a bare /\.net\b/ matches the tail of any
  // .net domain, and it tagged a Robinhood Kubernetes posting as "wants C#/.NET"
  // on the strength of a URL. Require the dot to follow a non-alphanumeric so
  // "careers.example.net" cannot pose as a framework requirement.
  [/\bc#(?![a-z])|(?<![a-z0-9])\.net\b|\basp\.net\b/, 3, "C#/.NET"],
  [/\bjava\b(?!script)/, 2, "Java"],
  // "go" is a verb before it is a language — "go to market", "go above and
  // beyond", "go-getter". Only forms that cannot be ordinary prose count:
  // golang, "written in Go", and Go sitting in a list beside another technology.
  [
    /\bgolang\b|\b(?:in|using|with) go\b|\bgo\s*(?:\/|,|\band\b)\s*(?:rust|python|java|kubernetes|terraform|c\+\+|scala|ruby)\b|\b(?:rust|python|java|kubernetes|terraform|c\+\+|scala|ruby)\s*(?:\/|,|\band\b)\s*go\b/,
    1,
    "Go",
  ],
  [/\brust\b/, 1, "Rust"],
  [/\bscala\b/, 1, "Scala"],
  [/\bkotlin\b/, 2, "Kotlin"],
  [/\bswift\b|\bobjective-c\b/, 2, "Swift/ObjC"],
  [/\bruby\b|\brails\b/, 2, "Ruby"],
  [/\bphp\b/, 2, "PHP"],
  [/\bperl\b/, 2, "Perl"],
  [/\bmatlab\b|\bsimulink\b/, 3, "MATLAB"],
  [/\bvhdl\b|\bverilog\b|\bsystemverilog\b/, 3, "HDL"],
  [/\bembedded (c|firmware|systems)\b|\bdevice driver/, 3, "embedded C"],
  [/\bcobol\b|\bfortran\b|\babap\b/, 3, "legacy (COBOL/Fortran/ABAP)"],
];

/**
 * The languages and frameworks he writes, built from SKILL_WEIGHTS above so that
 * adding a skill to the bank cannot leave this rule believing he still lacks it.
 * Only the language-and-framework keys — "aws", "kafka" and "postgres" are real
 * skills but they say nothing about which language a posting is written in, and
 * counting them would suppress the penalty on every posting that mentions a
 * cloud.
 */
const OWN_LANGS = new Set([
  "python", "typescript", "javascript", "react", "next.js", "nextjs",
  "node", "node.js", "fastapi", "express", "fastify", "graphql",
]);
const OWN_STACK = new RegExp(
  Object.keys(SKILL_WEIGHTS)
    .filter((k) => OWN_LANGS.has(k))
    .map((k) => `\\b${k.replace(/[.+]/g, "\\$&")}\\b`)
    .join("|"),
);

/**
 * How badly the posting's required stack misses, 0 to -30.
 *
 * Only fires when the posting names languages he does NOT write and names none
 * that he does. A posting listing C++ alongside Python is a polyglot team, not a
 * mismatch, and gets nothing. A posting naming no language at all gets nothing
 * either — absence of a stack is not evidence of a wrong one.
 */
export function stackMismatch(text = "") {
  const t = String(text).toLowerCase();
  if (OWN_STACK.test(t)) return { points: 0, reason: null };
  let weight = 0;
  const hit = [];
  for (const [re, w, label] of FOREIGN_STACK) {
    if (re.test(t)) {
      weight += w;
      hit.push(label);
    }
  }
  if (!weight) return { points: 0, reason: null };
  const points = weight >= 3 ? -30 : weight === 2 ? -20 : -12;
  return { points, reason: `wants ${hit.slice(0, 3).join("/")} and none of his stack` };
}

/**
 * Work whose difficulty lives somewhere his bank has never been.
 *
 * The language rule above cannot reach these. All four Torc Robotics postings
 * name Python next to C++, so on a pure language intersection they look
 * polyglot and score no penalty — yet they are device drivers, an operating
 * system, ROS mission interfaces and robotics simulation for autonomous trucks,
 * and reading them gave 20-29. What is foreign is the domain, not the syntax.
 *
 * Deliberately narrow. Every term below is one where being wrong is expensive to
 * him and there is nothing in the bank to draw on. "distributed systems",
 * "infrastructure" and "platform" are absent on purpose — he has those.
 */
/**
 * Markers of the work itself. Each one names something a person does with their
 * hands, and none of it appears anywhere in his bank.
 */
const HARD_DOMAIN = [
  /\bdevice driver|\bdriver development\b/,
  /\brtos\b|\bbare[- ]metal\b|\bfirmware\b/,
  /\blinux kernel\b|\bkernel (module|space|development)\b/,
  /\bembedded (systems?|software|engineer|c\b)/,
  /\bros ?2?\b/,
  /\bmotion planning\b|\bslam\b|\blidar\b/,
  /\bfpga\b|\bautosar\b|\bcan bus\b/,
  /\bfunctional safety\b|\biso ?26262\b|\bsafety[- ]critical\b/,
  /\bcompiler (backend|optimization)\b|\bllvm\b/,
];

/**
 * Markers of what the company sells. An autonomous-vehicle company writes these
 * into the About section of every posting it publishes, including the ones for
 * ordinary backend work, so on their own they say nothing about the job.
 *
 * Applied Intuition's "Software Engineer - Python" contains exactly two of them
 * and not one hard marker. The LLM rated it 76; an earlier draft of this rule
 * pushed it under the paid-scoring floor on the strength of boilerplate. These
 * add weight to a penalty that hard markers have already justified. They can
 * never start one.
 */
const CONTEXT_DOMAIN = [
  /\brobot(ics|ic)\b/,
  /\bautonomous (vehicle|driving|truck)|\bself[- ]driving\b/,
  /\bradar\b/,
];

const OWN_DOMAIN =
  /\brest api\b|\bmicroservice|\bfull[- ]stack\b|\bfront[- ]?end\b|\bweb app|\bdata pipeline|\betl\b|\bllm\b|\bagentic\b|\brag\b|\bfastapi\b|\bdjango\b|\breact\b/;

/**
 * How far outside his experience the actual work sits, 0 to -25.
 *
 * At least one hard marker is required, and at least two markers overall. One
 * alone is too easy to hit by accident: an ML infrastructure posting says
 * "kernel" about CUDA, a fraud team says "radar" about a dashboard.
 */
export function domainMismatch(text = "", title = "") {
  const t = String(text).toLowerCase();
  const ttl = String(title).toLowerCase();
  const hard = HARD_DOMAIN.filter((re) => re.test(t)).length;
  if (!hard) return { points: 0, reason: null };
  const hits = hard + CONTEXT_DOMAIN.filter((re) => re.test(t)).length;
  if (hits < 2) return { points: 0, reason: null };

  // The title is the only part of a posting that describes this job rather than
  // this company, so a marker there settles the question.
  const titleHit = [...HARD_DOMAIN, ...CONTEXT_DOMAIN].some((re) => re.test(ttl));
  let points = hits >= 4 ? -25 : titleHit ? -20 : -18;
  if (!titleHit && hard === 1 && (OWN_DOMAIN.test(t) || OWN_STACK.test(t))) {
    points = Math.round(points / 2);
  }
  return {
    points,
    reason: `domain outside the bank (${hits} embedded/robotics marker${hits === 1 ? "" : "s"}${titleHit ? ", in the title" : ""})`,
  };
}

export function prerank(job, company = {}, { now = Date.now() } = {}) {
  const title = String(job.title || "");
  const body = String(job.description || "");
  const reasons = [];
  let score = 45; // neutral starting point

  // --- seniority: the strongest single signal --------------------------
  const senior = SENIOR_RE.test(title);
  const junior = JUNIOR_RE.test(title);
  if (senior && !junior) {
    score -= 35;
    reasons.push("senior-titled role");
  } else if (junior) {
    score += 18;
    reasons.push("early-career title");
  }

  // --- explicit experience demands -------------------------------------
  const yrs = yearsRequired(body);
  if (yrs !== null) {
    // ~2 years FTE. Up to 3 is a normal stretch; beyond 5 the resume is screened out.
    if (yrs <= 2) {
      score += 10;
      reasons.push(`asks ${yrs}y`);
    } else if (yrs <= 3) {
      score += 4;
      reasons.push(`asks ${yrs}y`);
    } else if (yrs <= 5) {
      score -= 8;
      reasons.push(`asks ${yrs}y`);
    } else {
      score -= 25;
      reasons.push(`asks ${yrs}y — out of range`);
    }
  }

  // --- stack overlap ----------------------------------------------------
  const ov = skillOverlap(body);
  const ovPts = Math.round(ov * 60); // dense JDs rarely exceed ~0.5
  score += ovPts;
  if (ovPts >= 12)
    reasons.push(`strong stack overlap (${Math.round(ov * 100)}%)`);
  else if (ovPts <= 4) reasons.push("little stack overlap");

  // --- sponsorship ------------------------------------------------------
  const spPts = sponsorshipPoints(company.sponsorship);
  score += spPts;
  if (spPts <= -20) reasons.push("no H-1B filing history");
  else if (spPts >= 10) reasons.push("established sponsor");

  // --- pinned target ----------------------------------------------------
  if (company.isTarget) {
    score += 12;
    reasons.push("pinned target");
  }

  // --- freshness: first-mover advantage decays fast ---------------------
  const seen = job.firstSeenAt ? new Date(job.firstSeenAt).getTime() : null;
  if (seen) {
    const hrs = (now - seen) / 3_600_000;
    if (hrs <= 6) {
      score += 8;
      reasons.push("posted in the last 6h");
    } else if (hrs <= 24) score += 4;
    else if (hrs > 96) {
      score -= 6;
      reasons.push("over 4 days old");
    }
  }

  // --- soft flags from the screen ---------------------------------------
  // These do not disqualify, so they must not vanish — but they should stop
  // consuming the top of a scoring batch. Research-track reqs in particular
  // matched well on content and badly on hiring track; the penalty pushes them
  // below every comparable SDE-titled role without deleting them.
  const flags = job.screen?.softFlags || [];
  for (const f of flags) {
    if (f.startsWith("research_track")) {
      score -= 28;
      reasons.push("research track (expects PhD-level credentials)");
    } else if (f.startsWith("defence_employer")) {
      score -= 20;
      reasons.push("defence employer — verify export-control status");
    } else if (f.startsWith("customer_facing_ambiguous")) {
      // Could be deployment work or pre-sales; the title alone cannot say.
      //
      // Raised from -12. The flag used to cover "deployment engineer", which is
      // a genuinely strong role here, and the penalty had to stay gentle to
      // avoid burying it. filter.js no longer flags that title, so what is left
      // — solution(s)/field/implementation engineer — measures 64 scored
      // postings, 0 above fit 70, best 60, and can be sent below the floor.
      score -= 25;
      reasons.push("ambiguous customer-facing title, read in context");
    } else if (f.startsWith("systems_engineer_unqualified")) {
      // Unqualified "Systems Engineer" is usually hardware, manufacturing or IT
      // rather than software. Measured 1 match in 79 against 22% baseline, so it
      // sinks well below everything comparable without being deleted.
      score -= 30;
      reasons.push("unqualified systems-engineer title, usually not software");
    } else if (f.startsWith("work_auth_soft")) {
      // Raised from -10, which was too weak to matter: 8 of these still cleared
      // the pre-rank floor and were scored. Across the scored corpus the flag
      // covers 30 postings with 0 above fit 70 and a ceiling of 55 — ITAR and
      // "U.S. Person" language clusters on defence and hardware employers whose
      // reqs this candidate cannot take anyway. Still a flag, not a rejection:
      // bare "export control" really is boilerplate on ordinary tech postings.
      score -= 22;
      reasons.push("soft work-auth signal in body");
    }
  }

  // --- software work, physical domain -----------------------------------
  const domain = nonSoftwareDomain(title);
  if (domain) {
    score -= 25;
    reasons.push(`${domain} domain — outside the bullet bank`);
  }

  // --- work he cannot credibly claim -------------------------------------
  // Stack and domain are two readings of the same risk, so they share one
  // budget rather than stacking into a -55 that would bury a posting below
  // every other signal the pre-rank has.
  const sm = stackMismatch(body);
  const dm = domainMismatch(body, job.title || "");

  // A description sitting at the storage cap is evidence we truncated, not
  // evidence the posting is short — and the stack rule reasons from an absence
  // ("names no language he writes"), which is exactly the claim truncation
  // makes unsafe. An Amazon OpenSearch posting says "java, c/c++, and python"
  // and earns nothing; the same posting cut fifty characters earlier would earn
  // -30 for the identical role. Halve the stack penalty when the text may be
  // incomplete. The domain rule reasons from presence, so it is unaffected.
  const truncated = body.length >= 4700;
  const stackPoints = truncated ? Math.round(sm.points / 2) : sm.points;

  // A pinned target is a decision he made about where he wants to work, and a
  // language heuristic does not get to overrule it. Stripe and Block ship Ruby
  // and Java and hire people who write neither; a -30 there would drop them
  // under the paid-scoring floor and he would simply never see the posting.
  // Capped rather than cancelled — a device-driver role at a pinned company is
  // still a device-driver role.
  const floor = company.isTarget ? -12 : -30;
  const mismatch = Math.max(floor, stackPoints + dm.points);
  if (mismatch) {
    score += mismatch;
    reasons.push(
      [sm.reason && truncated ? `${sm.reason} (partial text)` : sm.reason, dm.reason]
        .filter(Boolean)
        .join("; "),
    );
  }

  // --- thin postings are unscoreable, not unattractive ------------------
  if (body.length < 800) {
    score -= 10;
    reasons.push("thin description");
  }

  return {
    v: PRERANK_VERSION,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    signals: {
      senior,
      junior,
      yearsRequired: yrs,
      overlap: Number(ov.toFixed(3)),
      spPts,
      domain,
    },
  };
}
