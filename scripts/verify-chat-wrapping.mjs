/**
 * Layout regression check for a chat line, in a real browser engine.
 *
 *   npm run test:wrap
 *
 * WHY THIS IS NOT AN ORDINARY TEST
 *
 * Chat wrapping has now broken twice, and both times every existing test
 * stayed green, because both failures were invisible to everything except a
 * layout engine:
 *
 *   1. `.kb-msg-head` was `display: flex`, so the message body was a flex item
 *      sized to `container - name - gap` and used that width for every line.
 *      The DOM and the words were right; only the boxes were wrong.
 *
 *   2. The sender name became a `<button>` so it could open a user card. CSS
 *      said `display: inline`, and a test asserting that would have passed -
 *      but Chrome COERCES `display: inline` to `inline-block` on a button,
 *      because a button may not be split across lines. The name became an
 *      atomic inline box, and a message whose first unbreakable run did not
 *      fit in the space left on the line started a fresh line instead of
 *      filling it. The declaration in the stylesheet was a lie the stylesheet
 *      could not detect.
 *
 * So this asks Chrome, about the real thing. It renders the actual GroupChat
 * component and the actual stylesheet at several widths, then reads the line
 * boxes with Range.getClientRects.
 *
 * The markup is rendered rather than written out here on purpose. A gate with
 * its own hand-written sender span would keep passing if the component went
 * back to a `<button>`: the fixture would be under test, not the product.
 * Both regressions above shipped because something agreed with the bug.
 *
 * Not part of `npm test` - it needs a browser - but it is a gate, like the
 * other verify scripts.
 */
import { readFileSync } from 'node:fs'
import { launch } from './cdp.mjs'
import { loadBrowserBundle, loadFixture } from './render-fixture.mjs'

const CSS = readFileSync('src/ui/kickback.css', 'utf8')

const PROSE =
  'also sometimes chats have a random line break from my username and it just keeps going'
const LONG_WORD = 'Supercalifragilisticexpialidocious and then some normal words follow after it'
const URLISH = 'https://www.twitch.tv/videos/2147483647?filter=archives&sort=time&x=1'
const UNBREAKABLE = 'W'.repeat(90)

const SHORT_NAME = 'Nina'
const LONG_NAME = 'AVeryLongDisplayNameIndeed'

/** Panel widths a user can actually produce: minimum, default, and wide. */
const WIDTHS = [260, 320, 460]

const BODIES = [
  { label: 'short prose', body: 'ok that was actually incredible' },
  { label: 'long prose', body: PROSE },
  { label: 'sentence starting with a long word', body: LONG_WORD },
  { label: 'a URL', body: URLISH },
  { label: 'an unbreakable token', body: UNBREAKABLE },
  { label: 'text then an emote', body: 'that was rough :lol: honestly' },
  { label: 'several emotes and text', body: ':lol: :pog: what even was that :fire:' },
  { label: 'an emote first', body: ':lol: that was rough honestly and it keeps going on' },
  { label: 'a combo message', body: ':pog: :pog: :pog:' },
]

const CASES = []
for (const name of [SHORT_NAME, LONG_NAME]) {
  for (const body of BODIES) {
    CASES.push({ label: body.label, name, body: body.body })
  }
}

/**
 * Measures each rendered row at each width.
 *
 * Returns the sender's box and one entry per line box of the message, in
 * coordinates relative to the row, so the assertions read like the layout.
 */
