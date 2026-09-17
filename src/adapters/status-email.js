/**
 * Read a reply from an employer and work out what it means for an application.
 *
 * The alert-email parser next door reads mail that ADVERTISES jobs. This reads
 * mail that ANSWERS them: rejections, interview invitations, offers, and the
 * automated "we received your application" acknowledgements that mean nothing
 * except that the form went through.
 *
 * Classification is by phrase, not by sender, because the sender is usually a
 * no-reply address at an ATS and tells you which vendor the employer bought
 * rather than what they decided.
 *
 * Order matters below. "Unfortunately we will not be moving forward, but we
 * would like to keep your resume on file" contains encouraging words and is a
 * rejection; a rule that checked for "keep in touch" first would misread it. So
 * rejection is tested before anything softer, and the first match wins.
 */

const RULES = [
  {
    status: "rejected",
    // Checked first: a rejection often contains the vocabulary of every other
    // category, wrapped in an apology.
    // "unfortunately" alone is NOT a rejection. Cohere's autoresponder says
    // "Unfortunately, due to the high volume of interest we aren't able to
    // personally respond to every candidate" — an acknowledgement that scored as
    // a rejection and reported a live application as dead. Every phrase below
    // names a decision; the adverb that usually introduces one does not.
    re: /\b(regret to inform|we will not be moving forward|not moving forward|not be moving forward|decided not to (?:move|proceed|continue)|will not be progressing|no longer under consideration|not to proceed with your application|pursue other candidates|other applicants whose|position has been filled|filled the position|decided to move forward with other|not selected|were not selected|unable to offer you|not be advancing|will not be advancing)\b/i,
  },
  {
    status: "offer",
    re: /\b(pleased to offer|offer of employment|extend an offer|we would like to offer you|formal offer|offer letter)\b/i,
  },
  {
    status: "interview",
    re: /\b(schedule (?:an?|your) (?:interview|call|chat|screen)|invite you to interview|would like to (?:speak|chat|talk|meet)|set up (?:a|some) time|book a time|phone screen|technical (?:screen|interview)|next (?:round|step) (?:is|will be) (?:an?|a) interview|availability for (?:an?|a) (?:call|interview|chat))\b/i,
  },
  {
    status: "assessment",
    re: /\b(online assessment|coding (?:challenge|assessment|test)|take[- ]home|hackerrank|codesignal|codility|karat\b|work sample)\b/i,
  },
  {
    status: "acknowledged",
    // Deliberately last and deliberately weak. This is the autoresponder; it
    // says the form submitted and nothing about the outcome.
    re: /\b(thank you for (?:your interest|applying)|we(?:'ve| have) received your application|application (?:has been )?received|received your application|thanks for applying)\b/i,
  },
];

/**
 * Decode a MIME encoded-word header: =?UTF-8?Q?Mercor_=E2=80=94_Next_Steps?=
 *
 * Real subjects arrive like this whenever they contain a non-ASCII character —
 * an em dash is enough. Left encoded, the phrase rules see punctuation soup and
 * the role extractor sees nothing.
 */
export function decodeHeader(v = "") {
  return String(v).replace(
    /=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, enc, data) => {
      try {
        if (/^b$/i.test(enc)) return Buffer.from(data, "base64").toString("utf8");
        const bytes = data
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
        return Buffer.from(bytes, "binary").toString("utf8");
      } catch {
        return data;
      }
    },
  ).replace(/\?=\s*=\?/g, "");
}

/**
 * Undo quoted-printable soft line breaks.
 *
 * Mail wraps at 76 characters with a trailing "=", so a title splits mid-word:
 * "Oper= ator Experience". The role then matches nothing. This has to run before
 * the HTML strip, because the breaks land inside tags too.
 */
export function decodeQP(v = "") {
  return String(v)
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (m, h) => {
      const c = parseInt(h, 16);
      return c >= 32 || c === 10 || c === 13 ? String.fromCharCode(c) : m;
    });
}

