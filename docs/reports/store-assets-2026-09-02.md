# Store Assets — Chrome + Firefox storefront pass

**Date:** 2026-09-02
**Product state:** v0.8.0 submitted to Chrome and pending review; Firefox 0.6 awaiting first AMO review
**Preceded by:** the Chrome v0.8.0 submission handoff

---

## 1. Verdict

**★ GO.** A complete four-screenshot listing set exists, captured from the real
v0.8 product against real Twitch, assembled into a committed location with a
contact sheet for one visual decision. Listing copy is rewritten. Nothing
touched the submitted v0.8 package.

Two things came out of this pass that were not on the list:

- **The listing body copy is still Kickback-era.** The item *name* was updated
  to "Watchside BETA" at some point; the short description, detailed
  description and single-purpose statement in the recorded listing all still
  name the old product and predate suggested friends, invite links and the
  support page. Replacement copy is written (§7).
- **Browser automation was making noise**, and the fix belongs in the launcher
  rather than in a habit (§3).

---

## 2. What survived the interrupted run

The interrupted run had already recaptured screenshots 1–3 before it stopped.
Checked rather than assumed:

- `git status` clean, HEAD at the submission-handoff commit — **no temporary
  source changes were left behind**.
- Three screenshots on disk with fresh timestamps.
- Nine Edge processes running. Inspecting their command lines, **none was an
  automation instance**: they are the owner's own browser — WebView host,
  crashpad handler, GPU process. The automation browser had already exited.
  Nothing was killed.

Those three captures were superseded anyway, because the channels changed (§4).

---

## 3. The browser-audio correction

The interrupted run was loud because every automated session opens twitch.tv,
where a live stream starts playing as soon as the page settles.

**The cause is worth stating precisely**, because the obvious assumption is
wrong: the harness already runs *headless*, and `--headless=new` is a real
browser. It renders and plays audio exactly like a visible one. There was no
window to mute and no tab to click.

Fixed in both launchers, unconditionally:

| | |
| --- | --- |
| Chromium (`scripts/cdp.mjs`) | `--mute-audio` in the unconditional argument list |
| Firefox (`scripts/firefox-e2e/harness.mjs`) | `media.volume_scale = "0.0"` in a `QUIET_PREFS` set, written alongside the strict-privacy prefs on every profile |

**Muting, not blocking.** Neither stops playback. Store screenshots need the
player actually playing — a paused player with a play button over it is not what
the product looks like — and the M3D acceptance depends on the real page.
Blocking autoplay would have been the easier fix and the wrong one.

**Not an option.** Both are unconditional, because there is no automation in
this repository that should make noise, and an option is a thing somebody
forgets to pass. Every caller inherits it: screenshots, the Test Lab verifier,
chat-wrapping checks, icon and social rendering, the Firefox E2E suite, the M3D
acceptance run.

`tests/extension/captureAudio.test.ts` (6 tests) asserts both mechanisms, that
the Chromium flag sits in the unconditional array rather than behind a
parameter, that the Firefox quiet prefs are applied wherever the strict prefs
are, and that neither took the blocking shortcut.

---

## 4. Capture channels

Owner-selected for this run: **summit1g**, **Zchum**, **ESL_SC2**.

Mapped to the story rather than assigned arbitrarily:

| Role | Channel | Why |
| --- | --- | --- |
| the gathering | `esl_sc2` | An esports broadcast is the most legible reason three friends would be on one channel at once. It reads as "they are all watching the tournament" rather than as a coincidence. |
| where the viewer is | `summit1g` | A large variety stream, so screenshot 2 is a real choice between two things rather than one card in an empty panel. |
| a third channel | `zchum` | One friend elsewhere, so "everyone is in one place" is visibly something that happened rather than the only state the fixtures have. |

**Both channels that had to be live were live.** `summit1g` (Ready or Not,
5,841 viewers) and `ESL_SC2` (StarCraft II Masters) both streaming at capture
time. `zchum` appears only as a card in the panel — the capture never navigates
there — so its live state does not affect any screenshot.

**Nothing is blocked.** All four screenshots captured.

The names live in one exported constant (`src/mock/presenceService.ts`), which
the screenshot script mirrors. That file is **demo-only and absent from the
production package** — verified by scanning the built v0.8 bundle for the
fixture identifiers, none of which appear. Changing it cannot reach production
and did not touch the submitted artifact.

