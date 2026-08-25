# POST-P1B SHELL POLISH

**Date:** 2026-08-25
**Migration:** none — `0022_blocks.sql` remains the Block migration and is unchanged
**Status:** implemented, verified, real-browser gate passing
**Follows:** [p1b-block-unblock.md](p1b-block-unblock.md)
**Companion:** [../architecture/twitch-native-surface.md](../architecture/twitch-native-surface.md)

---

## P1B manual acceptance

Real two-account testing is **accepted**. Recorded here so it is not re-litigated:

| Behaviour | Result |
| --- | --- |
| Blocking an existing friend | works; friendship removed |
| Blocked user in the normal friend relationship | gone |
| Friend request across a block | refused, both directions |
| **New** group messages across the block | not delivered |
| **Historical** group messages already delivered | still visible — **accepted, by design** |
| Unblock | works; a new friendship can be established normally |

Already-delivered group messages are **not** retroactively removed. Block changes
what happens next; it is not a rewrite of what already happened, and a feature
that reached backwards into other people's transcripts would be a different and
much larger promise. The block filter is a `select` policy on `group_messages`,
so it governs delivery and reads from the moment it exists — which is exactly
the behaviour observed.

No P1B semantics changed in this checkpoint. `tests/db/blocks.test.ts` (36) was
re-run and passes unchanged.

## UserCard surface fix

**The bug.** `.kb-usercard` painted itself with `--kb-bg`, which is
`rgba(21, 21, 25, 0.97)`. That token is 97% opaque *and* is paired with
`backdrop-filter: blur(14px)` on `.kb-panel`. Against a video page that is the
right recipe: a little of Twitch shows through, softened. Over Kickback's own
content it is the wrong recipe entirely — the card has no blur of its own, so
opening it on a busy Gravity card let 3% of *unblurred* names, channels and
counts through behind its own names, channels and counts. Text ghosting under
text does not read as translucency. It reads as broken rendering.

**The fix** is a token, not a special case:

```css
/* For surfaces that float over Kickback's OWN content, not over Twitch. */
--kb-bg-popover: #1e1e24;
```

Opaque, one step lighter than the panel so the card still reads as layered
rather than merged into it. `z-index: 5` is unchanged — opacity is only half of
the problem, and a solid card stacked underneath would be worse than the bug.

**Audit of every other surface using `--kb-bg`:**

| Surface | Sits over | Verdict |
| --- | --- | --- |
| `.kb-panel` | Twitch | correct as-is — this is what the blur pairs with |
| `.kb-launcher` | Twitch | correct as-is, same reason |
| `.kb-usercard` | Kickback's own content | **fixed** |
| `.kb-emote-search` | the emote picker | an input's fill, not a floating surface — correct |
| `.kb-emote-picker` | nothing — it is **in flow** | `--kb-bg-raised` is deliberate; it pushes content rather than covering it |

So the UserCard was the only genuinely misapplied case, and the rule now has a
name that says which situation it belongs to. Nothing about the card was
redesigned: Profile, Mute, Remove friend, Block, the blocked state and the block
confirmation are all untouched.

## Account dismissal

The panel opened from the avatar in the header and closed only by pressing that
same avatar again — an interaction nobody discovers, because nothing on screen
says the avatar is a toggle.

**Added:** a header row inside `.kb-account` carrying a quiet `×`.

- a real `<button>`, so it is focusable and keyboard-reachable with no extra work
- `aria-label="Close account panel"`
- 22px hit area around a small glyph; `--kb-faint` until hover or focus
- calls `onClose` and nothing else — no sign-out, no layout reset, no account
  mutation. Closing a settings view should be the one action in it that cannot
  cost you anything.

**Escape** also closes it. The interesting part is that the UserCard already
listened for Escape, and two window listeners would have meant one press closing
both. The rule now is *innermost wins*:

- `UserCard` listens in the **capture** phase and calls `preventDefault()`
- `KickbackPanel` listens in the **bubble** phase and stands down on
  `event.defaultPrevented`

Capture always precedes bubble regardless of registration order, so this is
deterministic rather than dependent on mount sequence.

No bottom "Close" button was added.

## Blocked / Muted scaling

The smallest thing that works, and it is implemented rather than deferred:

