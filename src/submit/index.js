/**
 * ATS form submission via Playwright.
 *
 * SAFETY MODEL — read before changing anything here.
 *
 * `dryRun` defaults to TRUE and every entry point must pass `dryRun: false`
 * explicitly to actually submit. A dry run fills the form exactly as a real run
 * would, screenshots it, and stops immediately before the submit control. That
 * makes the filled form reviewable without an irreversible side effect.
 *
 * Reasons this is not merely cautious:
 *   - An application cannot be recalled. A wrong one burns that company for the
 *     candidate, and there is no second first impression.
 *   - Work-authorization answers are legal assertions on a signed application,
 *     sitting alongside a live visa process. They come from data/answers.yaml,
 *     confirmed by the candidate, and are never inferred or "optimised".
 *   - CAPTCHAs are detected and abort the run. They are never solved or worked
 *     around; the job is handed back for manual completion.
 *
 * Greenhouse and Lever are ~90% identical across companies, which is why these
 * two adapters cover most of the queue.
 */

import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { modelMayAnswer, chooseFormAnswers } from "../form-ai.js";

/**
 * CAPTCHA detection.
 *
 * The distinction that matters: Greenhouse embeds an INVISIBLE reCAPTCHA badge
 * on essentially every board. It is scored in the background and normally never
 * shows a challenge. Treating the badge as a blocker aborts every Greenhouse
 * application — the tool's largest source — for something the user would never
 * have been asked to solve.
 *
 * A real challenge is a separate, VISIBLE frame: reCAPTCHA renders it in a
 * `bframe`, hCaptcha and Turnstile in their own visible widgets. Only those
 * stop the run, and they are handed back for manual completion — never solved
 * or circumvented.
 */
const CHALLENGE_SELECTORS = [
  'iframe[src*="recaptcha/api2/bframe"]',
  'iframe[src*="recaptcha/enterprise/bframe"]',
  'iframe[src*="hcaptcha"][src*="challenge"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha:not([data-size="invisible"])',
  ".h-captcha",
];

export const CAPTCHA_SELECTORS = CHALLENGE_SELECTORS;

export async function detectCaptcha(page) {
  for (const sel of CHALLENGE_SELECTORS) {
    const el = await page.$(sel);
    if (!el) continue;
    // Presence is not enough — the challenge frame exists but stays hidden
    // until reCAPTCHA actually decides to ask.
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 60 || box.height < 60) continue;
    return sel;
  }
  return null;
}

/** Field aliases seen across Greenhouse/Lever/Ashby instances. */
/**
 * Custom-question fields keyed by the label they show, not by a field name.
 *
 * Everything here comes from data/answers.yaml and was previously unused. The
 * order matters: the more specific pattern has to come first, or "Preferred First
 * Name" is answered by the rule meant for "First Name".
 *
 * `decline: true` marks the EEO questions, and ONLY those. It permits the
 * decline-equivalence tier in matchOption — see isDeclineOption for why that is
 * not a guess. No factual field carries it.
 */
function educationAnswers(a) {
  const id = a.identity || {};
  const ed = (a.education || [])[0] || {};
  const eeo = a.eeo || {};
  const pref = a.preferences || {};
  const gradYear = String(ed.end || "").slice(0, 4);
  return [
    // Education
    {
      re: /^school|university|college|institution/i,
      value: ed.school,
      key: "school",
    },
    { re: /degree/i, value: ed.degree, key: "degree" },
    {
      // "major" is anchored deliberately. Unanchored, it matched "major life
      // activities" inside Roblox's 256-character disability question and
      // claimed that control — so the disability question was answered by the
      // field-of-study rule (with "Computer Science") and the EEO rule found
      // nothing left to answer. Patterns here select which box a value is typed
      // into, so a loose one is a wrong-value bug, not a missed-field bug.
      re: /field of study|^major\b|discipline|concentration/i,
      value: ed.field,
      key: "field",
    },
    { re: /gpa/i, value: ed.gpa != null ? String(ed.gpa) : null, key: "gpa" },
    {
      re: /graduation (date|year)|expected grad/i,
      value: gradYear,
      key: "grad_year",
    },
    // Identity variants the name fields do not cover
    { re: /legal name/i, value: id.full_name, key: "legal_name" },
    {
      re: /preferred (first )?name/i,
      value: id.first_name,
      key: "preferred_name",
    },
    { re: /^country|country of residence/i, value: id.country, key: "country" },
    { re: /^city\b|^location\b/i, value: id.location || id.city, key: "city" },
    { re: /^state\b|province/i, value: id.state, key: "state" },
    // Preferences
    {
      re: /earliest (start|available)|when can you start|start date/i,
      value: pref.earliest_start,
      key: "earliest_start",
    },
    // EEO — the user's own stated answers, from the file, never inferred.
    //
    // ORDER IS LOAD-BEARING. "Do you identify as transgender?" contains the
    // substring "gender", so a /gender/i rule placed first answers the
    // transgender question with "Male". Every pattern below is anchored or
    // negated against the ones that follow it, and the tests pin the order.
    [/transgender/i, eeo.transgender],
    [/hispanic|latin/i, eeo.hispanic_latinx],
    [/\bgender\b(?!.*transgender)/i, eeo.gender],
    [/\brace\b|ethnicity/i, eeo.race ?? eeo.ethnicity],
    [/veteran/i, eeo.veteran_status],
    [/disability/i, eeo.disability],
  ].filter((r) => r.value != null && String(r.value).trim() !== "");
}

/**
 * Fill education, legal name, location and EEO — across text inputs, native
 * <select>, and react-select comboboxes.
 *
 * A choice control is tried FIRST and the text path is only a fallback, because
 * typing into a react-select search box looks like it worked (the characters
 * appear) while committing nothing: react-select holds the typed string as a
 * filter, not a value, so the field submits empty. That is the single worst
 * outcome available here — it reports success and sends a blank answer — and it
 * is what the location field was doing on this exact form before this change.
 */
