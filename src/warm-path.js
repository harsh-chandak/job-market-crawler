/**
 * Warm path: attach a person to an application.
 *
 * 286 applications went out through company job boards with nobody attached,
 * and none reached an interview; the one referred application came through a
 * person. JobFinderOS's author measured the same over a five-month search:
 * cold applications reached a screen 12% of the time and every loss was cold.
 *
 * This module holds the rules that keep "find a person" from turning into
 * spam: named people only, at most 3 new people a day and 10 a week, one
 * unanswered thread per company, at most two follow-ups at least a week apart.
 * Nothing here sends a message. People are found in an interactive Claude
 * session (the warm-path skill) and recorded through scripts/warm-path.mjs.
 *
 * Doctrine adapted from JobFinderOS (github.com/matthewprice/JobFinderOS,
 * MIT License, (c) 2026 Matthew Price), recruiter_playbook.md sections 2, 3.1, 4.
 */
import { normCompany } from "./util/normalize.js";

const DAY = 864e5;

export const CAPS = Object.freeze({
  newPerDay: 3,
  newPerWeek: 10,
  maxBumps: 2,
  minDaysBetweenTouches: 7,
  bumpAfterDays: 8,
  parkDays: 30,
});
export const WARM_TARGET = 0.7;
export const VERDICTS = ["warm_active", "warm_reachable", "cold"];
export const RUNGS = [
  "connection",
  "alumni",
  "colleague",
  "hiring_manager",
  "recruiter",
  "peer",
];
export const TOUCH_KINDS = [
  "outreach",
  "bump",
  "reply",
  "call",
  "referral",
  "declined",
  "park",
];

export const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
export const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);

/**
 * One key per employer, whatever the source spells it as. A job's board token
 * ("gevernova"), its display name ("GE Vernova") and a LinkedIn export's company
 * ("GE Vernova Inc.") must meet, or a connection at the company never shows.
 */