```css
.kb-manage-scroll {
  max-height: min(24vh, 168px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

Both rosters scroll inside themselves. The same rule the emote picker already
uses (`.kb-emote-scroll`), for the same reason, so this is an existing pattern
rather than a new one.

Deliberate properties:

- **Below the cap nothing changes.** At N=1 there is no scrollbar and nothing
  reads as constrained. The common case is untouched.
- **The cap is on height, not on membership.** All N entries are rendered and
  all N remain reversible. Nothing is hidden behind a "show more".
- **No pagination, no network change, no moderation centre.** The blocked list
  already arrives whole from `list_blocked_users()`; at any plausible N that is
  a small array, and adding paging would be complexity bought against a problem
  nobody has.
- `overscroll-behavior: contain` so scrolling to the end of the roster does not
  then scroll the panel body, and never chains out to the Twitch page.

The requirement this satisfies is the one that mattered: the account panel is no
longer an unbounded architecture. Sign out and Reset layout keep their positions
whatever N is.

## Collapsed launcher dragging

The panel was draggable; the launcher was not, so repositioning Kickback meant
expanding it first. The infrastructure was already most of the way there —
`usePanelLayout` has always tracked a `footprint` that is `LAUNCHER_SIZE` when
collapsed, and `clampCollapsed` already existed. **No second drag implementation
was created.** What was added:

**1. A drag path the launcher can use.** `begin()` gained one option:

```ts
begin('drag', 's', event, { fromHandle: false })
```

`fromHandle: false` does two things it cannot share with the panel header. It
skips the `isInteractive` guard — that guard exists so a drag from the header
does not swallow the minimise button, and the launcher *is* the button, so there
is nothing to protect. And it skips `preventDefault()`, so the press is still
allowed to become a click when it turns out not to have been a drag.

**2. Click-versus-drag.** `CLICK_SLOP = 4` and `movedBeyondSlop()` in
`layout.ts`, pure and exhaustively tested. A click always follows a press, so
without this every drag would also open the panel — and moving Kickback out of
the way would be the one gesture that puts it back in the way. Four pixels
forgives the wobble in an ordinary click without swallowing a deliberate move.

**3. The gesture starts from what is on screen.** A collapsed launcher is drawn
at a *clamped* position, not the stored one. Starting the gesture from the
stored rectangle gave the launcher a dead zone: a panel parked at the bottom
edge collapses to a launcher pulled up to stay reachable, and a drag would spend
its first fifty pixels moving a number nobody can see. `begin()` now starts from
`clampCollapsed(current, viewport)` when collapsed.

**4. Expanding stays sensible.** A 42px launcher can sit in the bottom-right
corner quite happily; the 320px panel that opens from it cannot. The `rendered`
memo now applies the panel's own `clampPosition` when expanded — provably a
no-op for every position a *panel* drag produced (it was clamped that way
already), and load-bearing only for positions a *launcher* drag produced.

Everything else is inherited: one coordinate system, one `kickback:layout`
localStorage record, the same viewport-bounds enforcement, the same
`fitIntoViewport` recovery when the window changes shape, the same pointer
capture on `window` so a fast drag that outruns the element still tracks. The
launcher cannot be left unreachable — `clampPosition` with the launcher
footprint keeps all 42px on screen, which is stricter than the panel's own rule.

## Tests

| Suite | Added | Covers |
| --- | --- | --- |
| `tests/extension/layout.test.ts` | 8 | click-vs-drag slop in every direction; launcher drag follows the pointer; cannot be thrown off screen at three viewports; a panel opening at a launcher's corner stays reachable; the clamp is a no-op for panel-drag positions |
| `tests/extension/shellPolish.test.tsx` | 12 | opaque token with no alpha in any form; card still stacked above; every action preserved; block confirmation intact; `×` present with accessible name; nothing fires on render; Escape precedence pinned in both files; 60-entry roster scrolls and still lists all 60; muted roster bounded the same way; N=1 unchanged; the two rosters stay separate |
| `scripts/verify-test-lab.mjs` | 1 scenario | **real browser, real mouse** |

The launcher scenario uses CDP `Input.dispatchMouseEvent` rather than synthetic
events, deliberately: the whole question is whether the browser turns one press
into a drag or a click, and a dispatched `PointerEvent` would prove nothing
about the browser's own answer. It minimises through the real control, drags in
four steps, and asserts the launcher moved to within 2px of the expected
position, that the panel did **not** open, that the position persisted, and that
a subsequent motionless click **does** open Kickback. It restores localStorage
afterwards so the gate stays idempotent.

## P1B regression

| Check | Result |
| --- | --- |
| `tests/db/blocks.test.ts` | 36 passed, unchanged |
| Block, unblock, blocked friend request | covered above, unchanged |
| Group message filtering | unchanged — `group_messages` policy untouched |
| Presence invalidation | unchanged |
| Contextual session invalidation | unchanged |
| Full extension + core suite | 1316 passed |

No P1B behaviour changed. The one file this checkpoint touched that P1B also
touched is `UserCard.tsx`, and the change there is the Escape phase — the block
control, its confirmation and the blocked state are byte-identical.

## Deployment

**No migration.** `0022_blocks.sql` is unchanged and remains the Block
migration; it is still not applied to hosted. No Supabase function deployment.
No schema, RPC, RLS or analytics contract was touched — this checkpoint is CSS,
three components and one hook.

## Verification

| Gate | Result |
| --- | --- |
| `tests/extension` + `tests/core` | 1316 passed (48 files) |
| `tests/db/blocks.test.ts` | 36 passed |
| `npm run test:lab` | 121 passed |
| `npm run verify:lab` (real browser, CDP) | 10 scenarios passed |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |

Full mutation universe not run. `test:analytics` not run. Nothing exceeded five
minutes.

## Manual retest

1. Open a UserCard over a busy Gravity card → background opaque, no bleed-through.
2. Open the account panel → `×` visible top-right → click closes it.
3. Reopen → press Escape → closes. With a UserCard open, one Escape closes the
   card and leaves the account panel open; a second closes the panel.
4. Collapse Kickback to `K`.
5. Drag `K` elsewhere → it moves with the pointer, does not open.
6. Click `K` → Kickback opens at a sensible position.
7. Collapse again → the launcher is where it was left; reload → still there.
8. Block/Unblock sanity → unchanged.

## Git

One commit, `polish: improve kickback shell UX`. Full diff reviewed; no
`.env.local`, no service-role key, no JWT, no client secret, no database dump,
no `dist/`, no release archive, no analytics test output, no mutation residue.