async function fillEducationAndEeo(page, answers, filled, notes, controls) {
  const ctls = controls || (await enumerateControls(page));
  for (const rule of educationAnswers(answers)) {
    const label = rule.key;
    try {
      // Work-authorization questions belong to answerAuthQuestions, which sources
      // them from the confirmed values in AUTH_QUESTIONS. Never answer one here.
      //
      // The length cap is a second line of defence behind the anchored patterns:
      // "School", "Degree", "Cumulative GPA" are field names a few words long,
      // while a paragraph-length label is a screening question that happens to
      // contain one of those words. EEO rules are exempt because their labels
      // genuinely are long questions ("Do you have a disability or chronic
      // condition (physical, visual, ...)" runs to 256 characters).
      const maxLabel = rule.decline ? Infinity : 120;
      const ctl = ctls.find(
        (c) =>
          !c.handled &&
          c.label.length <= maxLabel &&
          rule.re.test(c.label) &&
          !AUTH_QUESTIONS.some((q) => q.re.test(c.label)),
      );
      if (ctl) {
        ctl.handled = true;
        const res = await setChoice(page, ctl, String(rule.value), {
          decline: rule.decline === true,
        });
        if (res.value) {
          filled.push({
            field: `edu:${label}`,
            value: res.value,
            how: res.how,
          });
        } else {
          // No option genuinely matched. Leaving it blank is correct: a wrong
          // value on a submitted application cannot be taken back, and the
          // unfilledRequired gate will surface it for the human.
          notes.push(`edu:${label} not answered — ${res.reason}`);
        }
        continue;
      }
      await fillByLabel(
        page,
        rule.re,
        String(rule.value),
        filled,
        `edu:${label}`,
      );
    } catch (e) {
      notes.push(
        `could not answer ${label}: ${String(e.message).slice(0, 50)}`,
      );
    }
  }
}

const FIELD_MAP = {
  first_name: [
    'input[name="first_name"]',
    'input[name="firstName"]',
    "#first_name",
    'input[autocomplete="given-name"]',
  ],
  last_name: [
    'input[name="last_name"]',
    'input[name="lastName"]',
    "#last_name",
    'input[autocomplete="family-name"]',
  ],
  // Ashby names its system fields `_systemfield_*` and uses ONE combined Name
  // input where Greenhouse uses first_name/last_name. Without this the name is
  // simply never filled — and Ashby carries 32 of the top-59 apply queue, so
  // every one of those submissions would have been blocked on a required field.
  full_name: [
    'input[name="name"]',
    "#name",
    'input[autocomplete="name"]',
    "#_systemfield_name",
    'input[name="_systemfield_name"]',
  ],
  email: [
    "#_systemfield_email",
    'input[name="email"]',
    "#email",
    'input[type="email"]',
    'input[autocomplete="email"]',
  ],
  phone: [
    "#_systemfield_phone",
    'input[name="phone"]',
    "#phone",
    'input[type="tel"]',
    'input[autocomplete="tel"]',
  ],
  location: [
    'input[name="location"]',
    "#location",
    'input[name="candidate-location"]',
  ],
  linkedin: [
    'input[name*="linkedin" i]',
    'input[name="urls[LinkedIn]"]',
    'input[placeholder*="linkedin" i]',
  ],
  website: [
    'input[name*="website" i]',
    'input[name="urls[Website]"]',
    'input[name*="portfolio" i]',
  ],
  github: ['input[name*="github" i]', 'input[name="urls[GitHub]"]'],
};

async function fillFirstMatch(page, selectors, value, filled, label) {
  if (value == null || value === "") return false;
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    try {
      await el.fill(String(value), { timeout: 5000 });
      filled.push({ field: label, selector: sel });
      return true;
    } catch {
      /* try the next alias */
    }
  }
  return false;
}

/**
 * Work-authorization questions are asked with wildly varying wording. Match on
 * the question text rather than the field name, and answer ONLY from the
 * confirmed values — never guess, and never leave one silently blank, since a
 * blank here is usually a hard validation stop anyway.
 */

/**
 * Choose an option from a combobox.
 *
 * Greenhouse's current form has ZERO native <select> elements — every dropdown
 * is an input[role=combobox] backed by a listbox. The select and radio paths
 * below therefore never fired on it, which meant the two work-authorization
 * questions went unanswered on every Greenhouse application. Those are the most
 * consequential questions on the form, so this is not a cosmetic gap.
 *
 * Returns {value, how} for a genuine match, or {reason} explaining why nothing
 * was chosen. Never guesses, because a wrong answer to a sponsorship question is
 * a misrepresentation on a signed application, not a bad UX outcome.
 */
