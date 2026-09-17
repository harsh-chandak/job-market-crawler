/**
 * Structured resume -> Typst -> one-page PDF.
 *
 * Typst rather than LaTeX: a single binary, no package downloads, and it
 * compiles in ~100ms, which matters because the one-page fit is enforced by
 * compiling, counting pages, dropping the lowest-priority bullet, and
 * recompiling until it fits.
 *
 * Nothing here invents text. It renders exactly the strings `renderResume`
 * selected from the bank, which `verifyNoFabrication` has already checked.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

/**
 * Typst markup escaping.
 *
 * `~` is the one that matters and it does NOT break compilation — it silently
 * renders as a non-breaking space, turning "~50%" into "50%". That converts an
 * approximation into an exact claim on a document sent to employers, which is a
 * correctness bug, not a formatting one. Same class of problem for `--`, which
 * Typst folds into an en dash.
 */
export function esc(s = "") {
  return String(s ?? "")
    .replace(/([\\#$@*_<>`"~])/g, "\\$1")
    .replace(/--/g, "\\-\\-");
}

/**
 * Count pages without a PDF library. Typst emits a linearised page tree, so
 * the top-level /Count is authoritative; the /Type/Page tally is the fallback.
 */
export function pdfPageCount(buf) {
  const s = buf.toString("latin1");
  const counts = [...s.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) return Math.max(...counts);
  return (s.match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
}

/**
 * Typographic density steps, loosest first.
 *
 * Tried in order before any content is removed. Reducing 10pt to 9.25pt and
 * tightening leading buys roughly six extra lines on a US Letter page, which is
 * two or three bullets — cheaper than deleting a bullet, and invisible to a
 * reader who is not measuring.
 */
// Calibri first, Times as the fallback. Not Georgia.
//
// Georgia has a large x-height and wide letterforms — excellent on screen, bad
// on a one-page resume: the same bullets wrapped onto more lines and the fitter
// then deleted content to pay for it. Measured on identical input, Georgia
// yielded 5/6/6 bullets where Times yielded 6/6/6.
//
// The target resume the candidate supplied embeds Calibri (Times appears in it
// only for the bullet glyph), and Calibri is more compact than Times at the same
// nominal size, which is how that page holds 22 bullets at a comfortable size.
// Calibri is not installed here, so it heads the stack and is picked up
// automatically if it ever is; Carlito is the metric-compatible free clone and
// works identically. Until then Times New Roman is the closest available.
//
// Measured across every installed candidate: Times and Libertinus reached the
// target shape at 8.75pt, Palatino, Arial and Helvetica Neue only at 8.5pt, and
// Charter overflowed to two pages. Carlito is now installed and used.
//
// LEADING WAS THE REAL WASTE, not the font and not the margins.
//
// Measured against the target PDF: it renders 57 lines at 13.4pt pitch using
// 748pt of page height, at 10pt type. This template was rendering 53 lines at
// 13.9pt pitch using only 723pt — looser per line AND leaving 25pt of page
// unused, then paying for both by shrinking the font. Typst adds `leading` on
// top of the font's natural line height, so 0.55em at 9pt was adding ~4pt to
// every one of ~50 lines: a quarter of the page spent on air.
//
// Leading now starts at 0.3em and tightens to 0.15em, and the vertical margin
// tightens to 0.28in to match the target's measured 0.25in. Horizontal margin is
// held near 0.5in rather than used as a lever, because narrowing it lengthens
// lines, which is the one thing that makes a dense page genuinely harder to read.
// Net effect: the full target shape now fits at 9.5pt instead of 8.75pt.
export const DENSITIES = [
  { size: 10.5, lead: 0.3, mx: 0.55, my: 0.4, bulletGap: 2.5, secTop: 5, secBot: 1.5, blockGap: 2.5 },
  { size: 10, lead: 0.25, mx: 0.5, my: 0.35, bulletGap: 2.2, secTop: 4.5, secBot: 1.2, blockGap: 2.2 },
  { size: 9.8, lead: 0.22, mx: 0.5, my: 0.32, bulletGap: 2, secTop: 4, secBot: 1, blockGap: 2 },
  { size: 9.5, lead: 0.2, mx: 0.5, my: 0.3, bulletGap: 2, secTop: 4, secBot: 1, blockGap: 2 },
  { size: 9.25, lead: 0.18, mx: 0.5, my: 0.28, bulletGap: 1.8, secTop: 3.5, secBot: 1, blockGap: 1.8 },
  { size: 9, lead: 0.15, mx: 0.5, my: 0.28, bulletGap: 1.6, secTop: 3, secBot: 0.8, blockGap: 1.6 },
];

// Floors. A resume that lists one bullet per role reads as a thin career, which
// is a worse outcome than a slightly dense page — and it is not what happened;
// it is what the fitting loop did. Never trim below these.
export const MIN_EXPERIENCE_BULLETS = Number(process.env.MIN_EXP_BULLETS || 5);
export const MIN_PROJECT_BULLETS = Number(process.env.MIN_PRJ_BULLETS || 2);
// Soft floor: trim roles to this before sacrificing a whole project. Both are
// wanted, and 5 bullets is still inside the 4-6 target, so giving up the sixth
// bullet costs less than losing an entire project.
// Roles are now selected at 4/4/5, so the soft step only ever shaves the
// five-bullet role. Projects hold a floor of 1: showing three projects with one
// sharp bullet each beats showing one with two.
export const SOFT_EXPERIENCE_BULLETS = Number(process.env.SOFT_EXP_BULLETS || 6);

// The smallest size a page may drop to in order to take a spare project.
export const FILL_MIN_PT = Number(process.env.FILL_MIN_PT || 10);

export function buildTypst(r, d = DENSITIES[0]) {
  const p = r.profile || {};
  // Bare domains, and phone third — the order and form in the target resume.
  // Dropping the scheme costs nothing (nobody types https:// off a PDF) and buys
  // 16 characters on a line that was already wrapping close to the margin.
  const bare = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const contact = [p.location, p.email, p.phone, bare(p.linkedin), bare(p.website)]
    .filter(Boolean)
    .map(esc)
    .join(" #h(4pt) | #h(4pt) ");

  // Scaled with the density rather than fixed, so tightening actually tightens.
  // Five section headers plus six block gaps at fixed pt sizes cost roughly a
  // full bullet of vertical space at every step, which the font size was then
  // paying for.
  const section = (title) =>
    `\n#v(${d.secTop}pt)\n#text(size: ${d.size + 0.5}pt, weight: "bold", upper[${esc(title)}])\n#v(-4pt)\n#line(length: 100%, stroke: 0.5pt)\n#v(${d.secBot}pt)\n`;

  const bullets = (list) =>
    (list || []).map((b) => `#list.item[${esc(b)}]`).join("\n");

  // Role first, company second, dates right; location on its own line beneath.
  //
  // Separated by an em dash, not a comma. Titles here carry their own commas —
  // "AI/ML Software Engineer, LLM Systems, Example Corp (the platform, AI
  // College-Counseling Platform)" has three, one of them inside parentheses — so
  // a parser splitting the line on its first comma reads the employer as "LLM
  // Systems". The education block has always used a dash and extracts cleanly;
  // this makes the two consistent.
  //
  // This is the order in the target resume, and it is the better one: a reader
  // scanning three roles is asking "what was he doing" before "where", and the
  // title is the thing that has to match the posting.
  const expBlock = (e) => `
#grid(columns: (1fr, auto), gutter: 0pt,
  [#text(weight: "bold")[${esc(e.role)}] — ${esc(e.company)}],
  text(size: 9.5pt)[${esc(e.dates || "")}],
)
#v(-5pt)
#text(size: 9.5pt, style: "italic")[${esc(e.location || "")}${e.locationNote ? ` (${esc(e.locationNote)})` : ""}]
#v(-2pt)
#set list(indent: 6pt, spacing: ${d.bulletGap}pt, marker: [•])
${bullets(e.bullets)}
#v(${d.blockGap}pt)
`;

  const prjBlock = (p2) => `
#grid(columns: (1fr, auto), gutter: 0pt,
  text(weight: "bold")[${esc(p2.name)}],
  text(size: 9.5pt)[${esc(p2.stack || "")}],
)
#v(-2pt)
#set list(indent: 6pt, spacing: ${d.bulletGap}pt, marker: [•])
${bullets(p2.bullets)}
#v(${d.blockGap}pt)
`;

  const eduBlock = (e) => `
#grid(columns: (1fr, auto), gutter: 0pt,
  [#text(weight: "bold")[${esc(e.school)}] — ${esc(e.degree)}${e.field ? ` ${esc(e.field)}` : ""}${e.detail ? ` (${esc(e.detail)})` : e.gpa ? ` (GPA ${esc(e.gpa)})` : ""}],
  text(size: 9.5pt)[${esc(e.dates || "")}],
)
#v(-5pt)
#text(size: 9.5pt, style: "italic")[${esc(e.location || "")}]
#v(1pt)
`;

  const skills = r.skills || {};
  const skillLines = Object.entries(skills)
    .map(
      ([k, v]) =>
        `#text(weight: "bold")[${esc(k)}:] ${esc(Array.isArray(v) ? v.join(", ") : v)}`,
    )
    .join("\\\n");

  return `#set page(paper: "us-letter", margin: (x: ${d.mx}in, y: ${d.my}in))
#set text(font: ("Calibri", "Carlito", "Times New Roman", "Libertinus Serif", "Georgia"), size: ${d.size}pt)
#set par(justify: true, leading: ${d.lead}em)
#set text(tracking: ${d.track ?? 0}em, hyphenate: ${d.hyphenate ? "true" : "false"})

#align(center)[#text(size: 17pt, weight: "bold")[${esc(p.name)}]]
#v(-4pt)
#align(center)[#text(size: 9pt)[${contact}]]

${r.summary ? section("Summary") + `${esc(r.summary)}\n` : ""}
${(r.education || []).length ? section("Education") + (r.education || []).map(eduBlock).join("") : ""}
${skillLines ? section("Technical Skills") + skillLines + "\n" : ""}
${
  (r.experience || []).length
    ? section("Experience") +
      (r.experience || [])
        .filter((e) => e.bullets?.length)
        .map(expBlock)
        .join("")
    : ""
}
${(r.projects || []).length ? section("Projects") + (r.projects || []).map(prjBlock).join("") : ""}
`;
}

/**
 * Compile to a one-page PDF, trimming the lowest-priority bullet until it fits.
 * Bullets are already ordered by relevance, so the last one is the least
 * relevant — dropping from the tail degrades the weakest content first.
 */
export async function renderPdf(rendered, outPath, { maxTrims = 12 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "jh-resume-"));
  const src = join(dir, "resume.typ");
  const out = join(dir, "resume.pdf");

  const work = JSON.parse(JSON.stringify(rendered));
  let trims = 0;
  let pages = 99;
  let pdf = null;
  let density = 0;
  const actions = [];

  const compile = async (d) => {
    await writeFile(src, buildTypst(work, d), "utf8");
    try {
      await exec("typst", ["compile", src, out], { timeout: 30_000 });
    } catch (e) {
      throw new Error(
        `typst compile failed: ${String(e.stderr || e.message).slice(0, 300)}`,
      );
    }
    const buf = await readFile(out);
    return { buf, pages: pdfPageCount(buf) };
  };

  try {
    // Fit in this order, cheapest sacrifice first:
    //   1. tighten typography through the density steps
    //   2. drop trailing PROJECT bullets down to the project floor
    //   3. drop whole trailing projects
    //   4. drop trailing EXPERIENCE bullets down to the experience floor
    //
    // The previous version went straight to step 4 with a floor of one, so it
    // reduced every role to a single bullet to win a page. That is the one
    // trade never worth making: the page is a constraint, the experience is the
    // product.
    // Fill before fit. If the renderer handed over a spare project, try the
    // page with it, and keep it only when that is still one page at a readable
    // size with nothing trimmed. Space is never bought with content: failing
    // that, the page renders exactly as selected.
    let filled = 0;
    const spare = work.spareProjects || [];
    if (spare.length) {
      const base = work.projects || [];
      work.projects = [...base, ...spare];
      for (let d = 0; d < DENSITIES.length && DENSITIES[d].size >= FILL_MIN_PT; d++) {
        const r = await compile(DENSITIES[d]);
        if (r.pages <= 1) {
          pdf = r.buf;
          pages = r.pages;
          density = d;
          filled = spare.length;
          actions.push(`added ${spare.map((p) => `"${p.name}"`).join(", ")} (page had room at ${DENSITIES[d].size}pt)`);
          break;
        }
      }
      if (!filled) work.projects = base;
    }

    if (!filled) for (;;) {
      const r = await compile(DENSITIES[density]);
      pdf = r.buf;
      pages = r.pages;
      if (pages <= 1) break;

      if (density < DENSITIES.length - 1) {
        density++;
        actions.push(`density→${DENSITIES[density].size}pt`);
        continue;
      }

      const prjOver = (work.projects || []).filter(
        (p) => (p.bullets || []).length > (work.minProjectBullets ?? MIN_PROJECT_BULLETS),
      );
      if (prjOver.length) {
        prjOver.sort((a, b) => b.bullets.length - a.bullets.length);
        prjOver[0].bullets.pop();
        trims++;
        actions.push("trimmed a project bullet");
        continue;
      }

      // Only after projects are at their floor. The target shape is 4/4/5 with
      // 1-2 project bullets, so shaving a second project bullet is cheaper than
      // shortening a role: the project still appears, and the role keeps the
      // depth it was selected for.
      const expSoft = (work.experience || []).filter(
        (e) => (e.bullets || []).length > SOFT_EXPERIENCE_BULLETS,
      );
      if (expSoft.length) {
        expSoft.sort((a, b) => b.bullets.length - a.bullets.length);
        expSoft[0].bullets.pop();
        trims++;
        actions.push("role trimmed toward floor");
        continue;
      }

      if ((work.projects || []).length > 1) {
        const gone = work.projects.pop();
        actions.push(`dropped project "${gone.name}"`);
        continue;
      }

      const expOver = (work.experience || []).filter(
        (e) => (e.bullets || []).length > MIN_EXPERIENCE_BULLETS,
      );
      if (expOver.length) {
        expOver.sort((a, b) => b.bullets.length - a.bullets.length);
        expOver[0].bullets.pop();
        trims++;
        actions.push("trimmed an experience bullet");
        continue;
      }

      // Floors reached at maximum density and it still overflows. Stop and say
      // so rather than gutting the content further.
      actions.push("OVERFLOWS at floors — content needs shortening, not trimming");
      break;
    }

    if (pdf) await writeFile(outPath, pdf);
    const perExp = (work.experience || []).map((e) => (e.bullets || []).length);
    const perPrj = (work.projects || []).map((p) => (p.bullets || []).length);
    return {
      path: outPath,
      pages,
      trims,
      density: DENSITIES[density].size,
      bulletsPerRole: perExp,
      bulletsPerProject: perPrj,
      projectsAddedToFill: filled,
      actions,
      bytes: pdf?.length ?? 0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