export function companyKey(s) {
  return normCompany(String(s || "")).replace(/[^a-z0-9]/g, "");
}
export function jobCompanyKeys(job) {
  return [
    ...new Set(
      [job?.companyName, job?.companyToken, job?.companyNorm]
        .filter(Boolean)
        .map(companyKey)
        .filter(Boolean),
    ),
  ];
}
export function nameNorm(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Schools and former employers from the bullet bank: the alumni and colleague rungs. */
export function ladderTerms(bank) {
  const schools = (bank?.education || []).map((e) => e.school).filter(Boolean);
  const employers = [];
  for (const e of bank?.experience || []) {
    const c = String(e.company || "");
    const main = c
      .replace(/\(.*?\)/g, "")
      .replace(/\b(pvt|private|ltd|limited|inc|llc)\b\.?/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (main) employers.push(main);
    // "Example Corp (the platform, AI College-Counseling Platform)": the platform is the name
    // people put on LinkedIn; the description after the comma is not a company.
    const inner = /\(([^)]*)\)/.exec(c)?.[1]?.split(",")[0]?.trim();
    if (
      inner &&
      inner.split(/\s+/).length <= 3 &&
      !/platform|counsel/i.test(inner)
    )
      employers.push(inner);
  }
  const uniq = (a) => [...new Map(a.map((x) => [x.toLowerCase(), x])).values()];
  const schoolSet = new Set(schools.map((s) => s.toLowerCase()));
  return {
    schools: uniq(schools),
    employers: uniq(employers.filter((e) => !schoolSet.has(e.toLowerCase()))),
  };
}

/**
 * Search links for the candidate to open himself. Nothing here fetches them:
 * LinkedIn's terms forbid scraping, and a people search is two minutes of his
 * own homework, not something to automate.
 */
export function searchLinks(company, terms) {
  const li = (kw) =>
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`;
  const g = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const out = [];
  for (const s of terms.schools)
    out.push({
      rung: "alumni",
      label: `${s} alumni at ${company}`,
      url: li(`${company} ${s}`),
    });
  for (const e of terms.employers)
    out.push({
      rung: "colleague",
      label: `former ${e} people at ${company}`,
      url: li(`${company} ${e}`),
    });
  out.push({
    rung: "recruiter",
    label: `${company} technical / university recruiters`,
    url: li(`${company} technical recruiter`),
  });
  if (terms.schools[0])
    out.push({
      rung: "alumni",
      label: `Google: public profiles, ${company} + ${terms.schools[0]}`,
      url: g(`site:linkedin.com/in "${company}" "${terms.schools[0]}"`),
    });
  return out;
}

/**
 * The shape a warm-path finding must have before it is recorded. "Probably
 * knows someone" is cold: every person is a full name on a named rung, and
 * anyone found by search carries the page they were found on.
 */
export function validateRecord(input) {
  const errors = [];
  const verdict = input?.verdict;
  if (!VERDICTS.includes(verdict))
    errors.push(`verdict must be one of: ${VERDICTS.join(", ")}`);
  const people = [];
  for (const [i, p] of (Array.isArray(input?.people)
    ? input.people
    : []
  ).entries()) {
    const name = String(p?.name || "")
      .replace(/\s+/g, " ")
      .trim();
    const tag = `people[${i}]${name ? ` ${name}` : ""}`;
    if (name.split(" ").length < 2) {
      errors.push(`${tag}: a full name (first and last) is required`);
      continue;
    }
    if (!RUNGS.includes(p.rung)) {
      errors.push(`${tag}: rung must be one of: ${RUNGS.join(", ")}`);
      continue;
    }
    const linkedin = p.linkedin ? String(p.linkedin).trim() : null;
    const source = p.source ? String(p.source).trim() : null;
    if (
      linkedin &&
      !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/\s]+/i.test(linkedin)
    )
      errors.push(
        `${tag}: linkedin must be a https://www.linkedin.com/in/... profile URL`,
      );
    if (source && !/^https?:\/\/\S+$/.test(source))
      errors.push(`${tag}: source must be a URL`);
    if (
      ["hiring_manager", "recruiter", "peer"].includes(p.rung) &&
      !linkedin &&
      !source
    )
      errors.push(
        `${tag}: a ${p.rung} needs a LinkedIn profile or the URL they were found on`,
      );
    people.push({
      name,
      rung: p.rung,
      title: p.title ? String(p.title).slice(0, 120) : null,
      linkedin,
      source,
      route: p.route ? String(p.route).slice(0, 200) : null,
    });
  }
  if (verdict === "warm_reachable" && !people.length)
    errors.push("warm_reachable needs at least one named person");
  if (verdict === "warm_active" && !people.length)
    errors.push("warm_active needs the person already talking with you");
  return {
    ok: errors.length === 0,
    errors,
    record: {
      verdict,
      people,
      closingWindow: input?.closingWindow
        ? String(input.closingWindow).slice(0, 200)
        : null,
      notes: input?.notes ? String(input.notes).slice(0, 500) : null,
    },
  };
}

/** Outreach and application dates for a verdict. nextAllowed pushes day 0 past a full cap. */
export function planDates(
  verdict,
  now = new Date(),
  { nextAllowed = null, closingWindow = null, applied = false } = {},
) {
  const today = startOfDay(now);
  const day0 =
    nextAllowed && nextAllowed > today ? startOfDay(nextAllowed) : today;
  if (applied) {
    if (verdict === "cold")
      return {
        recheckOn: addDays(today, 14),
        note: "Already applied and nobody found. Look again in 14 days.",
      };
    if (verdict === "warm_active")
      return {
        note: "Already applied and already talking with someone there. Tell them the application is in.",
      };
    return {
      outreachOn: day0,
      bumpOn: addDays(day0, CAPS.bumpAfterDays),
      note: "Already applied. A note to this person now can still pull the application out of the pile.",
    };
  }
  if (verdict === "warm_active")
    return {
      applyBy: addDays(today, 2),
      note: "Someone is already talking with you about this role. Apply within 2 days, or when they say to.",
    };
  if (verdict === "cold")
    return {
      applyBy: today,
      recheckOn: addDays(today, 14),
      note: "Nobody found. Apply, logged as cold, and look for a person again in 14 days.",
    };
  if (closingWindow)
    return {
      outreachOn: today,
      applyBy: today,
      bumpOn: addDays(today, CAPS.bumpAfterDays),
      note: `Closing window (${closingWindow}): apply now and reach out in parallel.`,
    };
  return {
    outreachOn: day0,
    applyAfter: addDays(day0, 2),
    applyBy: addDays(day0, 3),
    bumpOn: addDays(day0, CAPS.bumpAfterDays),
    note: "Reach out first and apply 2 to 3 days later whether or not they answer, so a mention can land before the resume. If silent after a week, one follow-up with a new angle.",
  };
}

