#!/usr/bin/env node
// Builds the user-guide pages for the GitHub Pages site from docs/guide/*.md.
// No dependencies; run by .github/workflows/pages.yml. Output goes to site/guide/
// (not committed). Fails on anything it can't convert, so a broken guide never deploys.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "docs/guide");
const outDir = join(root, "site/guide");
const REPO = "https://github.com/Chr0mX/ADBoard/blob/main/";

/** Order of the guide menu and the previous / next links. */
const ORDER = [
  ["README", "Guide home"],
  ["getting-started", "Getting started"],
  ["control", "Control"],
  ["manage", "Manage"],
  ["apps", "Apps"],
  ["files", "Files"],
  ["macros", "Macros"],
  ["shell-automation", "Shell Automation"],
  ["developer", "Developer"],
  ["hosts", "Hosts"],
  ["settings", "Settings"],
  ["troubleshooting", "Troubleshooting"],
];
const outName = (stem) => (stem === "README" ? "index.html" : `${stem}.html`);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fail = (file, msg) => {
  throw new Error(`${file}: ${msg}`);
};

/** GitHub-style heading id. */
function slug(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").trim().replace(/\s/g, "-");
}

/** Rewrites a link target from docs/guide/<file> to its place on the site. */
function rewriteHref(href, file, stems) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash = ""] = href.split("#");
  const tail = hash ? `#${hash}` : "";
  const target = posix.normalize(posix.join("docs/guide", path));
  if (target.startsWith("docs/guide/") && !target.slice(11).includes("/")) {
    const stem = target.slice(11).replace(/\.md$/, "");
    if (!target.endsWith(".md") || !stems.has(stem)) fail(file, `broken guide link: ${href}`);
    return outName(stem) + tail;
  }
  if (!existsSync(join(root, target))) fail(file, `broken link: ${href}`);
  return REPO + target + tail;
}

function rewriteSrc(src, file) {
  const target = posix.normalize(posix.join("docs/guide", src));
  if (!existsSync(join(root, target))) fail(file, `missing image: ${src}`);
  if (target.startsWith("docs/guide/images/")) return src;
  if (target.startsWith("site/assets/")) return "../assets/" + target.slice("site/assets/".length);
  return fail(file, `image outside the guide: ${src}`);
}

function inline(text, file, stems) {
  const hold = [];
  const keep = (html) => `\u0000${hold.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/<img\s[^>]*>/g, (tag) =>
    keep(tag.replace(/src="([^"]*)"/, (_, v) => `src="${rewriteSrc(v, file)}"`).replace(/\salign="[^"]*"/, "")),
  );
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const url = rewriteSrc(src.replace(/&amp;/g, "&"), file);
    return keep(`<a href="${url}"><img src="${url}" alt="${alt}" loading="lazy"></a>`);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const url = rewriteHref(href.replace(/&amp;/g, "&"), file, stems);
    return keep(`<a href="${url}">${label}</a>`);
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  // Labels were escaped before they were held, so restore in a loop (links hold nested spans).
  for (let i = 0; i < 4 && s.includes("\u0000"); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => hold[n]);
  if (s.includes("\u0000")) fail(file, "unresolved placeholder");
  return s;
}

const isBullet = (l) => /^\s*[-*]\s+/.test(l);
const isNumbered = (l) => /^\s*\d+\.\s+/.test(l);
const indentOf = (l) => l.match(/^ */)[0].length;
const isBlockStart = (l) =>
  /^(#{1,4}\s|```|>|\|)/.test(l) || isBullet(l) || isNumbered(l) || /^<p[\s>]/.test(l) || /^---+$/.test(l);