function measure(sheet, cases, rows, widths) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = sheet
  const root = document.createElement('div')
  root.className = 'kb-root'
  shadow.append(style, root)

  const results = []

  for (const width of widths) {
    for (let index = 0; index < cases.length; index += 1) {
      const frame = document.createElement('div')
      frame.style.cssText = `width:${width}px;position:relative`
      frame.innerHTML = rows[index]
      root.appendChild(frame)

      const head = frame.querySelector('.kb-msg-head')
      const who = frame.querySelector('.kb-msg-who')
      const body = frame.querySelector('.kb-msg-body')

      if (!head || !who || !body) {
        results.push({ ...cases[index], width, missing: true })
        frame.remove()
        continue
      }

      const left = head.getBoundingClientRect().left
      const whoRect = who.getBoundingClientRect()

      /*
       * Collect every rect the body occupies - text fragments and inline
       * emotes alike - then merge them into line boxes.
       *
       * Merging matters: text, emote, text produces three rects on ONE line,
       * and treating each as its own line would report a wrap that never
       * happened. They are merged by vertical OVERLAP rather than by a shared
       * y, because a 17px emote and the text beside it sit on the same line
       * without sharing a top edge - and an emote-only body is taller still.
       */
      const range = document.createRange()
      range.selectNodeContents(body)

      const rects = [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .sort((a, b) => a.top - b.top)

      const merged = []
      for (const rect of rects) {
        const line = merged.find(
          (candidate) =>
            Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top) >
            Math.min(candidate.bottom - candidate.top, rect.height) / 2,
        )
        if (line) {
          line.top = Math.min(line.top, rect.top)
          line.bottom = Math.max(line.bottom, rect.bottom)
          line.start = Math.min(line.start, rect.left)
          line.end = Math.max(line.end, rect.right)
        } else {
          merged.push({ top: rect.top, bottom: rect.bottom, start: rect.left, end: rect.right })
        }
      }

      const lines = merged.map((line) => ({
        top: Math.round(line.top),
        bottom: Math.round(line.bottom),
        start: Math.round(line.start - left),
        end: Math.round(line.end - left),
      }))

      /*
       * The width of the body's first rendered piece, when that piece cannot
       * be broken.
       *
       * An emote is an image, and an emote-only body is an inline-flex box;
       * both are atomic, so if one does not fit in the room left beside the
       * name it moves to the next line and that is simply correct. Text is
       * never atomic - `overflow-wrap: break-word` will split it to fill the
       * line - so for text there is no excuse for starting a new line.
       */
      const firstChild = body.firstElementChild
      const bodyIsAtomic = getComputedStyle(body).display.startsWith('inline-flex')
      const atomicFirst = bodyIsAtomic
        ? body
        : firstChild && getComputedStyle(firstChild).display !== 'inline'
          ? firstChild
          : null
      const atomicFirstWidth = atomicFirst
        ? Math.round(atomicFirst.getBoundingClientRect().width)
        : null

      results.push({
        ...cases[index],
        width,
        senderText: who.textContent,
        senderDisplay: getComputedStyle(who).display,
        senderTop: Math.round(whoRect.top),
        senderBottom: Math.round(whoRect.bottom),
        senderEnd: Math.round(whoRect.right - left),
        atomicFirstWidth,
        headWidth: Math.round(head.getBoundingClientRect().width),
        // The panel must never be pushed wider than its column.
        scrollWidth: Math.round(head.scrollWidth),
        lines,
      })

      frame.remove()
    }
  }

  host.remove()
  return results
}

/** Installs the fixture bundle and mounts one chat row in a shadow root. */
function BUNDLE_RUNNER(bundle, sheet) {
  const host = document.createElement('div')
  host.id = 'kb-host'
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  /*
   * Chat is mounted inside a real `.kb-panel`, not bare inside `.kb-root`.
   *
   * Two things depend on it. The root layer is `pointer-events: none` - only
   * the panel and the launcher take pointers - so chat mounted directly under
   * the root is inert and a click by coordinate falls straight through to the
   * page. And the panel is the flex column that gives the log its height; the
   * log is `flex: 1 1 0` and collapses to nothing without one.
   *
   * The only addition is the growth the surrounding tab body normally
   * provides, since the tabs themselves are not part of this fixture.
   */
  style.textContent = `${sheet}\n.kb-panel > .kb-chat { flex: 1 1 auto; min-height: 0; }`

  const root = document.createElement('div')
  root.className = 'kb-root'
  const panel = document.createElement('div')
  panel.className = 'kb-panel'
  panel.style.cssText = '--kb-x: 0px; --kb-y: 0px; --kb-w: 320px; height: 360px'
  root.appendChild(panel)
  shadow.append(style, root)

  // Evaluated in the page rather than added as a <script>, so a strict CSP on
  // about:blank cannot get in the way.
  ;(0, eval)(bundle)
  window.__kbRoot = panel
}