/** Where the outreach caps stand, overall and for one employer. */
export function capsStatus(contacts, now = new Date(), companyKeys = null) {
  const today = startOfDay(now);
  const windowStart = addDays(today, -6);
  const firsts = contacts
    .map((c) => (c.firstTouchAt ? new Date(c.firstTouchAt) : null))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const newToday = firsts.filter((x) => x >= today).length;
  const inWeek = firsts.filter((x) => x >= windowStart);
  let nextAllowed = today;
  if (newToday >= CAPS.newPerDay) nextAllowed = addDays(today, 1);
  if (inWeek.length >= CAPS.newPerWeek) {
    // The day enough of this week's first messages age out to make room for one more.
    const agesOut = addDays(
      startOfDay(inWeek[inWeek.length - CAPS.newPerWeek]),
      7,
    );
    if (agesOut > nextAllowed) nextAllowed = agesOut;
  }
  const keys = companyKeys ? new Set(companyKeys) : null;
  const openThreads = contacts.filter(
    (c) =>
      c.status === "contacted" &&
      c.lastTouchAt &&
      now - new Date(c.lastTouchAt) < CAPS.parkDays * DAY &&
      (!keys || keys.has(c.companyKey)),
  );
  return {
    newToday,
    newThisWeek: inWeek.length,
    perDay: CAPS.newPerDay,
    perWeek: CAPS.newPerWeek,
    nextAllowed,
    openThreads,
    blockedByThread: keys ? openThreads[0] || null : null,
  };
}

/** Record one touch on a contact and say which rule, if any, it bends. */
export function applyTouch(contact, kind, at = new Date(), note = null) {
  if (!TOUCH_KINDS.includes(kind))
    throw new Error(`--kind must be one of: ${TOUCH_KINDS.join(", ")}`);
  const prior = contact.touches || [];
  const isMessage = (k) => k === "outreach" || k === "bump";
  const warnings = [];
  const lastMsg = prior
    .filter((t) => isMessage(t.kind))
    .map((t) => new Date(t.at))
    .sort((a, b) => b - a)[0];
  if (
    isMessage(kind) &&
    lastMsg &&
    at - lastMsg < CAPS.minDaysBetweenTouches * DAY
  )
    warnings.push(
      `only ${Math.floor((at - lastMsg) / DAY)} day(s) since the last message to ${contact.name}; wait at least ${CAPS.minDaysBetweenTouches}`,
    );
  if (kind === "outreach" && prior.some((t) => isMessage(t.kind)))
    warnings.push(
      `${contact.name} was already messaged; a second message is a follow-up (--kind bump)`,
    );
  if (kind === "bump" && !prior.some((t) => isMessage(t.kind)))
    warnings.push(
      `no first message to ${contact.name} is recorded; this is outreach, not a follow-up`,
    );
  const bumps =
    prior.filter((t) => t.kind === "bump").length + (kind === "bump" ? 1 : 0);
  if (kind === "bump" && bumps > CAPS.maxBumps)
    warnings.push(
      `that is follow-up ${bumps}; the limit is ${CAPS.maxBumps}, then leave it ${CAPS.parkDays} days`,
    );

  let status = contact.status || "not_contacted";
  let nextTouchAt = contact.nextTouchAt || null;
  if (isMessage(kind)) {
    status = "contacted";
    nextTouchAt =
      bumps >= CAPS.maxBumps
        ? addDays(at, CAPS.parkDays)
        : addDays(at, CAPS.bumpAfterDays);
  } else if (kind === "reply" || kind === "call") {
    status = "replied";
    nextTouchAt = null;
  } else if (kind === "referral") {
    status = "referred";
    nextTouchAt = null;
  } else if (kind === "declined") {
    status = "declined";
    nextTouchAt = null;
  } else if (kind === "park") {
    status = "parked";
    nextTouchAt = addDays(at, CAPS.parkDays);
  }
  return {
    touches: [...prior, { kind, at, note }],
    status,
    firstTouchAt: contact.firstTouchAt || (isMessage(kind) ? at : null),
    lastTouchAt: isMessage(kind) ? at : contact.lastTouchAt || null,
    nextTouchAt,
    warnings,
  };
}

