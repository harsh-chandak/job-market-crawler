/**
 * Resume tailoring.
 *
 * The safety model is structural, not prompt-based: the model is asked to return
 * BULLET IDS, never text. Rendering looks each id up in resume/bullets.yaml and
 * emits the approved string verbatim. A model that hallucinates simply produces
 * an id that does not exist, which is caught and dropped — it cannot invent an
 * employer, a date, or a metric, because it never writes prose at all.
 *
 * That is what makes it safe to develop against a 3B local model, and it is why
 * fabrication is impossible rather than merely discouraged. Lying on a job
 * application is a real problem in general and a worse one during a visa
 * process, so this is enforced in code.
 *
 * The model's actual job is small and well-posed: pick the variant, choose which
 * pre-written bullets to include, and order them.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { createHash } from "node:crypto";
import { completeWithFallback as complete } from "./llm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BANK_PATH = join(HERE, "..", "resume", "bullets.yaml");

export async function loadBank(path = BANK_PATH) {
  return YAML.parse(await readFile(path, "utf8"));
}

/** Flat id -> {text, families, tags, section} index over the whole bank. */
export function indexBullets(bank) {
  const idx = new Map();
  for (const exp of bank.experience || []) {
    for (const b of exp.bullets || []) {
      idx.set(b.id, {
        ...b,
        section: "experience",
        parent: exp.id,
        company: exp.company,
        cap: exp.max_bullets ?? null,
      });
    }
  }
  for (const prj of bank.projects || []) {
    for (const b of prj.bullets || []) {
      idx.set(b.id, {
        ...b,
        section: "projects",
        parent: prj.id,
        project: prj.name,
        cap: prj.max_bullets ?? null,
        showProjects: bank.render?.max_projects ?? null,
        fillProjects: bank.render?.fill_projects ?? null,
      });
    }
  }
  return idx;
}

export const SELECT_SCHEMA = {
  type: "object",
  required: ["family", "bulletIds"],
  properties: {
    family: { type: "string", enum: ["swe", "ai"] },
    bulletIds: { type: "array", maxItems: 24, items: { type: "string" } },
    skillCategories: { type: "array", maxItems: 6, items: { type: "string" } },
    rationale: { type: "string" },
  },
};

const SYSTEM = `You select resume content. You return JSON only.

You are given a job posting and a list of AVAILABLE BULLET IDs with their text.
Choose which bullets belong on the resume for THIS job, and in what order.

HARD RULES
- Return ONLY ids from the provided list. Never write or edit bullet text.
- Never invent an id. If unsure, omit it.
- Keep bullets from the same employer contiguous, ordered most-relevant-first.
- Choose "family" as the best-matching variant: swe or ai.

HOW MANY
- Each employer and project shows its cap in the catalogue ("walnutech, up to
  6"). The current role carries the most weight. Pick up to the cap, best
  first; the renderer trims from the end if the page runs over.
- Projects: order them by fit to the posting; the PROJECTS header says how
  many show. Each shown project needs at least three bullets; give it its
  best three, strongest first.
- Selecting fewer than the target is better than padding with a weak bullet.

WHAT TO PREFER
- A bullet whose MECHANISM matches the posting beats one whose keywords match.
  "cut reranker latency by index-keying the scoring path" beats a bullet that
  merely contains the word "latency".
- A bullet carrying a number beats one that does not, when both are relevant.
- Impact on the product beats a task. Prefer a bullet that says what changed
  for the people using the product (students, counselors, clients) or for the
  business over one that describes routine engineering work: deploying a
  service, using a tool, a count of PRs, "built the frontend and backend".
  Those task bullets carry keywords the skills section already carries. Use at
  most one per employer, and only when the posting asks for that exact thing.
- For the current role, lead with its strongest outcome bullets unless the
  posting's subject rules them out.
- Drop a bullet whose subject the posting never mentions, however impressive it
  is. A resume that answers a different question reads as a mismatch.

SKILLS
- Return "skillCategories": choose ONLY from the SKILL CATEGORIES list given
  below the bullets, copied exactly. Name the ones worth showing for THIS job,
  in priority order, and omit any the posting gives no reason to include.
- A crowded skills block reads as a list of everything ever touched. Four
  categories is plenty; three is fine.

Return JSON:
{"family":"...","bulletIds":[...],"skillCategories":[...],"rationale":"..."}`;