async function pickFromCombobox(page, input, wanted, opts = {}) {
  try {
    const before = await comboboxValue(page, input);
    await input.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await input.click({ timeout: 3000 });

    // Scope the option search to the listbox THIS combobox owns.
    //
    // Querying [role="option"] page-wide is wrong and was actively dangerous:
    // Greenhouse renders react-select, and a full application form has 246
    // option elements across Country, School, Degree and the rest. A global
    // query happily clicked a matching "Yes" belonging to a different question,
    // reported success, and left the authorization field empty — the worst
    // possible outcome, since it both fails to answer and claims it did.
    //
    // aria-controls only appears once the menu has been opened at least once,
    // so it is read AFTER the click, never before.
    const listIdOf = async () =>
      (await input.getAttribute("aria-controls")) ||
      (await input.getAttribute("aria-owns"));
    let listId = await listIdOf();
    if (!listId) {
      await page.waitForTimeout(300);
      listId = await listIdOf();
    }
    if (!listId) return { reason: "combobox exposes no listbox" };
    const scope = `#${CSS_escape(listId)} [role="option"]`;

    /**
     * Poll for options instead of sleeping a fixed interval.
     *
     * aria-expanded flips to true immediately but the options render ~100ms
     * later, and the geo-backed Location list is a network round trip. A fixed
     * wait therefore reads an empty list and reports "no options rendered" for
     * a dropdown that is merely slow — indistinguishable, in the notes, from a
     * dropdown that genuinely lacks the answer.
     */
    const readOptions = async (waitMs) => {
      const deadline = Date.now() + waitMs;
      let handles = [];
      for (;;) {
        handles = await page.$$(scope);
        if (handles.length || Date.now() > deadline) break;
        await page.waitForTimeout(100);
      }
      const texts = [];
      for (const h of handles) {
        texts.push(((await h.innerText().catch(() => "")) || "").trim());
      }
      return { handles, texts };
    };

    let { handles, texts } = await readOptions(1500);
    if (!handles.length) {
      // The click may have toggled a menu that was already open, or the control
      // re-rendered under us when an earlier field was answered. Try once more.
      await input.click({ timeout: 3000 }).catch(() => {});
      ({ handles, texts } = await readOptions(1500));
    }
    let m = matchOption(texts, wanted, opts);

    // Long lists are virtualised: School renders only its first 100 of ~5,000
    // entries, so "Arizona State University" is genuinely absent from the DOM
    // until typing narrows it. Type ONLY after the full list has been searched,
    // so a short list is never needlessly filtered down to nothing.
    if (m.index < 0) {
      await input.fill(String(wanted).slice(0, 60)).catch(() => {});
      const filtered = await readOptions(2500);
      const m2 = matchOption(filtered.texts, wanted, opts);
      if (m2.index >= 0) {
        handles = filtered.handles;
        texts = filtered.texts;
        m = m2;
      } else {
        // Restore the box to exactly how it was found. A leftover filter string
        // is not a value, but it looks like one to a human reviewing the
        // screenshot, and on some widgets it commits on blur.
        await input.fill("").catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
        return { reason: m.reason || m2.reason };
      }
    }

    const chosen = texts[m.index];
    await handles[m.index].click({ timeout: 3000 });
    await page.waitForTimeout(300);

    // Verify it stuck. react-select keeps the search input empty and renders the
    // choice as text, so reading input.value proves nothing.
    const shown = await comboboxValue(page, input);
    // Multi-selects keep the menu open after a pick.
    await page.keyboard.press("Escape").catch(() => {});

    // The rendered value is not always the full option text. Greenhouse's phone
    // Country control lists "United States +1" but renders the choice as a flag
    // plus "+1", so an equality check calls a correct selection a failure.
    //
    // Nor can "the display changed" be required. Filling the phone number as
    // +1 (480) ... makes that same control adopt United States on its own, so
    // selecting United States is a no-op: the value is right, the display never
    // changes, and demanding a change reports a correctly answered field as
    // failed. What is actually being verified is that the control ended up
    // displaying something consistent with the option that was clicked.
    const a = normOpt(shown);
    const c = normOpt(chosen);
    if (a && (c.includes(a) || a.includes(c))) {
      return { value: chosen, how: m.how };
    }
    if (!a && normOpt(before)) {
      return { reason: `"${chosen.slice(0, 30)}" cleared the previous value` };
    }
    return {
      reason: `clicked "${chosen.slice(0, 40)}" but it did not register`,
    };
  } catch (e) {
    return { reason: `combobox error: ${String(e.message).slice(0, 60)}` };
  }
}

/**
 * Normalise option text for comparison: case, whitespace, curly apostrophes,
 * the required-field asterisk and trailing punctuation. Nothing semantic.
 */
function normOpt(s) {
  return String(s ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\*/g, "")
    .trim()
    .replace(/[.,;:]+$/, "")
    .toLowerCase();
}

/** "United States +1" -> "United States". Greenhouse's country list carries dial codes. */
function stripDialCode(s) {
  return String(s)
    .replace(/\s*\+\d[\d\s()-]*$/, "")
    .trim();
}

/**
 * Is this text a refusal to answer, rather than an answer?
 *
 * Used ONLY for the EEO questions, and only when the value in answers.yaml is
 * itself a refusal. Every board words its refusal differently — the file says
 * "Decline To Self Identify", Roblox's list offers "I don't wish to answer" —
 * and treating those as the same answer is not a guess about the candidate: it
 * is the one option that asserts nothing about them, which is exactly what the
 * file asks for. No factual field is ever matched this way.
 *
 * "I prefer to self-describe" is deliberately excluded. It looks adjacent but is
 * the opposite: it opens a free-text box expecting a real answer.
 *
 * Note this tier rarely fires on a standard Greenhouse EEO block, where the
 * option text is literally "Decline To Self Identify" (tier 1) or begins with
 * "I do not want to answer" (tier 3). It exists for employer-authored questions
 * like Roblox's, which ask the same thing in their own words.
 */
function isDeclineOption(s) {
  const t = normOpt(s);
  if (!t) return false;
  // "…to self-describe" invites an answer; it is not a refusal to give one.
  if (/^(i\s+)?(prefer|choose|want|wish|like)\s+to\s+self/.test(t))
    return false;
  if (/^(i\s+)?self.?describe/.test(t)) return false;
  return /^(i\s+)?(prefer\s+not|do\s+not\s+wish|don't\s+wish|do\s+not\s+want|don't\s+want|decline|choose\s+not|do\s+not\s+choose|don't\s+choose)\b/.test(
    t,
  );
}

/**
 * Find the option that genuinely IS the intended answer, or nothing at all.
 *
 * Tiers run strictest-first and every tier requires a UNIQUE winner. Ambiguity
 * is treated as no match, because "closest" is precisely the failure this must
 * not have: filtering School by "Arizona State University" returns both
 * "Arizona State University" and "Arizona State University - West", and picking
 * the wrong one puts a false credential on a signed application.
 *
 * @returns {{index:number, how?:string, reason?:string}}
 */