/** Mounts one live chat line and reports the points worth clicking. */
function mountAndLocate(name) {
  return window.KickbackChat.mount(
    window.__kbRoot,
    name,
    'hello there this is a message',
  ).then(() => {
    const who = window.__kbRoot.querySelector('.kb-msg-who')
    const body = window.__kbRoot.querySelector('.kb-msg-body')

    // Chat scrolls itself to the newest message on mount, which can leave a
    // single short row sitting just above the top of the log. Clicking by
    // coordinate needs it actually on screen.
    who.scrollIntoView({ block: 'center' })

    const whoRect = who.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const middle = whoRect.top + whoRect.height / 2

    return {
      senderText: who.textContent,
      // A few pixels into the name, clear of the colon.
      name: { x: whoRect.left + 4, y: middle },
      // The colon: the last glyph inside the label.
      colon: { x: whoRect.right - 2, y: middle },
      // The margin between label and message - dead space, deliberately.
      gap: { x: whoRect.right + 2, y: middle },
      body: { x: bodyRect.left + 4, y: bodyRect.top + bodyRect.height / 2 },
    }
  })
}

/**
 * True once the browser has settled and a card is on screen.
 *
 * Two frames, because React does not necessarily commit a click's state change
 * before the dispatch returns - reading the DOM immediately reports "no card"
 * whether or not the click worked.
 */
/** Dismisses the card the way the card documents: Escape. */
function pressEscape() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

function cardIsOpen() {
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        resolve(Boolean(window.__kbRoot.querySelector('.kb-usercard'))),
      ),
    )
  })
}

const failures = []
const fail = (message) => failures.push(message)

const { renderRows } = await loadFixture('scripts/fixtures/chatRow.tsx')
const ROWS = renderRows(CASES)
const BUNDLE = await loadBrowserBundle('scripts/fixtures/chatMount.tsx', 'KickbackChat')