/**
 * Does a `requires`-gated bullet apply to this posting?
 *
 * Some material is true and worth keeping but only worth SAYING when the employer
 * asked for it. Fluency with AI coding agents reads as substance to a team that
 * lists Claude Code in the job description and as filler to one that does not, and
 * a resume that volunteers it unprompted spends a line to look less focused.
 *
 * A bullet with no `requires` behaves exactly as before. One with `requires` is
 * invisible unless the posting mentions at least one of its terms.
 *
 * Absent job text excludes gated bullets rather than including them. A render with
 * nothing to match against cannot know the gate opens, and silently defaulting to
 * "show it" would make the gate meaningless in exactly the paths that skip it —
 * tests, previews, the stub selector.
 */
export function gatePasses(bullet, jobLower) {
  const req = bullet.requires;
  if (!req || !req.length) return true;
  if (!jobLower) return false;
  return req.some((term) => jobLower.includes(String(term).toLowerCase()));
}

function bulletCatalogue(idx, family, jobLower) {
  // Employers and projects were rendered identically — every row read
  // `id [walnutech] (tags): text`, with nothing to say that walnutech is a job
  // and jobhunt is a side project. The HOW MANY rules give employers a target of
  // 4/4/5 and projects 1-2, and the model was being asked to apply them to
  // categories it could not see. Measured over 51 selections: the job-hunt
  // project appeared on 13, telemetry on 4, kafka-neo4j on 2, and one resume ran
  // Example Corp to 12 bullets because nothing bounded it. Labelling the two groups
  // is the whole fix.
  const employer = [], project = [];
  const caps = new Map();
  for (const [id, b] of idx) {
    if (!caps.has(b.parent)) caps.set(b.parent, { section: b.section, cap: b.cap, show: b.showProjects ?? null, fill: b.fillProjects ?? null });
    // Show the family-appropriate variants plus anything universal.
    if (family && b.families?.length && !b.families.includes(family)) continue;
    // Withhold gated bullets the posting did not ask for, so the model cannot
    // select what the renderer would then have to drop.
    if (!gatePasses(b, jobLower)) continue;
    (b.section === "projects" ? project : employer).push(
      `${id} [${b.parent}] (${(b.tags || []).join(",")}): ${b.text}`,
    );
  }
  // Each role's weight on the page, so the selector ranks within it instead of
  // picking twelve from the current role for the renderer to throw away.
  const capsFor = (section) =>
    [...caps]
      .filter(([, v]) => v.section === section && v.cap)
      .map(([p, v]) => `${p}, up to ${v.cap}`)
      .join("; ");
  const head = (label, section, extra = "") => {
    const parts = [extra, capsFor(section)].filter(Boolean).join("; ");
    return parts ? `${label} (${parts}):` : `${label}:`;
  };
  const show = [...caps.values()].find((v) => v.section === "projects" && v.show)?.show;
  const fill = [...caps.values()].find((v) => v.section === "projects" && v.fill)?.fill;
  return [
    head("EMPLOYERS", "experience"),
    ...employer,
    "",
    head("PROJECTS", "projects", show ? `show ${show}${fill > show ? `, ${fill} if the page has room` : ""}` : ""),
    ...project,
  ].join("\n");
}