function matchOption(texts, wanted, { decline = false } = {}) {
  const w = normOpt(wanted);
  if (!w) return { index: -1, reason: "no configured answer" };

  const usable = texts
    .map((t, i) => ({ t, i, n: normOpt(t) }))
    .filter((o) => o.n);
  if (!usable.length) return { index: -1, reason: "no options rendered" };

  const pick = (list, how) => {
    if (list.length === 1) return { index: list[0].i, how };
    if (list.length > 1) {
      return {
        index: -1,
        ambiguous: true,
        reason: `"${wanted}" matches ${list.length} options (${list
          .slice(0, 3)
          .map((o) => o.t)
          .join(" / ")
          .slice(0, 80)}) — refusing to choose`,
      };
    }
    return null;
  };

  // 1. Exact, after normalisation.
  let r = pick(
    usable.filter((o) => o.n === w),
    "exact",
  );
  if (r) return r;

  // 2. Exact once a trailing dial code is dropped: "United States +1".
  r = pick(
    usable.filter((o) => normOpt(stripDialCode(o.t)) === w),
    "exact-sans-dial-code",
  );
  if (r) return r;

  // 3. Unique whole-word prefix: "Yes" -> "Yes, I am authorized to work in the US".
  //    Unique is load-bearing; without it this tier picks ASU - West.
  const pre = new RegExp(`^${escapeRe(w)}\\b`);
  r = pick(
    usable.filter((o) => pre.test(o.n)),
    "unique-prefix",
  );
  if (r) return r;

  // 4. Refusal-to-answer equivalence, EEO questions only. See isDeclineOption.
  if (decline && isDeclineOption(wanted)) {
    r = pick(
      usable.filter((o) => isDeclineOption(o.t)),
      "decline-equivalent",
    );
    if (r) return r;
  }

  return {
    index: -1,
    reason: `no option matches "${String(wanted).slice(0, 40)}" (offered: ${usable
      .slice(0, 6)
      .map((o) => o.t)
      .join(" / ")
      .slice(0, 110)})`,
  };
}

/** What a react-select combobox is currently displaying, if anything. */
async function comboboxValue(page, input) {
  return input
    .evaluate((el) => {
      // Scope to the control this input belongs to.
      //
      // The original comment here was right that closest() on the input's own
      // wrapper (select__input-container) looks in the wrong subtree — but the
      // answer is to close on the CONTROL, not to walk six ancestors calling
      // querySelector at each. That walk searches whole subtrees, so past the
      // second level it reads neighbouring questions: this function verifies that
      // a value stuck after clicking, and it would confirm success by reading the
      // answer to a different question.
      const ctl = el.closest(
        '[class*="select__control"], [class*="react-select"], [class*="select__container"]',
      );
      const single = ctl?.querySelector(
        '[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]',
      );
      if (single?.textContent?.trim()) return single.textContent.trim();
      return (el.value || "").trim();
    })
    .catch(() => "");
}