function render(md, file, stems) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const ids = new Map();
  const headings = [];

  function parseBlocks(ls) {
    const out = [];
    let i = 0;
    while (i < ls.length) {
      const line = ls[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      let m;
      if (line.startsWith("```")) {
        const body = [];
        i++;
        while (i < ls.length && !ls[i].startsWith("```")) body.push(ls[i++]);
        if (i >= ls.length) fail(file, "unterminated code fence");
        i++;
        out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        const level = m[1].length;
        const html = inline(m[2], file, stems);
        const plain = m[2].replace(/[`*]/g, "");
        let id = slug(plain);
        const n = ids.get(id) ?? 0;
        ids.set(id, n + 1);
        if (n) id += `-${n}`;
        headings.push({ level, text: plain });
        out.push(level === 1 ? `<h1 id="${id}">${html}</h1>` : `<h${level} id="${id}"><a class="anchor" href="#${id}">${html}</a></h${level}>`);
        i++;
      } else if (/^---+$/.test(line)) {
        out.push("<hr>");
        i++;
      } else if (/^<p[\s>]/.test(line)) {
        out.push(inline(line, file, stems));
        i++;
      } else if (line.startsWith(">")) {
        const body = [];
        while (i < ls.length && ls[i].startsWith(">")) body.push(ls[i++].replace(/^>\s?/, ""));
        out.push(`<blockquote>${parseBlocks(body).join("\n")}</blockquote>`);
      } else if (line.startsWith("|") && i + 1 < ls.length && /^\|[\s:|-]+\|?\s*$/.test(ls[i + 1])) {
        const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < ls.length && ls[i].startsWith("|")) rows.push(cells(ls[i++]));
        for (const r of rows) if (r.length !== head.length) fail(file, `table row has ${r.length} cells, header has ${head.length}: ${r[0]}`);
        const tr = (r, tag) => `<tr>${r.map((c) => `<${tag}>${inline(c, file, stems)}</${tag}>`).join("")}</tr>`;
        out.push(`<div class="table-wrap"><table><thead>${tr(head, "th")}</thead><tbody>${rows.map((r) => tr(r, "td")).join("")}</tbody></table></div>`);
      } else if (isBullet(line) || isNumbered(line)) {
        const [html, next] = parseList(ls, i);
        out.push(html);
        i = next;
      } else {
        const body = [];
        while (i < ls.length && ls[i].trim() && !(body.length && isBlockStart(ls[i]))) body.push(ls[i++].trim());
        out.push(`<p>${inline(body.join(" "), file, stems)}</p>`);
      }
    }
    return out;
  }

  /** One list (and the lists nested inside it) starting at ls[start]. */
  function parseList(ls, start) {
    const base = indentOf(ls[start]);
    const ordered = isNumbered(ls[start]);
    const items = [];
    let i = start;
    while (i < ls.length) {
      const l = ls[i];
      if (!l.trim()) {
        // A blank line continues the list only if the next line is more list or an indented continuation.
        const nx = ls.slice(i + 1).find((x) => x.trim());
        if (nx && (isBullet(nx) || isNumbered(nx)) && indentOf(nx) >= base) { i++; continue; }
        if (nx && indentOf(nx) > base) { i++; continue; }
        break;
      }
      const ind = indentOf(l);
      if (ind < base || (ind === base && !(isBullet(l) || isNumbered(l)))) break;
      if (ind === base && isBullet(l) !== !ordered) break;
      if (ind === base) {
        items.push({ text: [l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()], sub: [] });
        i++;
      } else if (isBullet(l) || isNumbered(l)) {
        const [html, next] = parseList(ls, i);
        items[items.length - 1].sub.push(html);
        i = next;
      } else {
        items[items.length - 1].text.push(l.trim());
        i++;
      }
    }
    const tag = ordered ? "ol" : "ul";
    const body = items.map((it) => `<li>${inline(it.text.join(" "), file, stems)}${it.sub.join("")}</li>`).join("\n");
    return [`<${tag}>\n${body}\n</${tag}>`, i];
  }

  return { html: parseBlocks(lines).join("\n"), headings };
}

function page({ stem, title, body, description }) {
  const idx = ORDER.findIndex(([s]) => s === stem);
  const menu = ORDER.map(([s, label]) => `<a href="${outName(s)}"${s === stem ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("");
  const prev = idx > 0 ? ORDER[idx - 1] : null;
  const next = idx < ORDER.length - 1 ? ORDER[idx + 1] : null;
  const pager = `<nav class="pager" aria-label="Pages"><span>${prev ? `<a href="${outName(prev[0])}">&larr; ${esc(prev[1])}</a>` : ""}</span><span>${next ? `<a href="${outName(next[0])}">${esc(next[1])} &rarr;</a>` : ""}</span></nav>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)} · ADBoard guide</title>
  <meta name="description" content="${esc(description)}">
  <meta name="theme-color" content="#0b0f17">
  <link rel="icon" href="../assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../assets/site.css">
</head>
<body>
  <header class="top">
    <div class="wrap">
      <a class="brand" href="../"><img src="../assets/logo.svg" alt="">ADBoard</a>
      <nav class="links" aria-label="Sections">
        <a href="../#features">Features</a>
        <a href="../#screens">Screens</a>
        <a href="./" aria-current="page">User guide</a>
        <a href="../#start">Quick start</a>
        <a href="https://github.com/Chr0mX/ADBoard">GitHub</a>
      </nav>
    </div>
  </header>
  <nav class="guide-nav" aria-label="Guide pages"><div class="wrap">${menu}</div></nav>
  <main class="wrap doc">
${body}
${pager}
  </main>
  <footer>
    <div class="wrap">
      <span>ADBoard · Android device control</span>
      <span><a href="https://github.com/Chr0mX/ADBoard/blob/main/docs/guide/${stem}.md">Edit this page on GitHub</a></span>
    </div>
  </footer>
</body>
</html>
`;
}

const stems = new Set(readdirSync(srcDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
for (const [s] of ORDER) if (!stems.has(s)) fail("build-site", `ORDER lists ${s}.md, which does not exist`);
for (const s of stems) if (!ORDER.some(([o]) => o === s)) fail("build-site", `${s}.md is not in ORDER`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(srcDir, "images"), join(outDir, "images"), { recursive: true });

for (const [stem] of ORDER) {
  const file = `docs/guide/${stem}.md`;
  const { html, headings } = render(readFileSync(join(srcDir, `${stem}.md`), "utf8"), file, stems);
  const title = headings.find((h) => h.level === 1)?.text ?? stem;
  const firstP = /<p>(.*?)<\/p>/s.exec(html.replace(/<p align[^]*?<\/p>/, ""))?.[1] ?? title;
  const description = firstP.replace(/<[^>]+>/g, "").slice(0, 200);
  writeFileSync(join(outDir, outName(stem)), page({ stem, title, body: html, description }));
}
console.log(`Built ${ORDER.length} guide pages into site/guide/`);
