/**
 * Renders docs/PRIVACY.md into the public site's privacy page.
 *
 * Throwaway, deliberately: transcribing a policy by hand is how a policy stops
 * matching the thing it describes, and a general markdown library would be a
 * dependency for one page. This handles exactly the constructs the policy uses
 * and refuses anything it does not recognise, so a future policy that grows a
 * new construct is caught by the word-level check the caller runs afterwards,
 * which compares every word of the policy against every word of the page.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync('docs/PRIVACY.md', 'utf8')

/*
 * Where the page sits, and therefore where "back" goes.
 *
 * The policy has lived at /privacy/ and now lives at /kickback/privacy/, and a
 * relative link that was right in one place is a 404 in the other. Passed in
 * rather than guessed, so moving the page is a flag rather than a bug nobody
 * notices until a reviewer clicks it.
 */
const backHref = process.argv[3] ?? '../'
const backLabel = process.argv[4] ?? 'Kickback'

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Bold, code spans and links. Everything else is left as written.
 *
 * Code spans are lifted out before anything else runs and put back last. The
 * policy quotes host patterns that contain asterisks, and leaving those in
 * place meant the emphasis rule ate the asterisks and the surrounding bold then
 * failed to match - so a permission bullet rendered as literal asterisks
 * wrapped around half-italic nonsense.
 */