/** CSS.escape is a browser API; ids here are simple enough to quote directly. */
function CSS_escape(id) {
  return String(id).replace(/([^\w-])/g, "\\$1");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AUTH_QUESTIONS = [
  {
    key: "requires_sponsorship",
    re: /sponsor|sponsorship|visa status|work visa|require.*(visa|sponsor)/i,
    // true => the answer to "will you require sponsorship" is Yes
    answerFor: (a) =>
      a.work_authorization.requires_sponsorship ? "yes" : "no",
  },
  {
    key: "country",
    re: /^country$|^country\s*\*?$/i,
    answerFor: (a) => a.identity.country || "United States",
  },
  {
    key: "authorized_to_work",
    re: /legally authorized|authorized to work|eligible to work|right to work/i,
    answerFor: (a) =>
      a.work_authorization.authorized_to_work_us ? "yes" : "no",
  },
];

/**
 * Answer the work-authorization questions by walking the CONTROLS, not the
 * containers.
 *
 * The original approach scanned `div, fieldset, li`, matched the question text
 * in the container, then looked for an input inside it. That failed on
 * Greenhouse for a dull reason: the scan is capped at 400 elements to bound the
 * cost, and on a React application form the authorization questions sit deeper
 * than that. The questions were simply never reached.
 *
 * Every control that matters carries an accessible label, so enumerate the
 * controls and read their labels instead. Bounded by the number of form fields
 * rather than the number of divs, which is smaller by two orders of magnitude
 * and does not depend on markup depth.
 */
export async function answerAuthQuestions(
  page,
  answers,
  filled,
  notes,
  controls,
) {
  const ctls = controls || (await enumerateControls(page));

  for (const ctl of ctls) {
    if (ctl.handled) continue;
    if (ctl.label.length < 8) continue;

    const q = AUTH_QUESTIONS.find((x) => x.re.test(ctl.label));
    if (!q) continue;
    if (filled.some((f) => f.field === q.key)) continue; // already answered
    ctl.handled = true;

    const want = q.answerFor(answers);
    const res = await setChoice(page, ctl, want, { decline: false });
    if (res.value)
      filled.push({ field: q.key, value: res.value, how: res.how });
    else
      notes.push(
        `could not answer "${q.key}" (wanted "${want}") — ${res.reason}`,
      );
  }
}

/**
 * Labels that mean "you are agreeing to something", not "here is a fact".
 *
 * Acknowledgements, consents and e-signatures are never auto-answered, no matter
 * how obvious the single available option looks. Roblox's form carries exactly
 * one such control — a required dropdown whose only option is "I acknowledge
 * that I have read and understood Roblox's Job Applicant Privacy Notice." — and
 * a matcher confident enough to pick the only option is precisely the thing that
 * must not agree to a legal notice on the candidate's behalf. Left blank, it
 * surfaces through unfilledRequired and the human accepts it themselves.
 */
const CONSENT_LIKE_RE =
  /acknowledg|consent|\bi agree\b|agree to|terms (and|&) conditions|privacy (notice|policy|statement)|e-?sign|electronic signature|authorize .* background check/i;

/**
 * Enumerate every choice control on the page with its accessible label, once.
 *
 * Sharing one pass between the auth and education/EEO fillers is what stops both
 * of them driving the same control: "Country*" is claimed by AUTH_QUESTIONS and
 * also matches the education table's /^country/, and answering it twice reopens
 * a committed dropdown for no reason.
 */
async function enumerateControls(page) {
  const els = await page.$$('select, [role="combobox"], fieldset');
  const out = [];
  for (const el of els) {
    let label = "";
    let id = null;
    try {
      id = await el.getAttribute("id");
      if (id) {
        const l = await page.$(`label[for="${id.replace(/"/g, '\\"')}"]`);
        if (l) label = (await l.innerText().catch(() => "")) || "";
      }
      if (!label) label = (await el.getAttribute("aria-label")) || "";
      if (!label) {
        const lg = await el.$("legend");
        if (lg) label = (await lg.innerText().catch(() => "")) || "";
      }
      if (!(await el.isVisible().catch(() => false))) continue;
    } catch {
      continue;
    }
    label = label.replace(/\s+/g, " ").trim();
    if (!label) continue;
    const tag = (
      await el.evaluate((n) => n.tagName).catch(() => "")
    ).toLowerCase();
    // Never auto-agree to anything.
    const handled = CONSENT_LIKE_RE.test(label);
    out.push({ el, label, tag, id, handled });
  }
  return out;
}

/**
 * Set one choice control to `wanted`, or leave it untouched and say why.
 *
 * Covers all three shapes an ATS uses for the same question: native <select>,
 * a radio/checkbox fieldset, and a react-select combobox. Every one of them
 * routes through matchOption, so "never pick the closest option" is enforced in
 * one place rather than three.
 *
 * @returns {{value?:string, how?:string, reason?:string}}
 */
async function setChoice(page, ctl, wanted, { decline = false } = {}) {
  const { el, tag } = ctl;
  if (wanted == null || String(wanted).trim() === "")
    return { reason: "no configured answer" };

  if (tag === "select") {
    const opts = await el.$$eval("option", (os) =>
      os.map((o) => ({
        value: o.value,
        label: (o.textContent || "").trim(),
        disabled: o.disabled,
      })),
    );
    // Drop the placeholder row so it can never be "matched" or counted.
    const real = opts.filter(
      (o) =>
        !o.disabled &&
        o.value !== "" &&
        !/^(select|choose|--|please select)/i.test(o.label),
    );
    const m = matchOption(
      real.map((o) => o.label),
      wanted,
      { decline },
    );
    if (m.index < 0) return { reason: m.reason };
    const hit = real[m.index];
    try {
      await el.selectOption({ value: hit.value }, { timeout: 4000 });
    } catch {
      return { reason: `select rejected "${hit.label.slice(0, 40)}"` };
    }
    const now = await el.evaluate((n) => n.value).catch(() => "");
    if (String(now) !== String(hit.value))
      return {
        reason: `selected "${hit.label.slice(0, 30)}" but it did not stick`,
      };
    return { value: hit.label, how: m.how };
  }

  if (tag === "fieldset") {
    const radios = await el.$$('input[type="radio"], input[type="checkbox"]');
    const labels = [];
    for (const r of radios) {
      const rid = await r.getAttribute("id");
      let lbl = "";
      if (rid) {
        const l = await page.$(`label[for="${rid.replace(/"/g, '\\"')}"]`);
        if (l) lbl = (await l.innerText().catch(() => "")) || "";
      }
      if (!lbl) lbl = (await r.getAttribute("aria-label")) || "";
      if (!lbl) lbl = (await r.getAttribute("value")) || "";
      labels.push(lbl.replace(/\s+/g, " ").trim());
    }
    const m = matchOption(labels, wanted, { decline });
    if (m.index < 0) return { reason: m.reason };
    try {
      await radios[m.index].check({ timeout: 3000 });
    } catch {
      return { reason: `could not check "${labels[m.index].slice(0, 30)}"` };
    }
    const ok = await radios[m.index].isChecked().catch(() => false);
    if (!ok)
      return {
        reason: `checked "${labels[m.index].slice(0, 30)}" but it did not stick`,
      };
    return { value: labels[m.index], how: m.how };
  }

  return await pickFromCombobox(page, el, wanted, { decline });
}

async function attachResume(page, resumePath, filled, notes) {
  if (!resumePath) return;
  const inputs = await page.$$('input[type="file"]');
  for (const inp of inputs) {
    const name = (await inp.getAttribute("name")) || "";
    const id = (await inp.getAttribute("id")) || "";
    if (/cover/i.test(name + id)) continue; // not the resume slot
    try {
      await inp.setInputFiles(resumePath);
      filled.push({
        field: "resume",
        selector: name || id || "input[type=file]",
      });
      return;
    } catch (e) {
      notes.push(`resume attach failed: ${String(e.message).slice(0, 80)}`);
    }
  }
  notes.push("no resume file input found");
}

/**
 * Cookie/consent banners overlay the form and swallow clicks. Always take the
 * most privacy-preserving option available — decline, not accept.
 */
const CONSENT_DECLINE = [
  'button:has-text("Deny")',
  'button:has-text("Decline")',
  'button:has-text("Reject all")',
  'button:has-text("Reject All")',
  'button:has-text("Only necessary")',
  'button:has-text("Necessary only")',
  "#onetrust-reject-all-handler",
  ".ot-pc-refuse-all-handler",
];

async function dismissConsent(page, notes) {
  for (const sel of CONSENT_DECLINE) {
    const el = await page.$(sel);
    if (!el) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 4000 }).catch(() => {});
    notes.push(`consent: declined via ${sel}`);
    await page.waitForTimeout(600);
    return true;
  }
  return false;
}

/**
 * The stored URL is the job POSTING, not the application form. Lever exposes
 * the form at <posting>/apply; Greenhouse and others gate it behind an
 * "Apply for this job" button. Without this the run finds zero fields and
 * reports a clean dry run having filled nothing — which is worse than failing,
 * because it looks like success.
 */
const APPLY_LINKS = [
  'a:has-text("Apply for this job")',
  'a:has-text("Apply for This Job")',
  'button:has-text("Apply for this job")',
  'a.postings-btn:has-text("Apply")',
  'a:has-text("Apply Now")',
  'button:has-text("Apply Now")',
  'a[href$="/apply"]',
];

async function hasFormFields(page) {
  for (const sel of [
    ...FIELD_MAP.email,
    ...FIELD_MAP.first_name,
    ...FIELD_MAP.full_name,
  ]) {
    const el = await page.$(sel);
    if (el && (await el.isVisible().catch(() => false))) return true;
  }
  return false;
}