/** Strip HTML to text so phrase rules see prose, not markup. */
export function mailText(raw = "") {
  return decodeQP(String(raw))
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which employer sent this?
 *
 * The From display name beats the domain: ATS mail arrives from
 * no-reply@greenhouse.io with a display name of the actual company, and the
 * domain would attribute every one of them to Greenhouse.
 */
export function senderCompany({ from = "", subject = "" } = {}) {
  const display = (String(from).match(/^\s*"?([^"<]+?)"?\s*</) || [])[1];
  // Employers put the ATS vendor, the department and the mailbox purpose in the
  // display name: "Lennar Workday", "GE Aerospace Workday Notifications",
  // "Applied Materials Human Resources", "WorkdaySystem_DoNotReply". All of it
  // has to come off before the name can be matched against an application.
  const cleaned = String(display || "")
    .replace(/[_]+/g, " ")
    // "WorkdaySystem" is one token to a word-boundary rule and two words to a
    // reader. Split it so the vendor name can be stripped.
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(careers?|recruiting|recruitment|recruiter|talent(?: acquisition)?|jobs?|hr|human resources|people ?(?:ops|team)?|no[- ]?reply|noreply|donotreply|do not reply|hiring(?: team)?|team|notifications?|system|workday|greenhouse|lever|ashby|icims|smartrecruiters|jobvite|taleo|myworkday|via .+)\b/gi, " ")
    .replace(/[|,–—-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned && cleaned.length > 1 && !/^[<@]/.test(cleaned)) return cleaned;

  // Fall back to the domain, skipping the ATS vendors that host mail for others.
  const dom = (String(from).match(/@([a-z0-9.-]+)/i) || [])[1] || "";
  const ATS = /greenhouse|lever|ashby|workday|myworkday|smartrecruiters|icims|jobvite|taleo|successfactors|bamboohr|rippling|gem\.com|paradox|hire/i;
  if (dom && !ATS.test(dom)) {
    return dom.replace(/\.(com|io|ai|co|net|org|inc)(\.[a-z]{2})?$/i, "").split(".").pop();
  }
  // Last resort: many subjects read "Your application to Acme".
  return (String(subject).match(/\b(?:to|at|with|from)\s+([A-Z][\w&.' -]{2,40})/) || [])[1]?.trim() || "";
}

/**
 * The role, if the mail names one.
 *
 * A captured phrase has to look like a job title before it is believed. The
 * first draft matched "application to Plaid Hi Harsh," — subject line running
 * into the greeting — and offered it as the role, which then matched no
 * application and sent a perfectly clear rejection to the ambiguous pile.
 */
const ROLE_NOUN =
  /\b(engineer|developer|scientist|analyst|architect|designer|manager|intern|researcher|specialist|administrator|consultant|programmer|swe|sde)\b/i;

export function mailRole({ subject = "", text = "" } = {}) {
  const pats = [
    // Anchored by an explicit "position"/"role" noun, so commas are safe to keep:
    // "Software Engineer, Full Stack position" is one title, and stopping at the
    // comma yielded "Software Engineer", which matched all three open Plaid
    // applications and made a clear rejection ambiguous.
    /\bfor (?:the )?(?:position of |role of )?([^.\n|—–]{3,70}?) (?:position|role|opening)\b/gi,
    /application (?:for|to)(?: the)? ([^.,\n|—–]{3,70}?)(?: position| role| opening)?[.,\n|—–]/gi,
    /regarding(?: the)? ([^.,\n|—–]{3,70}?)(?: position| role| opening)/gi,
    /\bfor the ([^.,\n|—–]{3,70}?) (?:position|role|opening)/gi,
    /\b(?:role|position) of ([^.,\n|—–]{3,70}?)[.,\n|—–]/gi,
  ];
  const found = [];
  for (const src of [subject, text.slice(0, 900)]) {
    for (const p of pats) {
      p.lastIndex = 0;
      let m;
      while ((m = p.exec(String(src))) !== null) {
        // Strip framing the patterns can swallow. "longest wins" below would
        // otherwise prefer "position of Software Engineer" over the actual
        // title, and that matched no application at Applied Materials.
        const v = m[1]
          ?.replace(/\s+/g, " ")
          .replace(/^(?:the |a |an |position of |role of |job of |opening for )+/i, "")
          .replace(/\s+(?:position|role|opening|job)$/i, "")
          .trim();
        if (v && ROLE_NOUN.test(v)) found.push(v);
      }
    }
  }
  // Longest wins: "Software Engineer, Full Stack" beats "Engineer".
  return found.sort((a, b) => b.length - a.length)[0] || "";
}

/**
 * Classify one message.
 *
 * Returns status null when nothing matches, rather than guessing. A mail the
 * rules do not recognise is reported for a human to read; silently filing it as
 * "acknowledged" would overwrite a real outcome with a shrug.
 */
/**
 * Is this phrase describing something that HAS happened, or something that
 * might?
 *
 * Autoresponders describe the whole process in advance: "we'll contact you if
 * we need any additional information or to schedule an interview", "if your
 * skills are a strong match, a member of our team will reach out to schedule an
 * interview". Both contain a textbook interview phrase and neither is an
 * invitation. Two of three "interviews" found in a real mailbox were this, and
 * I reported them as real.
 *
 * Only the sentence the phrase appears in is examined — a conditional two
 * paragraphs away says nothing about this clause.
 */
const CONDITIONAL =
  /\b(if|should you|should your|in the event|were you|may |might |in case|provided that|assuming)\b/i;

function sentenceAround(text, match) {
  if (!match) return text;
  const i = text.toLowerCase().indexOf(String(match).toLowerCase());
  if (i === -1) return text;
  const start = Math.max(0, text.lastIndexOf(".", i) + 1);
  const end = text.indexOf(".", i + match.length);
  return text.slice(start, end === -1 ? text.length : end);
}

export function classifyStatusEmail({ subject = "", from = "", body = "" } = {}) {
  const text = mailText(`${subject}\n${body}`);
  for (const r of RULES) {
    if (r.re.test(text)) {
      // A conditional clause is not an outcome, whatever it describes.
      //
      // This first exempted rejections, on the reasoning that a rejection stays
      // a rejection however it is hedged. Glean and Figma disproved it: both
      // autoresponders say "If you are not selected for this position, keep an
      // eye on our jobs page", and both were filed as rejections at the exact
      // minute the application was submitted. Only "acknowledged" is exempt —
      // it is the weakest thing recorded and cannot overstate anything.
      if (r.status !== "acknowledged") {
        const hit = (text.match(r.re) || [])[0];
        if (CONDITIONAL.test(sentenceAround(text, hit))) continue;
      }
      return {
        status: r.status,
        company: senderCompany({ from, subject }),
        role: mailRole({ subject, text }),
        matched: (text.match(r.re) || [])[0] || null,
      };
    }
  }
  return { status: null, company: senderCompany({ from, subject }), role: mailRole({ subject, text }), matched: null };
}