function stubFactory(seed, user) {
  const ids = [...user.matchAll(/^([a-z0-9-]+) \[/gm)].map((m) => m[1]);
  return {
    family: ["swe", "ai"][seed % 2],
    bulletIds: ids.slice(0, 12),
    rationale: "stub selector — deterministic",
  };
}

/**
 * Ask the model which bullets to use.
 * Returns { family, bulletIds, dropped } where `dropped` records any id the
 * model produced that does not exist — the fabrication signal.
 */
// Bullet selection only needs enough JD to judge relevance. The full 5k chars
// pushed each call to ~5k tokens, which exhausts a free-tier TPM budget in two
// requests and turns every subsequent call into a multi-minute 429 wait.
const TAILOR_DESC_CHARS = Number(process.env.TAILOR_DESC_CHARS || 2200);

/**
 * A requirements HEADING, not any mention of the words.
 *
 * A bare /skills|responsibilities/ matches boilerplate prose — Scout Motors says
 * "respect" and "hard work" in a paragraph about 1960s trucks and tripped an
 * earlier version of this pattern at character 300, which then reported the
 * requirements as "found" and changed nothing. A heading sits at a line start or
 * after a period, and is followed by a colon, a newline, or the end of a short
 * line.
 */
const REQUIREMENTS_RE = new RegExp(
  String.raw`(^|
|\.\s{1,3})\s*(?:basic |minimum |preferred |required )?` +
    String.raw`(qualifications|requirements|responsibilities|what you.{0,3}ll (?:do|need|bring)` +
    String.raw`|what we.{0,3}re looking for|who you are|about the role)` +
    String.raw`\s*[:
]`,
  "i",
);

/**
 * The slice of a posting worth spending tokens on.
 *
 * Taking the first N characters assumes a posting opens with the job. Many open
 * with the company: Scout Motors leads an AI Infrastructure Engineer posting with
 * two paragraphs on electric powertrains and a gas range extender. Across the 84
 * approved jobs, 18 keep their requirements past character 2200 — for those the
 * selector was choosing bullets from boilerplate alone, having never read a
 * single requirement.
 *
 * When the requirements start late, keep a short head for role framing and spend
 * the rest of the budget from the requirements onward. Same token budget, just
 * aimed at the half of the posting that decides which bullets belong.
 */
/**
 * Signals that a stretch of text is telling you what the job needs, rather than
 * what the company believes about itself.
 */
/**
 * Words that mean a passage is stating what the job needs.
 *
 * Note what is NOT here: a raw bullet marker. Counting "-" and "•" made every
 * list look like requirements, and benefits, relocation policy and equal-
 * opportunity statements are the most bullet-dense parts of a posting. Scoring
 * on markers sent Scout Motors' excerpt to its office-attendance policy.
 */
const REQ_SIGNAL =
  /\bexperience\b|\byears?\b|\bproficien|\bfamiliar|\bdegree\b|\bbachelor|\bmaster|\bknowledge of\b|\bability to\b|\byou (will|have|should)\b|\bstrong\b|\bexpertise\b|\bbuild|\bdesign|\bdevelop|\bpython\b|\bjava\b|\btypescript\b|\bsql\b|\baws\b|\bapi\b|\bkubernetes\b|\bllm\b|\bmachine learning\b|\bdistributed\b/gi;

/** Passages that are dense but worthless: pay, perks, policy, legal. */
const BOILERPLATE_SIGNAL =
  /\bequal opportunity\b|\bbenefits?\b|\b401\(?k\)?|\bpto\b|\bpaid time off\b|\bsalary range\b|\bcompensation\b|\bin the office\b|\bdays per week\b|\brelocation\b|\bvisa\b|\bbackground check\b|\bdisability\b|\bveteran\b|\breasonable accommodation\b|\bheadquarters\b|\bperks?\b|\binsurance\b/gi;

const density = (s) => {
  const per1k = (re) => ((s.match(re) || []).length) / (s.length / 1000 || 1);
  // Boilerplate counts double against, because a passage that is both is a
  // benefits list that happens to say "experience" once.
  return per1k(REQ_SIGNAL) - 2 * per1k(BOILERPLATE_SIGNAL);
};

export function jobExcerpt(description = "", limit = TAILOR_DESC_CHARS) {
  const d = String(description || "");
  if (d.length <= limit) return d;
  const HEAD = Math.min(600, Math.floor(limit / 3));
  const BODY = limit - HEAD;

  // Three candidate windows, and the densest wins.
  //
  // An earlier version let a heading short-circuit everything, which put us back
  // where we started: Scout Motors matches a heading pattern early, inside two
  // paragraphs about 1960s trucks, so the rule fired, returned the opening, and
  // reported success. A heading is good evidence, not proof — score it like any
  // other candidate.
  const candidates = [{ at: 0, text: d.slice(0, limit) }];

  const m = d.match(REQUIREMENTS_RE);
  if (m) {
    const at = m.index + (m[1] ? m[1].length : 0);
    candidates.push({ at, text: d.slice(at, at + BODY) });
  }
  for (let i = 0; i + BODY <= d.length; i += 200) {
    candidates.push({ at: i, text: d.slice(i, i + BODY) });
  }

  let best = candidates[0], bestScore = density(candidates[0].text);
  for (const c of candidates.slice(1)) {
    const sc = density(c.text);
    // Strictly densest wins. The earlier-window bias this used to carry was
    // guarding against benefits and EEO sections, which BOILERPLATE_SIGNAL now
    // subtracts directly — and the bias was costing real hits: Scout Motors
    // keeps its Kubernetes and Python requirements in the last 400 characters,
    // and an office-attendance paragraph held the lead by less than the margin.
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  if (best.at === 0) return d.slice(0, limit);
  return `${d.slice(0, HEAD)}\n…\n${best.text}`;
}

export async function selectBullets(job, bank, opts = {}) {
  const idx = indexBullets(bank);
  // Lines a reviewer judged weak for this posting are not offered again.
  for (const id of opts.avoidIds || []) idx.delete(id);
  const catalogue = bulletCatalogue(
    idx,
    null,
    [job.title, job.description].filter(Boolean).join("\n").toLowerCase(),
  );

  // ORDER MATTERS FOR COST, NOT JUST READABILITY.
  //
  // Prompt caching is a prefix match: everything before the last cache
  // breakpoint is reusable, everything after it is not. The catalogue is ~2,500
  // tokens and byte-identical on every call; the job posting is a few hundred
  // and different every time. With the posting first — as this was written —
  // the catalogue sat behind volatile bytes and nothing could ever cache.
  //
  // Catalogue first, posting last. The catalogue is now a cacheable prefix that
  // bills at a tenth of the input rate from the second call onward.
  // The category names go in the cacheable prefix with the bullets. They are
  // identical on every call, so they cost a tenth of the input rate from the
  // second call onward — and without them the model was being asked to name
  // categories from a list it had never been shown. It guessed "Backend & APIs",
  // "Databases" and "Cloud & Infrastructure" against a bank holding
  // "Frameworks", "Data" and "Cloud & DevOps"; 30 of 48 selections matched too
  // few names and silently fell back to rendering every category, which is the
  // crowded skills block the rule exists to prevent.
  const categories = [
    ...new Set(Object.values(bank.skills || {}).flatMap((v) => Object.keys(v || {}))),
  ];
  const cachePrefix = [
    `AVAILABLE BULLETS:`,
    catalogue,
    ``,
    `SKILL CATEGORIES (copy names exactly):`,
    categories.join(" | "),
    ``,
  ].join("\n");

  const user = [
    `JOB POSTING:`,
    `Company: ${job.companyName || job.companyToken}`,
    `Title: ${job.title}`,
    `Location: ${(job.locations || []).slice(0, 3).join(" | ")}`,
    `Description:\n${jobExcerpt(job.description) || "(unavailable)"}`,
    ``,
    ...(opts.hint ? [`REVIEWER NOTE ON THE FIRST DRAFT: ${opts.hint}`, ``] : []),
    // Must list every field the SYSTEM prompt asks for. This line is the last
    // thing the model reads and it used to omit skillCategories, which is
    // optional in the schema — so three of 51 selections simply dropped it and
    // validated clean.
    `Return JSON: {"family": "...", "bulletIds": [...], "skillCategories": [...], "rationale": "..."}`,
    `Keep rationale to one sentence, 200 characters or fewer.`,
  ].join("\n");

  const res = await complete({
    stage: "tailor",
    system: SYSTEM,
    cachePrefix,
    user,
    schema: SELECT_SCHEMA,
    // Bullet selection is a constrained pick-from-a-fixed-list with a schema, and
    // Sonnet 5 thinks by default. Measured on one posting: adaptive thinking spent
    // 1,570 output tokens to return 14 ids; thinking off spent 204 to return 13.
    // Output is the largest line item in this pipeline, so that was 87% of the
    // bill buying one extra id.
    //
    // It also caused a failure, not just cost. Thinking tokens count against
    // max_tokens, so a verbose reasoning pass ran the 2,000 ceiling and truncated
    // the JSON mid-object — the ROBLOX resume was lost to exactly that.
    thinkingDisabled: true,
    // Headroom, not generosity: output bills only what is produced, and a reply
    // clipped at the ceiling is a lost resume. Sonnet writes ~1,050 tokens here.
    maxTokens: 2000,
    stubFactory,
    ...opts.llm,
  });

  const requested = res.data.bulletIds || [];
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (idx.has(id)) kept.push(id);
    else dropped.push(id); // hallucinated id — never rendered
  }

  return {
    family: res.data.family,
    bulletIds: kept,
    skillCategories: res.data.skillCategories || null,
    dropped,
    rationale: res.data.rationale || null,
    _meta: {
      provider: res.provider,
      model: res.model,
      attempts: res.attempts,
      // Surface the fallback. It was silent, and silence hid the actual cause of
      // thin tailoring for a whole session: Groq rate-limits with a 2230s
      // retry-after once the free tier is spent, every call quietly drops to a
      // local 7B, and a 7B returns about a quarter of the ids asked for.
      fellBackFrom: res.fellBackFrom || null,
      fallbackReason: res.fallbackReason || null,
    },
  };
}

/**
 * Render a resume from ids. Text comes exclusively from the bank.
 *
 * `fallbackToFamily` guarantees a usable resume even when the model returns
 * garbage: any employer left with no selected bullets falls back to that
 * employer's default bullets for the chosen family. A tailored resume is a
 * nice-to-have; having *a* resume is not optional if we are going to submit.
 */
/**
 * How well one bank bullet answers one posting, 0..n.
 *
 * Tags are worth more than prose words because they were assigned deliberately,
 * and a tag appearing in the posting is a direct statement that the posting asks
 * for that thing. Prose overlap is a weaker signal but catches vocabulary the
 * tags do not carry.
 *
 * Stopwords are excluded and only words of 5+ characters count, because "with",
 * "built" and "across" appear in every posting and every bullet and would drown
 * the signal.
 */
export function bulletRelevance(bullet, jobTextLower) {
  if (!jobTextLower) return 0;
  let score = 0;
  for (const tag of bullet.tags || [])
    if (jobTextLower.includes(String(tag).toLowerCase())) score += 3;
  const words = new Set(
    String(bullet.text || "")
      .toLowerCase()
      .match(/[a-z][a-z+.#/-]{4,}/g) || [],
  );
  for (const w of words) if (jobTextLower.includes(w)) score += 1;
  return score;
}

export function renderResume(
  bank,
  { family, bulletIds },
  // 4, not 5. The the platform rewrite took that employer from 11 bullets to 17, and
  // at 5-per-employer the SWE variant spills to a second page that the
  // trim-until-fits loop cannot recover — it ran 13 trims and still overflowed.
  // One page is the constraint the whole renderer exists to satisfy, so the cap
  // moves rather than the page count.
  // 6, not 4: the user wants 4-6 bullets per role, and the renderer now enforces
  // a floor of 4 rather than trimming to one, so handing it more to work with is
  // safe. maxProjects caps the projects section — two strong projects read
  // better than three thin ones, and it is the cheapest page space to reclaim.
  {
    // Per-role caps in the order the employers appear: 4, 4, 5. The most recent
    // role gets fewer because its bullets are longer and denser; the oldest gets
    // more because breadth is what it is there to show. Falls back to
    // maxPerEmployer for any role beyond the list.
    // 6/6/6 and two projects, matching the target resume supplied by the
    // candidate. This supersedes an earlier 4/4/5 instruction: the PDF is the
    // concrete artefact and it fits on one page, so there is no reason to give
    // up six bullets of evidence.
    perRoleCaps = [6, 6, 6],
    maxPerEmployer = 6,
    maxProjects = 2,
    // A ceiling over each project's own max_bullets, which defaults to 2.
    maxPerProject = 3,
    skillCategories = null,
    // The posting text, so top-up can rank by relevance instead of bank order.
    jobText = null,
    exclude = null,
    fallbackToFamily = true,
  } = {},
) {
  const idx = indexBullets(bank);
  const order = new Map(bulletIds.map((id, i) => [id, i]));
  const jobLower = jobText ? String(jobText).toLowerCase() : null;
  // Bullets a review took out of this resume; top-up must not put them back.
  const excluded = new Set(exclude || []);

  /**
   * Selected bullets first, then TOP UP to the cap from the family defaults.
   *
   * The previous version only fell back when a role had ZERO selected bullets,
   * which made partial selection strictly worse than none: a selector returning
   * three ids for the whole resume gave the newest role one bullet while the two
   * older roles, having none, each got the full six. A one-bullet current role
   * reads as a thin career, and the cause was never the bank or the layout — it
   * was trusting the selector for completeness as well as for ranking.
   *
   * The selector ranks. The renderer guarantees the shape. Local models in
   * particular return far fewer ids than asked for — qwen2.5:7b averaged 5.2
   * against the 22 a full resume needs — and a resume must not degrade because a
   * 7B model was terse.
   *
   * Top-up is ordered by relevance to the posting, not by bank order. With the
   * selector supplying about a quarter of the bullets, bank order meant three
   * quarters of every resume was identical regardless of the job — the shape was
   * right and the tailoring was theatre.
   */
  const pickFor = (parentId, available, cap = maxPerEmployer, minBullets = 0) => {
    if (excluded.size) available = available.filter((b) => !excluded.has(b.id));
    const chosen = available
      .filter((b) => gatePasses(b, jobLower))
      .filter((b) => order.has(b.id))
      .sort((a, b) => order.get(a.id) - order.get(b.id))
      .slice(0, cap);
    if (!fallbackToFamily) return chosen;

    if (chosen.length >= cap) return chosen;
    const taken = new Set(chosen.map((b) => b.id));
    const ranked = available
      .filter(
        (b) =>
          !taken.has(b.id) &&
          (b.families || []).includes(family) &&
          gatePasses(b, jobLower),
      )
      .map((b) => ({ b, r: bulletRelevance(b, jobLower) }))
      .sort((x, y) => y.r - x.r);

    // Top up to the cap with bullets that match the posting, but only down to
    // FLOOR with ones that do not. The selector's own instructions say
    // "selecting fewer than the target is better than padding with a weak
    // bullet", and the top-up was overriding that: on the Amazon MSK and OpenAI
    // FDE postings it reached six by adding e-way-bill tax filing and ERP
    // accounting, both scoring zero against the posting. A role still never
    // renders thin — four is the floor the page was tuned around — but the
    // fifth and sixth lines now have to earn their place.
    // A role's own min_bullets raises the floor; nothing, a review included,
    // takes it below that.
    const FLOOR = Math.max(4, minBullets || 0);
    const relevant = ranked.filter((x) => x.r > 0).map((x) => x.b);
    const filler = ranked.filter((x) => x.r === 0).map((x) => x.b);
    const withRelevant = [...chosen, ...relevant].slice(0, cap);
    if (withRelevant.length >= Math.min(FLOOR, cap)) return withRelevant;
    return [...withRelevant, ...filler].slice(0, Math.min(FLOOR, cap));
  };

  const experience = (bank.experience || []).map((exp, i) => ({
    company: exp.company,
    role: exp.role,
    location: exp.location,
    locationNote: exp.location_note || null,
    dates: exp.dates,
    // maxPerEmployer is a CEILING over the per-role caps, not an alternative to
    // them. An explicit caller value was previously ignored whenever
    // perRoleCaps had an entry for that index, which is surprising and was
    // caught by the render test rather than by review.
    bullets: pickFor(
      exp.id,
      exp.bullets || [],
      // The bank's max_bullets is the role's weight on the page; perRoleCaps
      // remains for callers and tests that set shape explicitly.
      Math.min(exp.max_bullets ?? perRoleCaps[i] ?? maxPerEmployer, maxPerEmployer),
      exp.min_bullets,
    ).map((b) => idx.get(b.id).text),
  }));

  const projects = (bank.projects || [])
    .map((prj) => ({
      name: prj.name,
      stack: prj.stack,
      bullets: pickFor(prj.id, prj.bullets || [], Math.min(prj.max_bullets ?? 2, maxPerProject)).map(
        (b) => idx.get(b.id).text,
      ),
    }))
    // A project with fewer than the bank's minimum bullets reads as filler.
    .filter((p) => p.bullets.length >= (bank.render?.min_project_bullets ?? 1));

  /**
   * Rank projects by fit to THIS posting, then cap.
   *
   * This sorted by bullet count and called it "the projects the model ranked
   * highest". It was neither. pickFor tops every project up to maxPerProject, so
   * all of them end with an identical count, the comparator returns 0 for every
   * pair, and slice() silently keeps whichever two happen to come first in the
   * bank. Bank order is authoring order — nothing to do with the job.
   *
   * The cost was not theoretical: the most recent and most relevant project in
   * this bank sits third and therefore appeared on no resume at all, across every
   * application sent. A ranking function that cannot distinguish its inputs is
   * worse than no ranking, because it looks deliberate.
   *
   * Rank on the model's own ordering first — an id it placed early is an explicit
   * judgement that this project matters here — then on relevance to the posting,
   * and only then on length.
   */
  const projectScore = (prj) => {
    let earliest = Infinity;
    for (const b of prj.bullets || [])
      if (order.has(b.id)) earliest = Math.min(earliest, order.get(b.id));
    const relevance = (prj.bullets || []).reduce(
      (m, b) => Math.max(m, bulletRelevance(b, jobLower)),
      0,
    );
    return { earliest, relevance };
  };
  const byId = new Map((bank.projects || []).map((p) => [p.name, p]));
  const rankedAll = projects
    .map((p) => ({ p, s: projectScore(byId.get(p.name) || {}) }))
    .sort(
      (a, b) =>
        a.s.earliest - b.s.earliest ||
        b.s.relevance - a.s.relevance ||
        b.p.bullets.length - a.p.bullets.length,
    )
    .map((x) => x.p);
  // The shown projects, plus the next-best held back for renderPdf, which adds
  // them only when the page has room (bank render.fill_projects). Blank space
  // at the foot of a one-page resume is a project that could have been there.
  const showProjects = bank.render?.max_projects ?? maxProjects;
  const ranked = rankedAll.slice(0, showProjects);
  const spareProjects = rankedAll.slice(showProjects, Math.max(showProjects, bank.render?.fill_projects ?? showProjects));

  // Skills: show only what the posting gives a reason to show. A crowded block
  // reads as a list of everything ever touched rather than a specialism, and an
  // unrelated category is worse than a missing one — it invites the reader to
  // discount the rest.
  // Some skill categories are only worth SAYING when the employer asked.
  //
  // "AI Tooling: Claude Code, GitHub Copilot" was gated at the bullet level and
  // nowhere else, so it rendered as a skills line on 51 resumes — 27 of them to
  // employers whose posting never mentioned AI tooling, and eight to rival labs.
  // Three went to OpenAI naming a competitor's product as a skill. A gate that
  // covers bullets and not the skills block is not a gate.
  const GATED_CATEGORIES = {
    "AI Tooling": /\bclaude\b|copilot|cursor|codeium|windsurf|ai[- ]assisted|ai (coding|dev(eloper)?) tool|coding assistant|\bllm\b tooling/i,
  };
  const allSkills = Object.fromEntries(
    Object.entries((bank.skills || {})[family] || {}).filter(([k]) => {
      const gate = GATED_CATEGORIES[k];
      if (!gate) return true;
      // No job text means no evidence the employer asked — same rule the bullet
      // gate uses, and for the same reason.
      return jobLower ? gate.test(jobLower) : false;
    }),
  );
  let skills = allSkills;
  if (skillCategories?.length) {
    // The selector is shown every family's category names, so it copies real
    // ones instead of inventing "Backend & APIs". But it picks a family and its
    // categories in one shot and cannot know which names that family carries,
    // and matching only inside the chosen family dropped the rest without a
    // word. An ai resume asking for "AI / Agentic" and "Testing & Monitoring"
    // rendered two lines, Languages and AI / LLM, with Cloud, Frameworks and
    // Data gone. 96 of 271 sent applications went out like that.
    //
    // Resolve each name in the chosen family, then to a same-family
    // equivalent, then from whichever family defines it. The gate applies
    // wherever a category comes from.
    const ALIASES = {
      "AI / Agentic": ["AI Engineering", "AI / LLM"],
      "AI Engineering": ["AI / Agentic", "AI / LLM"],
      "AI / LLM": ["AI Engineering", "AI / Agentic"],
      "Testing & Monitoring": ["Security & Reliability"],
      "Security & Reliability": ["Testing & Monitoring"],
    };
    const gateOk = (name) => {
      const gate = GATED_CATEGORIES[name];
      return !gate || (jobLower ? gate.test(jobLower) : false);
    };
    const famSkills = (bank.skills || {})[family] || {};
    const exact = (obj, name) =>
      Object.keys(obj || {}).find((k) => k.toLowerCase() === String(name).toLowerCase().trim());
    const picked = {};
    for (const raw of skillCategories) {
      let key = exact(famSkills, raw);
      let value = key ? famSkills[key] : undefined;
      for (const alt of key ? [] : ALIASES[raw] || []) {
        const k = exact(famSkills, alt);
        if (k) { key = k; value = famSkills[k]; break; }
      }
      for (const other of key ? [] : Object.values(bank.skills || {})) {
        const k = exact(other, raw);
        if (k) { key = k; value = other[k]; break; }
      }
      if (!key) {
        // Last resort, the old behaviour: a near-miss spelling in this family.
        const w = String(raw).toLowerCase().trim();
        const k = Object.keys(famSkills).find((x) => x.toLowerCase().includes(w) || w.includes(x.toLowerCase()));
        if (k) { key = k; value = famSkills[k]; }
      }
      if (key && value && !(key in picked) && gateOk(key)) picked[key] = value;
    }
    // A floor, not a fallback to everything: under three lines reads as a thin
    // skill set, and the whole family reads as everything ever touched.
    // allSkills is already gate-filtered, so the top-up respects the gate.
    if (Object.keys(picked).length < 3) {
      for (const [k, v] of Object.entries(allSkills)) {
        if (Object.keys(picked).length >= 4) break;
        if (!(k in picked)) picked[k] = v;
      }
    }
    if (Object.keys(picked).length) skills = picked;
  }

  return {
    profile: bank.profile,
    // No summary. It is the one place a resume states its own theme ("engineer
    // who ships fast systems"), the pattern StoryScope found most reliably in
    // generated text (narrator states the theme: 77% AI, 52% human). It was on
    // every one of 271 sent resumes, so it could not be tested against the
    // rejections, and the candidate cut it from both referral resumes by hand.
    // The text stays in the bank; summaries are just no longer rendered.
    education: bank.education,
    skills,
    experience,
    projects: ranked,
    spareProjects,
    minProjectBullets: bank.render?.min_project_bullets ?? null,
    family,
  };
}

/**
 * The fabrication check. Every rendered string must appear verbatim in the bank.
 * This is belt-and-braces — rendering already only emits bank text — but it is
 * the assertion that would catch a future refactor quietly introducing
 * model-authored prose.
 */
export function verifyNoFabrication(rendered, bank) {
  const approved = new Set();
  for (const s of Object.values(bank.summaries || {}))
    approved.add(String(s).trim());
  for (const exp of bank.experience || [])
    for (const b of exp.bullets || []) approved.add(b.text.trim());
  for (const prj of bank.projects || [])
    for (const b of prj.bullets || []) approved.add(b.text.trim());

  const violations = [];
  if (rendered.summary && !approved.has(String(rendered.summary).trim())) {
    violations.push({
      field: "summary",
      text: String(rendered.summary).slice(0, 80),
    });
  }
  for (const exp of rendered.experience || []) {
    for (const t of exp.bullets) {
      if (!approved.has(String(t).trim()))
        violations.push({
          field: `experience:${exp.company}`,
          text: t.slice(0, 80),
        });
    }
  }
  // Spare projects are checked too: renderPdf may put them on the page.
  for (const prj of [...(rendered.projects || []), ...(rendered.spareProjects || [])]) {
    for (const t of prj.bullets) {
      if (!approved.has(String(t).trim()))
        violations.push({ field: `project:${prj.name}`, text: t.slice(0, 80) });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Cache key for a selection: the job text plus the bank content.
 *
 * Re-rendering the approved queue re-tailors every job, which means an LLM call
 * per job per run even when neither the posting nor the bullet bank has changed.
 * Four runs over a twelve-job queue is forty-eight calls to do twelve jobs' work.
 * A selection is a pure function of (posting, bank, prompt, MODEL), so it is safe
 * to reuse only when all four are identical. The SYSTEM prompt is in the hash so
 * editing the prompt invalidates every entry.
 *
 * The model belongs in the key and its absence was a real bug: a selection made
 * by qwen2.5:7b returning four ids is not interchangeable with one from Sonnet
 * returning twenty-two. Without the model in the key, switching providers would
 * have silently reused every 7B selection and made zero calls to the model that
 * was just paid for — the upgrade would have appeared to work and changed
 * nothing.
 */
// Bump when the user-message template changes. SYSTEM is hashed below, but the
// per-job template is assembled inline and is not — so a change to it would
// otherwise reuse selections made under the old wording, which is what happened
// when the rationale cap was added and every job came back "cached".
// 5: the catalogue now labels employers vs projects and lists the skill
// category names, and the closing instruction asks for skillCategories. A
// selection cached under the old prompt was produced without any of that, so
// reusing it would keep serving resumes with an empty projects section and a
// crowded skills block long after the fix.
const PROMPT_VERSION = 8;

export function selectionKey(job, bank, { provider, model } = {}) {
  const h = createHash("sha256");
  h.update(String(PROMPT_VERSION));
  h.update(String(job.title || ""));
  h.update(String(job.description || ""));
  h.update(SYSTEM);
  h.update(JSON.stringify(bank));
  h.update(String(provider ?? process.env.LLM_PROVIDER ?? ""));
  h.update(String(model ?? process.env.LLM_MODEL ?? ""));
  return h.digest("hex").slice(0, 32);
}

export async function tailorForJob(job, bank, opts = {}) {
  // A caller may hand us a previously computed selection for this exact
  // (posting, bank, prompt) triple. Reusing it skips the model entirely.
  const selection = opts.cachedSelection || (await selectBullets(job, bank, opts));
  // A revision's exclusions travel with the selection, so re-rendering a cached
  // selection later cannot top the removed lines back in.
  if (opts.avoidIds?.length) selection.avoidIds = opts.avoidIds;

  /**
   * Fall back to the SCREEN's family before falling back to swe.
   *
   * renderResume resolves an absent family as `summaries?.[family] || summaries.swe`,
   * so a job with no family silently became a software-engineering resume. That is
   * not hypothetical: twelve applications went out unscored — approved straight from
   * the queue, so llmScore never existed — and four of them were AI roles that the
   * deterministic title classifier had already labelled `ai`. Cengage AI/ML Engineer,
   * Altera AI Engineer, Leidos AI Engineer and Allstate Applied ML Engineer all
   * received the generic variant while the right answer sat unread on the same
   * document.
   *
   * classifyRoleFamily is free, deterministic and ran at ingest. Preferring the
   * model's judgement when it exists and the screen's when it does not costs nothing
   * and is right far more often than a hardcoded default.
   */
  if (!selection.family && job.screen?.roleFamily) {
    selection.family = job.screen.roleFamily;
    selection.familySource = "screen";
  }
  // Pass the posting through so top-up ranks by relevance rather than bank order.
  // Without this the render options decide three quarters of the resume with no
  // knowledge of the job it is for.
  // The selector's skill categories have to be handed over explicitly. They
  // never were: every sent resume printed the family's full 6-7 skill lines,
  // "CS Fundamentals" included, whatever the selector chose.
  const rendered = renderResume(bank, selection, {
    jobText: [job.title, job.description].filter(Boolean).join("\n"),
    skillCategories: selection.skillCategories,
    exclude: selection.avoidIds,
    ...opts.render,
  });
  const check = verifyNoFabrication(rendered, bank);
  if (!check.ok) {
    throw new Error(
      `fabrication check failed: ${JSON.stringify(check.violations.slice(0, 2))}`,
    );
  }
  return { selection, rendered, check };
}