async function ensureApplicationForm(page, applyUrl, notes, timeout) {
  if (await hasFormFields(page)) return true;

  // Lever's form is a deterministic suffix — try it before clicking around.
  if (/jobs\.lever\.co/.test(applyUrl) && !/\/apply\/?$/.test(applyUrl)) {
    const direct = `${applyUrl.replace(/\/$/, "")}/apply`;
    await page
      .goto(direct, { waitUntil: "domcontentloaded", timeout })
      .catch(() => {});
    await page.waitForTimeout(1200);
    if (await hasFormFields(page)) {
      notes.push("navigated to lever /apply");
      return true;
    }
  }

  for (const sel of APPLY_LINKS) {
    const el = await page.$(sel);
    if (!el || !(await el.isVisible().catch(() => false))) continue;
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {}),
      el.click({ timeout: 8000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    if (await hasFormFields(page)) {
      notes.push(`clicked apply via ${sel}`);
      return true;
    }
  }
  return await hasFormFields(page);
}

/**
 * Label-driven fill for fields whose `name` is a generated id.
 * Greenhouse renders custom questions with opaque names, so "LinkedIn Profile"
 * cannot be matched by selector — only by its visible label.
 *
 * Refuses to type into a combobox. On this form "Location (City)" is a
 * react-select, and filling it wrote "Phoenix, AZ" into the search box, pushed
 * {field:"location"} onto `filled`, and committed nothing — react-select holds
 * typed text as a filter and discards it on blur. The application went out with
 * an empty location while the run reported it answered. Choice controls belong
 * to setChoice, which clicks a real option and verifies it stuck.
 */
async function fillByLabel(page, labelRe, value, filled, label) {
  if (!value) return false;
  const labels = await page.$$("label");
  for (const l of labels) {
    let text = "";
    try {
      text = (await l.innerText({ timeout: 800 })).trim();
    } catch {
      continue;
    }
    if (!labelRe.test(text)) continue;
    const forAttr = await l.getAttribute("for");
    // CSS.escape is a browser API and is undefined in Node — use an attribute
    // selector, which needs no identifier escaping.
    let input = forAttr
      ? await page.$(`[id="${forAttr.replace(/"/g, '\\"')}"]`)
      : null;
    if (!input) input = await l.$("input, textarea");
    if (!input) {
      const h = await l.evaluateHandle((el) =>
        el.parentElement?.querySelector("input, textarea"),
      );
      input = h?.asElement?.() || null;
    }
    if (!input) continue;
    // A choice control that reached here has no matching option, or setChoice
    // already declined it. Typing into it would fake a success — see above.
    const isChoice = await input
      .evaluate(
        (n) =>
          n.tagName === "SELECT" ||
          n.getAttribute("role") === "combobox" ||
          n.getAttribute("aria-haspopup") === "listbox" ||
          !!n.closest('[class*="select__"], [class*="react-select"]'),
      )
      .catch(() => false);
    if (isChoice) continue;
    try {
      await input.fill(String(value), { timeout: 4000 });
      filled.push({ field: label, via: "label" });
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * Find required fields that are still empty.
 *
 * This is the gate that stops blind submission. Greenhouse and Lever both carry
 * company-specific required questions — "are you physically based in New York
 * and willing to come in 5 days a week", "any blockchain experience" — that
 * cannot be answered from a profile without inventing an answer. Submitting
 * with them blank either fails validation or sends an empty response, and the
 * application cannot be withdrawn either way.
 *
 * A react-select combobox has to be judged on what it DISPLAYS, not on
 * `input.value`. Its search input is empty by design even when a choice is
 * committed, so the value check reported all fourteen of Roblox's dropdowns as
 * unanswered whether or not they had been answered. That is a gate that always
 * fires: `missing` was never empty, every live run returned needs_manual_fields,
 * and a correctly filled form still could not be submitted.
 */
export async function unfilledRequired(page) {
  return page.evaluate(() => {
    const out = [];
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.innerText.trim();
      }
      const wrap = el.closest("div, fieldset, li");
      return (wrap?.innerText || "").trim().slice(0, 120);
    };
    const isRequired = (el) => {
      if (el.required || el.getAttribute("aria-required") === "true")
        return true;
      const txt = labelFor(el);
      return (
        /\*\s*$/.test(txt.split("\n")[0] || "") ||
        /\*/.test(txt.split("\n")[0] || "")
      );
    };
    /**
     * Does the react-select wrapper around THIS input show a committed value?
     *
     * Scoped with closest(), not by walking ancestors. The walk called
     * querySelector at each of six levels, and querySelector searches that
     * ancestor's ENTIRE subtree — so by the fourth or fifth level it was at form
     * scope and returning true because some OTHER question had been answered.
     *
     * The consequence was not cosmetic. unfilledRequired feeds the gate that
     * decides whether a live submit may proceed, so a blank required dropdown
     * reading as filled meant an application could be submitted with the visa
     * sponsorship question empty. The previous code reported react-selects as
     * always-missing, which was wrong in the safe direction; the walk replaced it
     * with wrong in the submitting direction.
     *
     * closest() returns the control this input actually belongs to, so a query
     * inside it can only find that control's own value.
     */
    const comboHasValue = (el) => {
      const ctl = el.closest(
        '[class*="select__control"], [class*="react-select"], [class*="select__container"]',
      );
      if (!ctl) return false;
      if (
        ctl.querySelector(
          '[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]',
        )
      )
        return true;
      return !!(ctl.className && /has-value/.test(ctl.className));
    };
    const isCombo = (el) =>
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      !!el.closest('[class*="select__"], [class*="react-select"]');

    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (el.type === "hidden" || el.disabled) continue;
      if (el.offsetParent === null) continue; // not visible
      if (!isRequired(el)) continue;
      const empty =
        el.tagName === "SELECT"
          ? !el.value ||
            /^select/i.test(el.options[el.selectedIndex]?.text || "")
          : el.type === "file"
            ? el.files.length === 0
            : isCombo(el)
              ? !comboHasValue(el)
              : !String(el.value || "").trim();
      if (empty) out.push(labelFor(el).split("\n")[0].slice(0, 90));
    }
    return [...new Set(out)];
  });
}

/** The options a choice control offers, read without choosing one. */
async function readChoiceOptions(page, ctl) {
  const { el, tag } = ctl;
  if (tag === "select") {
    const opts = await el.$$eval("option", (os) =>
      os.map((o) => ({ v: o.value, t: (o.textContent || "").trim(), d: o.disabled })),
    );
    return opts
      .filter((o) => !o.d && o.v !== "" && !/^(select|choose|--|please select)/i.test(o.t))
      .map((o) => o.t);
  }
  if (tag === "fieldset") {
    const out = [];
    for (const r of await el.$$('input[type="radio"], input[type="checkbox"]')) {
      const rid = await r.getAttribute("id");
      let lbl = "";
      if (rid) {
        const l = await page.$(`label[for="${rid.replace(/"/g, '\\"')}"]`);
        if (l) lbl = (await l.innerText().catch(() => "")) || "";
      }
      if (!lbl) lbl = (await r.getAttribute("aria-label")) || (await r.getAttribute("value")) || "";
      out.push(lbl.replace(/\s+/g, " ").trim());
    }
    return out.filter(Boolean);
  }
  // A combobox: open it, read the listbox it owns, close it again.
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await el.click({ timeout: 3000 });
    await page.waitForTimeout(300);
    const listId = (await el.getAttribute("aria-controls")) || (await el.getAttribute("aria-owns"));
    const texts = listId
      ? await page.$$eval(`#${CSS_escape(listId)} [role="option"]`, (ns) =>
          ns.map((n) => (n.innerText || "").trim()),
        )
      : [];
    await page.keyboard.press("Escape").catch(() => {});
    return texts.filter(Boolean);
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return [];
  }
}

