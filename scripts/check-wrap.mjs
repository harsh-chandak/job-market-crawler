/**
 * Stranded-word check for the bullet bank.
 *
 *   node scripts/check-wrap.mjs             every bullet, every density
 *   node scripts/check-wrap.mjs --only=ids  comma-separated bullet ids
 *
 * The renderer steps down through DENSITIES until the page fits, so a bullet
 * that wraps cleanly at 10.5pt can leave "runs" alone on its last line at
 * 9.5pt. Two of those were found by eye in rendered PNGs; this finds them before
 * a bank edit ships, by setting each bullet in the same column, font and list
 * indent the resume uses and reading the lines back out of the PDF.
 *
 * A bullet is STRANDED at a density when it wraps and its last line is a single
 * word or 14 characters or fewer. Nothing is judged beyond that.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { DENSITIES, esc } from "../src/render-pdf.js";

const exec = promisify(execFile);
const only = (process.argv.find((a) => a.startsWith("--only=")) || "")
  .slice(7)
  .split(",")
  .filter(Boolean);

const bank = YAML.parse(
  readFileSync(new URL("../resume/bullets.yaml", import.meta.url), "utf8"),
);
const bullets = [
  ...(bank.experience || []).flatMap((e) => e.bullets || []),
  ...(bank.projects || []).flatMap((p) => p.bullets || []),
].filter((b) => !only.length || only.includes(b.id));

// Mirrors buildTypst: same page width, margins, font stack, justification,
// leading and list indent. Height is auto and each bullet gets its own page, so
// pdftotext hands back one page per bullet.
const doc = (
  d,
) => `#set page(width: 8.5in, height: auto, margin: (x: ${d.mx}in, y: 0.2in))
#set text(font: ("Calibri", "Carlito", "Times New Roman", "Libertinus Serif", "Georgia"), size: ${d.size}pt)
#set par(justify: true, leading: ${d.lead}em)
#set text(tracking: ${d.track ?? 0}em, hyphenate: ${d.hyphenate ? "true" : "false"})
#set list(indent: 6pt, spacing: ${d.bulletGap}pt, marker: [•])
${bullets.map((b) => `#list.item[${esc(b.text)}]`).join("\n#pagebreak()\n")}
`;

const dir = await mkdtemp(join(tmpdir(), "jh-wrap-"));
const results = bullets.map((b) => ({
  id: b.id,
  len: b.text.length,
  lines: [],
  stranded: [],
}));
try {
  for (const [di, d] of DENSITIES.entries()) {
    const src = join(dir, `d${di}.typ`);
    const pdf = join(dir, `d${di}.pdf`);
    await writeFile(src, doc(d));
    await exec("typst", ["compile", src, pdf], { timeout: 60_000 });
    const { stdout } = await exec("pdftotext", ["-layout", pdf, "-"], {
      maxBuffer: 16 << 20,
    });
    const pages = stdout.split("\f");
    for (const [i, r] of results.entries()) {
      const lines = (pages[i] || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      r.lines.push(lines.length);
      const last = lines.at(-1) || "";
      if (
        lines.length > 1 &&
        (last.split(/\s+/).length === 1 || last.length <= 14)
      ) {
        r.stranded.push(`${d.size}pt: "${last}"`);
      }
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

const sizes = DENSITIES.map((d) => String(d.size).padStart(4)).join(" ");
console.log(
  `lines per bullet at each density (${DENSITIES.length} steps, largest first)\n`,
);
console.log(`${"id".padEnd(26)} len  ${sizes}`);
for (const r of results) {
  const mark = r.stranded.length ? "  ✗ " + r.stranded.join(" · ") : "";
  console.log(
    `${r.id.padEnd(26)} ${String(r.len).padStart(3)}  ${r.lines.map((n) => String(n).padStart(4)).join(" ")}${mark}`,
  );
}
const bad = results.filter((r) => r.stranded.length);
console.log(`\nstranded somewhere: ${bad.length}/${results.length}`);
for (const [di, d] of DENSITIES.entries()) {
  const n = results.filter((r) =>
    r.stranded.some((s) => s.startsWith(`${d.size}pt`)),
  ).length;
  console.log(`  ${String(d.size).padStart(4)}pt  ${n}`);
}
process.exitCode = bad.length ? 1 : 0;