function inline(text) {
  const spans = []
  const withPlaceholders = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code)
    return `@@KB-CODE-${spans.length - 1}@@`
  })

  return escape(withPlaceholders)
    .replace(/\*\*(.+?)\*\*/g, (_, bold) => `<strong>${bold}</strong>`)
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, em) => `<em>${em}</em>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/@@KB-CODE-(\d+)@@/g, (_, n) => `<code>${escape(spans[Number(n)])}</code>`)
}

const lines = source.split(/\r?\n/)
const out = []
let index = 0

const flushParagraph = (buffer) => {
  if (buffer.length === 0) return
  out.push(`<p>${inline(buffer.join(' ').trim())}</p>`)
  buffer.length = 0
}

const paragraph = []

while (index < lines.length) {
  const line = lines[index]

  if (line.trim() === '') {
    flushParagraph(paragraph)
    index += 1
    continue
  }

  if (line.trim() === '---') {
    flushParagraph(paragraph)
    out.push('<hr />')
    index += 1
    continue
  }

  const heading = /^(#{1,4})\s+(.*)$/.exec(line)
  if (heading) {
    flushParagraph(paragraph)
    const level = heading[1].length
    out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    index += 1
    continue
  }

  // Tables: a header row, a separator, then body rows. The separator is
  // matched loosely because the policy writes it as "| --- | --- |", spaces
  // and all.
  const separator = /^\|[\s:|-]+\|$/
  if (line.trim().startsWith('|') && separator.test((lines[index + 1] ?? '').trim())) {
    flushParagraph(paragraph)
    const cells = (row) =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())

    const header = cells(line)
    index += 2
    const body = []
    while (index < lines.length && lines[index].trim().startsWith('|')) {
      body.push(cells(lines[index]))
      index += 1
    }

    out.push('<div class="table-scroll"><table>')
    out.push(`<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`)
    out.push('<tbody>')
    for (const row of body) {
      out.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    }
    out.push('</tbody></table></div>')
    // The table is wider than the column of prose, so say so rather than
    // letting the Retention column look like it does not exist.
    out.push('<p class="table-note">Scroll the table sideways to see every column.</p>')
    continue
  }

  // Bullet lists, including wrapped continuation lines.
  if (/^[-*]\s+/.test(line.trim())) {
    flushParagraph(paragraph)
    const items = []
    while (index < lines.length) {
      const item = /^[-*]\s+(.*)$/.exec(lines[index].trim())
      if (item) {
        items.push([item[1]])
        index += 1
        continue
      }
      // A continuation line is indented and belongs to the previous bullet.
      if (/^\s{2,}\S/.test(lines[index] ?? '') && items.length > 0) {
        items[items.length - 1].push(lines[index].trim())
        index += 1
        continue
      }
      break
    }
    out.push(`<ul>${items.map((parts) => `<li>${inline(parts.join(' '))}</li>`).join('')}</ul>`)
    continue
  }

  // Ordered lists.
  if (/^\d+\.\s+/.test(line.trim())) {
    flushParagraph(paragraph)
    const items = []
    while (index < lines.length) {
      const item = /^\d+\.\s+(.*)$/.exec(lines[index].trim())
      if (item) {
        items.push([item[1]])
        index += 1
        continue
      }
      if (/^\s{2,}\S/.test(lines[index] ?? '') && items.length > 0) {
        items[items.length - 1].push(lines[index].trim())
        index += 1
        continue
      }
      break
    }
    out.push(`<ol>${items.map((parts) => `<li>${inline(parts.join(' '))}</li>`).join('')}</ol>`)
    continue
  }

  paragraph.push(line.trim())
  index += 1
}
flushParagraph(paragraph)

const body = out.join('\n      ')

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Policy — Kickback</title>
    <meta name="description" content="How the Kickback browser extension handles your data." />
    <!--
      No analytics, no tracking, no external scripts, no external fonts.
      Everything this page needs is in this file.
    -->
    <style>
      :root {
        color-scheme: dark;
        --bg: #101014;
        --surface: #17171d;
        --text: #efeff1;
        --dim: #a6a6b0;
        --line: rgba(255, 255, 255, 0.1);
        --accent: #ff8452;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        padding: 48px 24px 96px;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif;
        font-size: 16px;
        line-height: 1.65;
        -webkit-font-smoothing: antialiased;
      }

      main { max-width: 46rem; margin: 0 auto; }

      .back {
        display: inline-block;
        margin-bottom: 28px;
        color: var(--dim);
        text-decoration: none;
        font-size: 0.9rem;
      }
      .back:hover { color: var(--text); }

      h1 {
        margin: 0 0 8px;
        font-size: 2rem;
        letter-spacing: -0.02em;
      }
      h2 {
        margin: 40px 0 12px;
        font-size: 1.3rem;
        letter-spacing: -0.01em;
      }
      h3 {
        margin: 28px 0 10px;
        font-size: 1.05rem;
        color: var(--dim);
      }

      p { margin: 0 0 16px; }
      ul, ol { margin: 0 0 16px; padding-left: 1.4em; }
      li { margin-bottom: 8px; }

      strong { color: #fff; }

      code {
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.88em;
      }

      a { color: var(--accent); }
      a:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 3px;
        border-radius: 3px;
      }

      hr {
        margin: 36px 0;
        border: 0;
        border-top: 1px solid var(--line);
      }

      /* Wide tables scroll inside themselves rather than the page. */
      .table-scroll {
        margin: 0 0 8px;
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--surface);
      }

      /*
       * Given room, and allowed to scroll.
       *
       * Without a minimum the columns squeeze until "Twitch identity (your
       * Twitch user id, login, display name, avatar URL)" wraps over six lines
       * and the table is harder to read than the prose it summarises.
       */
      table {
        width: 100%;
        min-width: 54rem;
        border-collapse: collapse;
        font-size: 0.85rem;
        line-height: 1.5;
      }

      td:first-child, th:first-child { min-width: 11rem; }

      th, td {
        padding: 9px 12px;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid var(--line);
      }

      th {
        color: var(--dim);
        font-weight: 600;
        white-space: nowrap;
      }

      tbody tr:last-child td { border-bottom: 0; }

      .table-note { margin: 0 0 24px; color: #74747f; font-size: 0.8rem; }

      @media (max-width: 640px) {
        body { padding: 32px 16px 64px; }
        h1 { font-size: 1.6rem; }
      }
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="${backHref}">&larr; ${backLabel}</a>
      ${body}
    </main>
  </body>
</html>
`

writeFileSync(process.argv[2], page)
console.log(`wrote ${process.argv[2]} (${page.length} bytes)`)