async function choiceIsAnswered(page, ctl) {
  const { el, tag } = ctl;
  if (tag === "select")
    return el.evaluate(
      (n) => !!n.value && !/^(select|choose|--|please select)/i.test(n.options[n.selectedIndex]?.text || ""),
    );
  if (tag === "fieldset") return el.evaluate((n) => !!n.querySelector("input:checked"));
  return !!(await comboboxValue(page, el));
}

/**
 * Model answers for REQUIRED multiple-choice questions still blank after the
 * rule-based passes. What the model may see is decided by modelMayAnswer, and
 * every answer it gives is checked against the options the form offers before
 * it is clicked. Each one is written into notes for the candidate to check.
 */
async function aiFillLeftovers(page, controls, ai, filled, notes) {
  const pending = [];
  for (const ctl of controls) {
    if (ctl.handled || !modelMayAnswer(ctl.label)) continue;
    if (AUTH_QUESTIONS.some((q) => q.re.test(ctl.label))) continue;
    const required =
      /\*/.test(ctl.label) ||
      (await ctl.el.evaluate((n) => n.required || n.getAttribute("aria-required") === "true").catch(() => false));
    if (!required) continue;
    if (await choiceIsAnswered(page, ctl).catch(() => true)) continue;
    const options = await readChoiceOptions(page, ctl);
    // Long lists (School, Country) are rule territory, and a model picking one
    // of 5,000 schools is exactly the guess this must not make.
    if (!options.length || options.length > 40) continue;
    pending.push({ ctl, label: ctl.label.replace(/\s*\*\s*$/, ""), options });
  }
  if (!pending.length) return;
  let picks = [];
  try {
    picks = await chooseFormAnswers(
      pending.map(({ label, options }) => ({ label, options })),
      ai,
    );
  } catch (e) {
    notes.push(`AI form answers skipped: ${String(e.message).slice(0, 80)}`);
    return;
  }
  for (const p of picks) {
    const q = pending[p.index];
    q.ctl.handled = true;
    const res = await setChoice(page, q.ctl, p.option, { decline: false });
    if (res.value) {
      filled.push({ field: `ai:${q.label.slice(0, 60)}`, value: res.value, how: "ai" });
      notes.push(`AI answered "${q.label.slice(0, 70)}" with "${res.value}" (${p.why || "from your facts"}); check it`);
    } else {
      notes.push(`AI picked "${p.option}" for "${q.label.slice(0, 50)}" but it did not register: ${res.reason}`);
    }
  }
  const left = pending.length - picks.length;
  if (left) notes.push(`${left} required question(s) left for you: your facts did not settle them`);
}

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  "#submit_app",
  'button:has-text("Submit application")',
  'button:has-text("Submit Application")',
  'button:has-text("Submit")',
];

/**
 * Fill (and optionally submit) one application.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun  MUST be explicitly false to actually submit.
 * @returns {{status:string, filled:Array, notes:Array, screenshot?:string}}
 */