**No creator is implied to endorse, sponsor or know about Watchside.** They are
Twitch channels appearing in Twitch's own product, which is where Watchside
runs. No quotes, no logos used as decoration, no claimed relationship.

---

## 5. The screenshot sequence

Four screenshots, 1280×800, in this order. Chrome allows at most five.

| # | Beat | What it shows |
| --- | --- | --- |
| 1 | **See where your friends are watching** | Twitch's Browse page; the panel lists three friends on `esl_sc2`, one on `summit1g`, one on `zchum`, one offline. The core promise before any interaction. |
| 2 | **Jump into the stream** | Watching `summit1g` with Sarah HERE, while three friends have gathered on `esl_sc2` with JOIN on that card. The whole product in one picture. |
| 3 | **Watch together** | After the JOIN: on `ESL_SC2`, "4 friends are here", WATCHING TOGETHER · 5, live conversation and a reaction combo. |
| 4 | **Find your Twitch friends** | Find friends open: suggestions by mutual count (3, 2, 1), ADD on each, and the durable invite link with Copy. |

**Screenshot 4 is new.** The old set had no fourth beat at all, so the listing
never showed how a friend graph forms — which is the answer to the most common
first experience, an empty panel. The surface M5A rebuilt had never been
photographed.

**Why four and not six.** The arc is complete and each beat is distinct.
Candidates for a fifth were Groups, badges and notifications; the brief is
explicit that Groups must not be a hero, and badges and notifications are
supporting details that would dilute rather than strengthen. Five mediocre
screenshots is a worse listing than four that each earn their place.

**Format: clean product screenshots, no marketing frames.** The product is
legible on its own — panel, friend names, channel names, JOIN — and a branded
overlay would have to cover part of it to say something the picture already
says. It would also risk the thing a store listing must never do: looking like a
mock-up of the extension rather than the extension. Captions carry the words,
in the listing's own caption field and in `SEQUENCE.md`.

**The DEMO badge stays visible.** These are mock friends, and the screenshot
says so rather than implying the names are real people.

---

## 6. Capture methodology

`npm run screenshots:store` — an existing harness, extended with the fourth
scene. It loads the demo build as a real extension into a real browser and
points it at real twitch.tv, so what comes out is a photograph of the product
rather than a picture of a mock-up: every pixel of the panel is the React the
build ships.

Staged: which channel the browser is on, which tab is open, where the panel
sits, and dismissing Twitch's own consent and sign-up banners — all things a
person would do before taking the screenshot themselves.

Not staged: anything Watchside draws. The friends, clustering, JOIN buttons,
conversation and reactions all come from demo fixtures through the real
components.

**The owner creates no state by hand.** No fake friends, no account switching,
no manufactured Gravity, no coordinating several people, no window resizing. One
command.

Demo friend suggestions were seeded so screenshot 4 has something to show —
previously `suggestFriends` resolved empty, which is correct for a demo of the
watching experience and wrong for a listing, where the empty state would
advertise "Watchside has nobody to suggest" as though that were the feature.
Three plausible people with mutual counts of 3, 2 and 1. The product never names
a mutual, so neither does the screenshot.

---

## 7. Listing copy

**`assets/store/current/LISTING.md`** — paste-ready.

The recorded listing copy is Kickback-era throughout. Replaced:

- **Short description**, 107 characters of 132: *"See where your Twitch friends
  are watching and jump into the stream with them. A small panel beside
  Twitch."*
- **Detailed description**, rewritten, with two new sections. **GETTING
  STARTED** covers suggestions and the invite link — the answer to an empty
  panel, which the old copy never addressed. **IF SOMETHING GOES WRONG** points
  at the support page that now exists and works when the extension does not.
- **Single-purpose statement**, renamed, with suggestions and invite links added
  to the enumeration. An incomplete single-purpose list is worse than a long
  one: a reviewer who finds a feature it does not cover has found an
  inconsistency.

**Deliberately absent:** any mention of measurement, campaigns or follows. None
is a user-facing feature, and describing it in marketing copy would advertise
something nobody installs for. It belongs in the privacy policy, where it is. No
user counts, ratings, testimonials or creator names — there are none, and
inventing them is the one thing a listing must never do.