const browser = await launch({})
try {
  const page = await browser.newPage()
  await page.goto('about:blank')
  const results = await page.evaluate(measure, CSS, CASES, ROWS, WIDTHS)

  for (const row of results) {
    const where = `${row.label} @ ${row.width}px, name "${row.name}"`

    if (row.missing) {
      fail(`${where}: the rendered row has no sender or body to measure`)
      continue
    }

    const first = row.lines[0]
    if (!first) {
      fail(`${where}: no text line boxes measured at all`)
      continue
    }

    // 0. The separator belongs to the sender, exactly once, and the name keeps
    //    the capitalisation Twitch gave it.
    if (row.senderText !== `${row.name}:`) {
      fail(`${where}: sender reads "${row.senderText}", expected "${row.name}:"`)
    }

    // 1. The sender must be a genuine inline box. inline-block means an atomic
    //    box, which is how regression #2 happened.
    if (row.senderDisplay !== 'inline') {
      fail(`${where}: sender renders as ${row.senderDisplay}, not inline`)
    }

    /*
     * 2 and 3. The message starts on the sender's line, after the sender.
     *
     * This is the whole bug, in both its forms: the body must not begin as a
     * block underneath the name.
     *
     * The one honest exception is an atomic first piece - an emote image, or
     * an emote-only body, neither of which may be split - that is wider than
     * the room left beside the name. Text has no such excuse: it breaks to
     * fill whatever space is there.
     */
    const roomAfterName = row.headWidth - row.senderEnd
    const mustFit = row.atomicFirstWidth === null || row.atomicFirstWidth <= roomAfterName

    if (mustFit) {
      // Overlapping vertically is what "same line" means; a tall emote and a
      // short name share a line without sharing a top edge.
      const overlap =
        Math.min(row.senderBottom, first.bottom) - Math.max(row.senderTop, first.top)
      if (overlap <= 0) {
        fail(
          `${where}: message starts on its own line despite ${roomAfterName}px of room ` +
            `(sender ${row.senderTop}-${row.senderBottom}, first line ${first.top}-${first.bottom})`,
        )
      }
      if (first.start < row.senderEnd) {
        fail(
          `${where}: message starts at ${first.start}, before the sender ends at ${row.senderEnd}`,
        )
      }
    }

    // 4. Nothing may push the row wider than its column - that is what the
    //    unbreakable cases are for.
    if (row.scrollWidth > row.headWidth + 1) {
      fail(`${where}: content overflows the row (${row.scrollWidth} > ${row.headWidth})`)
    }

    // 5. Continuation lines start at the left edge, not in the narrow column
    //    beside the name - regression #1. When the body was a flex item every
    //    line began at the same x, just right of the name, so the message was
    //    permanently as narrow as `row - name` no matter how long it ran.
    //
    //    Only meaningful for messages that actually wrap; one that fits is not
    //    evidence of anything.
    if (row.lines.length > 1) {
      const continuation = row.lines.slice(1)
      if (continuation.every((line) => line.start >= row.senderEnd)) {
        fail(
          `${where}: every continuation line is indented past the name ` +
            `(name ends ${row.senderEnd}, lines start ${continuation
              .map((line) => line.start)
              .join(', ')})`,
        )
      }
    }
  }

  console.log(`checked ${results.length} rendered chat lines across ${WIDTHS.length} panel widths`)

  /*
   * The name is a span now, not a button. That is only an acceptable trade if
   * it is still a control, so this clicks the real thing: the name, the colon
   * beside it, the gap after it, and the message text.
   */
  const interactive = await browser.newPage()
  await interactive.goto('about:blank')
  await interactive.evaluate(BUNDLE_RUNNER, BUNDLE, CSS)
  const points = await interactive.evaluate(mountAndLocate, SHORT_NAME)

  /** A real click, hit-tested by the browser, and the state it leaves behind. */
  const clickAt = async (point) => {
    await interactive.mouse('mousePressed', point.x, point.y)
    await interactive.mouse('mouseReleased', point.x, point.y)
    return interactive.evaluate(cardIsOpen)
  }

  if (points.senderText !== `${SHORT_NAME}:`) {
    fail(`the mounted sender reads "${points.senderText}", expected "${SHORT_NAME}:"`)
  }

  /*
   * Escape, not a second click, to dismiss between probes.
   *
   * A second click on the name does not close the card: the card's own
   * pointerdown-capture handler closes it, and then the name's click handler
   * reopens it. That is how it behaved when the name was a button too, so it
   * is not this change's doing and not this change's to fix - but a probe that
   * assumed toggling would be measuring something the product never did.
   */
  const dismiss = async () => {
    await interactive.evaluate(pressEscape)
    if (await interactive.evaluate(cardIsOpen)) fail('Escape does not close the user card')
  }

  if (!(await clickAt(points.name))) fail('clicking the sender name does not open the user card')
  await dismiss()

  if (!(await clickAt(points.colon))) fail('clicking the ":" does not open the user card')
  await dismiss()

  if (await clickAt(points.gap)) {
    fail('clicking the gap after the ":" opens the user card - the target is wider than the label')
  }
  if (await clickAt(points.body)) fail('clicking the message text opens the user card')

  console.log('the sender name, colon included, is still a working control')
} finally {
  await browser.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} wrapping problem(s):\n`)
  for (const problem of failures) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('Chat lines wrap naturally: sender and message share the first line.')