export async function applyToJob({
  applyUrl,
  answers,
  resumePath,
  dryRun = true,
  // Hand-off: fill everything, then stop and give the browser to the human.
  // Nothing is submitted by the machine. This exists because most real
  // postings carry free-text screening questions the automation must not
  // invent answers to, so the honest end state is a filled form in front of
  // the candidate rather than a refusal or a guess.
  onHandoff = null,
  // { job: {company, title, location}, facts } enables model answers for the
  // leftover required multiple-choice questions (form-ai.js). FORM_FILL_AI=false
  // turns it off.
  ai = null,
  profileDir = null,
  screenshotPath,
  headless = true,
  timeout = 45_000,
}) {
  const filled = [];
  const notes = [];
  // A visible window and a headless screenshot want opposite things.
  //
  // Headless used a 1280x1600 viewport so full-page screenshots captured more of
  // the form in one image. Carried into a headed run that is actively broken: the
  // page believes it is 1600px tall, renders with no overflow and therefore no
  // scrollbar, while the real window shows about 900px. The rest of the form is
  // off-screen and there is nothing to scroll, because from the page's point of
  // view everything already fits.
  //
  // So when the human is going to drive it, hand the window over: viewport null
  // makes the page track the real window size, and --start-maximized gives it
  // the whole screen.
  const interactive = !headless;
  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

  // Persistent profile, for interactive runs only.
  //
  // A throwaway browser is right for headless: no cookies leak between
  // applications and each run is reproducible. It is wrong the moment the human
  // takes over, because several ATS platforms require an account — Workday
  // always, Greenhouse and Ashby for some employers — and a clean profile means
  // logging in again on every single application.
  //
  // The directory holds real session cookies for job boards, so it is gitignored
  // and created 0700. It deliberately does NOT apply to headless runs: a dry run
  // should tell you what an anonymous applicant sees, not what a logged-in one
  // does.
  let browser = null;
  let ctx;
  if (interactive && profileDir) {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: ["--start-maximized"],
      viewport: null,
      userAgent: UA,
    });
  } else {
    browser = await chromium.launch({
      headless,
      args: interactive ? ["--start-maximized"] : [],
    });
    ctx = await browser.newContext({
      viewport: interactive ? null : { width: 1280, height: 1600 },
      userAgent: UA,
    });
  }
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout });
    await page.waitForTimeout(1500);
    await dismissConsent(page, notes);

    const onForm = await ensureApplicationForm(page, applyUrl, notes, timeout);
    if (!onForm) {
      notes.push("could not reach an application form");
      if (screenshotPath)
        await page
          .screenshot({ path: screenshotPath, fullPage: true })
          .catch(() => {});
      return { status: "no_form", filled, notes, screenshot: screenshotPath };
    }
    await dismissConsent(page, notes);

    const captcha = await detectCaptcha(page);
    if (captcha) {
      // Never solved, never worked around — handed back for manual completion.
      notes.push(`captcha present (${captcha})`);
      if (screenshotPath)
        await page
          .screenshot({ path: screenshotPath, fullPage: true })
          .catch(() => {});
      return { status: "captcha", filled, notes, screenshot: screenshotPath };
    }

    const id = answers.identity;
    await fillFirstMatch(
      page,
      FIELD_MAP.first_name,
      id.first_name,
      filled,
      "first_name",
    );
    await fillFirstMatch(
      page,
      FIELD_MAP.last_name,
      id.last_name,
      filled,
      "last_name",
    );
    if (!filled.some((f) => f.field === "first_name")) {
      await fillFirstMatch(
        page,
        FIELD_MAP.full_name,
        id.full_name,
        filled,
        "full_name",
      );
    }
    await fillFirstMatch(page, FIELD_MAP.email, id.email, filled, "email");
    await fillFirstMatch(page, FIELD_MAP.phone, id.phone, filled, "phone");
    await fillFirstMatch(
      page,
      FIELD_MAP.location,
      id.location,
      filled,
      "location",
    );
    await fillFirstMatch(
      page,
      FIELD_MAP.linkedin,
      id.linkedin,
      filled,
      "linkedin",
    );
    await fillFirstMatch(
      page,
      FIELD_MAP.website,
      id.website,
      filled,
      "website",
    );
    await fillFirstMatch(page, FIELD_MAP.github, id.github, filled, "github");

    // Custom questions have generated names — match on the visible label.
    if (!filled.some((f) => f.field === "linkedin")) {
      await fillByLabel(page, /linkedin/i, id.linkedin, filled, "linkedin");
    }
    if (!filled.some((f) => f.field === "website")) {
      await fillByLabel(
        page,
        /website|portfolio|personal site/i,
        id.website,
        filled,
        "website",
      );
    }
    if (!filled.some((f) => f.field === "location")) {
      await fillByLabel(
        page,
        /^location|city/i,
        id.location,
        filled,
        "location",
      );
    }

    // Education, legal name, location and EEO. All of this was already in
    // answers.yaml and none of it was being used: a Roblox application filled
    // eight fields and then stopped on Country, School, Degree, Legal Name and
    // Cumulative GPA, every one of which was sitting in the file unread. These
    // are custom questions with generated field names, so they can only be
    // matched on their visible label — and on Greenhouse most of them are
    // react-select comboboxes rather than text inputs.
    //
    // One control pass, shared by both fillers, so neither drives a control the
    // other already answered.
    const controls = await enumerateControls(page);
    await answerAuthQuestions(page, answers, filled, notes, controls);
    await fillEducationAndEeo(page, answers, filled, notes, controls);
    if (ai && process.env.FORM_FILL_AI !== "false")
      await aiFillLeftovers(page, controls, ai, filled, notes);

    await attachResume(page, resumePath, filled, notes);

    await page.waitForTimeout(600);
    if (screenshotPath)
      await page
        .screenshot({ path: screenshotPath, fullPage: true })
        .catch(() => {});

    const missing = await unfilledRequired(page).catch(() => []);
    if (missing.length)
      notes.push(`unanswered required: ${missing.join(" | ").slice(0, 300)}`);

    if (onHandoff) {
      const shot = screenshotPath
        ? await page
            .screenshot({ path: screenshotPath, fullPage: true })
            .then(() => screenshotPath)
            .catch(() => null)
        : null;
      notes.push("handoff: browser left open, machine will not submit");
      await onHandoff({
        page,
        filled,
        notes,
        unfilled: await unfilledRequired(page).catch(() => []),
      });
      return { status: "handoff", filled, notes, screenshot: shot };
    }

    if (dryRun) {
      return {
        status: "dry_run",
        filled,
        notes,
        missingRequired: missing,
        screenshot: screenshotPath,
      };
    }

    // Refuse to submit an incomplete application, even in live mode. Blank
    // required answers are worse than not applying: the posting is consumed and
    // cannot be retried cleanly.
    if (missing.length) {
      return {
        status: "needs_manual_fields",
        filled,
        notes,
        missingRequired: missing,
        screenshot: screenshotPath,
      };
    }

    let submitted = false;
    for (const sel of SUBMIT_SELECTORS) {
      const btn = await page.$(sel);
      if (!btn || !(await btn.isVisible().catch(() => false))) continue;
      await btn.click({ timeout: 10_000 });
      submitted = true;
      break;
    }
    if (!submitted) {
      notes.push("no submit control found");
      return {
        status: "no_submit_button",
        filled,
        notes,
        screenshot: screenshotPath,
      };
    }

    await page.waitForTimeout(4000);
    return { status: "submitted", filled, notes, screenshot: screenshotPath };
  } catch (err) {
    notes.push(String(err?.message || err).slice(0, 200));
    return { status: "error", filled, notes, screenshot: screenshotPath };
  } finally {
    await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