**URLs.** Support and privacy point at the live Pages routes. The homepage field
stays **blank**: `watchside.app` has no certificate and `.app` is HSTS-preloaded,
so a browser refuses plain HTTP — a homepage URL there today is a dead link in a
public listing.

Permission justifications and privacy declarations are **not** duplicated here.
They live in the v0.8 submission handoff, so there is one source of truth.

---

## 8. Assets, and where they live

```
assets/store/current/
  contact-sheet.png            the whole sequence in one image, for acceptance
  SEQUENCE.md                  upload order and what each beat is for
  LISTING.md                   paste-ready copy
  chrome/    4 screenshots + chrome-promo-440x280.png
  firefox/   the same 4 + amo-header-1400x560.png
```

**Committed, unlike every other generated image here.** `.gitignore` ignores
`*.png` on purpose and already carves out one exception for the brand icons,
with the reason written beside it. Store screenshots need the same carve-out and
have a stronger case: they are photographs of live Twitch, so re-running the
capture produces a *different* picture, not the same one. Uncommitted, the set
the owner uploaded could not be recovered, compared against, or re-uploaded
after a listing edit.

**Chrome and Firefox share the sequence**, byte-identically. The product story
does not change between browsers, and a second set would be two things to keep
in step — with nobody noticing when one stopped.

**Promo tile and AMO header are unchanged.** Both are brand artwork rather than
product photography, both are current, and neither became inaccurate.

---

## 9. QA

`npm run assets:store` validates and assembles: dimensions, format, the
five-screenshot ceiling, promo and header sizes, and a duplicate check that
would catch a capture silently shooting the same state twice.

`tests/extension/storeAssets.test.ts` (12 tests) is the regression half:

- every screenshot in the sequence exists, at 1280×800, within the limit;
- Firefox's set is byte-identical to Chrome's;
- **the set is actually tracked by git** — the real risk, since `*.png` is
  ignored by default and an asset present on disk can be absent from the
  repository, discovered only when the originals are needed and gone;
- `SEQUENCE.md` names every screenshot in order with a beat rather than a
  filename;
- no stale branding; nothing over 3 MB.

Manually reviewed each image for private or debug content: no email addresses,
tokens, IDs, campaign codes, database identifiers or diagnostics. The panel
footer reads "demo mode — mock data", which is disclosure rather than leakage.

---

## 10. watchside.app

Checked once. **Still no certificate**; `https://watchside.app/` fails with
`ERR_TLS_CERT_ALTNAME_INVALID`. GitHub continues to report both hosts valid,
served by Pages, `caa_error: null`, `is_https_eligible: true` — queued, not
refused. DNS untouched, hosting unchanged.

Consequence for this milestone: the listing's homepage field stays blank and the
support/privacy URLs stay on the live Pages routes. No package change is
involved either way — the v0.8 extension never resolves the domain.

---

## 11. Store review state

**Owner-confirmed and retained: Chrome 0.7 live with 0.8 pending review; Firefox
0.6 awaiting first AMO review.**

There is no authorized tooling in this environment to inspect either store's
review state — no Chrome Web Store API credential, no AMO credential. Stated
rather than inferred, and the owner was not asked to check merely to fill in a
line.

---

## 12. What the owner does

**One visual decision, from one image:**

```
assets/store/current/contact-sheet.png
```

Four numbered beats with captions, in upload order. "Approved", or "change
screenshot N because X".

**Then, when v0.8 clears review** — listing edits and package review are
separate submissions in the Chrome dashboard, but the conservative order is to
let the package land first rather than editing the listing under an open review:

1. Store listing → screenshots: upload the four from
   `assets/store/current/chrome/`, in filename order.
2. Store listing → short and detailed description, single purpose: paste from
   `assets/store/current/LISTING.md`.
3. Support and privacy URLs: as in `LISTING.md`. Leave homepage blank.
4. Promo tile: unchanged, already uploaded.

**Firefox: nothing.** The set is prepared and waiting. Do not touch the pending
0.6 submission or its queue position.

---

## 13. Remaining

- **Firefox listing upload**, once Mozilla acts on 0.6 either way.
- **`watchside.app` TLS**, GitHub's to issue.
- **Homepage URL and the canonical `/c/` campaign route**, both of which follow
  TLS.
- **Marketing gate: CLOSED.** Unchanged by this milestone. Still needs v0.8
  distributed, TLS, the campaign route operational, and one real production
  acquisition bind sanity-checked.