/**
 * Was a person attached when the application went in?
 *   referral          someone referred it
 *   warm_active       already talking with someone there, recorded before applying
 *   contacted_before  messaged someone there before applying
 *   contacted_after   messaged someone only after applying (a rescue)
 *   cold              nobody
 */
export function attachedAtApply(job, contactsAtCompany = []) {
  const at = job?.submitAttemptAt ? new Date(job.submitAttemptAt) : null;
  if (job?.referral) return "referral";
  const wp = job?.warmPath;
  if (
    wp?.verdict === "warm_active" &&
    (!at || !wp.recordedAt || new Date(wp.recordedAt) <= at)
  )
    return "warm_active";
  const firsts = contactsAtCompany
    .map((c) => (c.firstTouchAt ? new Date(c.firstTouchAt) : null))
    .filter(Boolean);
  if (at && firsts.some((f) => f <= at)) return "contacted_before";
  if (firsts.length) return "contacted_after";
  return "cold";
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const s = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * LinkedIn's Connections.csv (Settings > Data privacy > Get a copy of your
 * data). It opens with a few lines of notes before the header row. Email
 * addresses are left out on purpose: nothing here needs them.
 */
export function parseLinkedInConnections(text) {
  const rows = parseCsv(text);
  const h = rows.findIndex(
    (r) =>
      r.some((c) => /^first name$/i.test(c.trim())) &&
      r.some((c) => /^company$/i.test(c.trim())),
  );
  if (h < 0)
    throw new Error(
      "no 'First Name, ..., Company' header row: is this LinkedIn's Connections.csv?",
    );
  const header = rows[h].map((c) => c.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const first = (r[col("first name")] || "").trim();
    const last = (r[col("last name")] || "").trim();
    const company = (r[col("company")] || "").trim();
    if (!first || !company) continue;
    out.push({
      name: `${first} ${last}`.trim(),
      company,
      title: (r[col("position")] || "").trim() || null,
      linkedin: (r[col("url")] || "").trim() || null,
      connectedOn: (r[col("connected on")] || "").trim() || null,
    });
  }
  return out;
}

/** One line for the apply scripts: where the warm path stands, or a nudge to check it. */
export function warmPathLine(job, now = new Date()) {
  const co = job?.companyName || job?.companyToken;
  if (job?.referral) return `  warm path: referred${job.referral.by ? ` by ${job.referral.by}` : ""}`;
  const wp = job?.warmPath;
  if (!wp) return (job?.llmScore?.fit ?? 0) >= 70 ? `  warm path: not checked. Find a person first: /warm-path ${co} in Claude Code` : null;
  const names = (wp.people || []).map((p) => p.name).join(", ");
  const wait = wp.plan?.applyAfter && new Date(wp.plan.applyAfter) > now ? ` · planned: apply after ${new Date(wp.plan.applyAfter).toDateString()}` : "";
  return `  warm path: ${wp.verdict.replace("_", " ")}${names ? ` (${names})` : ""}${wait}`;
}
