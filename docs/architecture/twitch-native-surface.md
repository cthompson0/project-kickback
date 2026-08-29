# TWITCH-NATIVE KICKBACK SURFACE

**Date:** 2026-08-25
**Status:** architecture audit — **nothing here is implemented**
**Scope:** feasibility only. No right-rail mode, no mode setting, no dock/pop-out
control, no duplicated UI, no change to Twitch injection.

The hypothesis under test is **one Watchside, multiple presentations** — not
"replace floating Watchside with native Watchside". See *Beta feedback*.

---

## Current mounting architecture

Read from `src/content/index.tsx`, `src/platforms/twitch/*` and
`src/ui/layout/*`, not assumed.

```
document.body
└── <div id="kickback-host">            position:fixed; inset:0; pointer-events:none
    └── #shadow-root (open)
        ├── <style>  ← kickback.css, inlined at build time
        └── <div class="kb-root">        position:absolute; inset:0; pointer-events:none
            └── .kb-panel | .kb-launcher  position:absolute; left/top from CSS vars
```

Five properties of this that matter to everything below:

1. **One host, appended to `<body>`.** Twitch's own React tree is never touched.
   There is currently *no* code path that writes into Twitch-owned DOM.
2. **Shadow DOM already.** Styles are inlined into the shadow root, so nothing
   leaks either way. Twitch's CSS cannot reach us and ours cannot reach Twitch.
3. **The layer is inert.** `pointer-events: none` on both the host and
   `.kb-root`; only `.kb-panel` and `.kb-launcher` set `pointer-events: auto`.
   Twitch behaves exactly as if Watchside were not present.
4. **Twitch is measured, never depended on.** `measureTopOffset()` reads the
   bottom of the top-level `<nav>`; `measureChatRail()` reads the rail's width.
   Both feed the **default placement only** — once the user has moved the panel,
   their stored layout wins and neither measurement is consulted again. A wrong
   answer costs at most a worse first placement.
5. **Two repair mechanisms exist already.** `keepAttached()` re-appends the host
   if it ever leaves the document; `hideDuringFullscreen()` hides it on
   `fullscreenchange`.

**State lives in the service worker, not the panel.** `useKickbackState(client)`
is `client.getState()` plus `client.subscribe()`; auth, presence, friends,
Gravity, the contextual session, groups, unread and realtime are all owned by
the background worker and mirrored into React. The panel is a *view*. This is
the single most important finding in this document — see *Shared application
state*.

**Presentation is already isolated.** Everything about where Watchside sits is in
`src/ui/layout/` (`layout.ts` — pure geometry; `usePanelLayout.ts` — pointers,
storage, viewport) plus two CSS rules, `.kb-panel` and `.kb-launcher`. Nothing
else in the component tree knows the panel floats.

## Why investigate native mounting

The floating overlay is discoverable and movable, but it is unmistakably *an
overlay*. On a stream page the eye already has a right-hand column; a Watchside
that lived there would be where people are looking, would not need to be
positioned, and would not cover anything they chose to keep.

## Beta feedback

**A tester specifically valued positioning Watchside over and around real Twitch
chat.** That is a use, not a workaround.

So floating mode is **not** a temporary scaffold and must not be treated as one.
Whatever else gets built, the floating presentation stays an available mode. Any
plan that reads "migrate to the rail" rather than "add the rail" is the wrong
plan. Recorded here because the default choice is the thing most likely to be
quietly reversed later by someone who does not know a real user asked for it.

## Candidate Twitch anchors

Already discovered empirically and in production use in `chatRail.ts`, most
specific first:

| Anchor | Notes |
| --- | --- |
| `[data-test-selector="chat-room-component-layout"]` | Twitch's own test hook; the chat body |
| `[data-a-target="right-column-chat-bar"]` | Twitch's own targeting hook; the rail container |
| `.channel-root__right-column--expanded` | semantic class, last resort |

Two lessons already paid for and encoded in that file:

- **`data-a-target` / `data-test-selector` are far more stable than class
  names.** Twitch's class names are styled-components hashes
  (`Layout-sc-1xcs6mc-0 kaoNZj`) that change without warning. The semantic
  `channel-root__*` names are the exception.
- **The rectangle is not always sane.** On a logged-out page the rail is laid
  out at `x === window.innerWidth` — entirely off screen — while still
  reporting a 340px width. Every measurement is sanity-checked against the
  viewport and anything implausible reads as "no rail".

### Brittleness by situation

| Situation | Rail present | Risk |
| --- | --- | --- |
| Normal stream page | yes | baseline |
| Theatre mode | yes, narrower | low — same anchors, different width; must re-measure |
| Fullscreen | no | already handled: `hideDuringFullscreen()` |
| Chat collapsed | anchor absent or zero-width | **must fall back**; `measureChatRail` already returns 0 |
| Chat expanded | yes | low |
| Narrow viewport | rail may be hidden entirely | must fall back |
| SPA navigation | rail is **replaced**, not moved | **highest risk** — see below |
| Ads | rail unaffected (ads are in the player) | low |
| Offline channel | rail usually present | low, but must not be assumed |
| Non-channel pages (directory, settings) | no rail | must fall back |

**SPA navigation is the hard one.** Twitch's router lives in the page's JS
world, so a content script cannot patch `history.pushState` to observe it —
`navigation.ts` polls the URL every 400ms and additionally watches `popstate`,
`hashchange` and `<title>` mutations. A rail mount must therefore survive the
rail node being destroyed and a new one created underneath it, on a signal that
can arrive up to 400ms late. That is not fatal — it is the same class of problem
`keepAttached()` already solves for `<body>` — but it needs a
`MutationObserver` scoped to the rail's parent, and a defined behaviour for the
window in which no rail exists.

## Chat preservation

**Strong recommendation: overlay within the rail. Never hide, remove, reparent
or restyle a Twitch node.**

The options, worst to best:

| Strategy | Chat outcome | Verdict |
| --- | --- | --- |
| Replace the rail's children | destroyed and recreated: reconnect, lost scroll, lost draft | **no** |
| Reparent Twitch chat into our tree | React loses its container; unpredictable | **no** |
| `display: none` on Twitch chat while Watchside is shown | tree survives and the socket survives, but `display:none` drops layout and **scroll position is reset on restore** | risky |
| `visibility: hidden` / offscreen transform | keeps scroll, but restyles a Twitch node — a class Twitch may re-apply at any render | risky |
| **Absolutely-positioned overlay inside the rail** | Twitch chat is never touched at all: still laid out, still scrolled where it was, still connected, draft intact | **recommended** |

The overlay strategy makes exactly **one** mutation to Twitch's DOM — a single
`appendChild` of our own host element — and no mutation to any node Twitch owns.
Everything that could break chat is therefore off the table by construction:
no reconnect, no lost scroll, no destroyed DOM, no lost draft, no duplicate chat
instance, because chat is never involved.

The cost is honest and should be stated plainly: while Watchside is shown, chat
is rendered underneath it and continues to consume layout and paint. That is a
small amount of wasted work in exchange for a guarantee.

**The `Stream Chat | Watchside` switch should live in our overlay, not in
Twitch's header.** Injecting a tab into Twitch's own header row means matching
their markup, their styles and their state — the brittlest thing we could
possibly do — and it is the part most likely to break on a Twitch redesign. A
slim strip at the top of our own overlay, with `pointer-events` only on the
strip itself and pass-through everywhere else, gives the same affordance while
covering roughly 32px of the rail. Whether that overlap is acceptable is a
question for a prototype, not for this document.

## SPA / navigation behaviour

What a rail shell needs that the floating shell does not:

1. A `MutationObserver` on the rail's stable ancestor (the channel root), to
   notice the rail being replaced.
2. Re-measure on `resize`, on theatre-mode toggle (observable as a rail size
   change), and on every channel change already emitted by `watchChannel`.
3. A defined state for "no rail right now" — which is the fallback, below.

`watchTopOffset` already polls at 1000ms and `watchChannel` at 400ms; a rail
observer would be event-driven rather than a third timer.

## Floating vs right-rail

| | Floating | Right rail |
| --- | --- | --- |
| Twitch DOM dependency | **none** | one anchor, re-resolved on navigation |
| Works on non-channel pages | yes | no |
| Works in fullscreen | hidden by design | hidden with the rail |
| User can position it | yes — a tester asked for this | no, by definition |
| Covers Twitch chat | only if the user chooses to | yes, while shown |
| Feels native | no | that is the point |
| Breaks if Twitch redesigns | no | yes — needs the fallback |

Neither dominates. Floating is more robust and more controllable; the rail is
more native and needs no positioning. **There is not yet enough evidence to
choose a default**, and the one piece of real user evidence we have argues for
keeping floating.

## Shared application state

**Answer: yes, cleanly, and the repository already supports it.**

- All application state — auth, presence, friends, Gravity, the contextual
  session, groups, unread, realtime, settings — lives in the **service worker**.
- The panel reads it through `client.getState()` / `client.subscribe()`. It
  holds no application state of its own; the only local state is view state
  (which tab, which card is open, which group is open).
- `createClient()` is called **once** per content script and the single client
  is passed in. Two shells rendered from that one client would share one logical
  Watchside with no synchronisation code at all — and one port, one realtime
  subscription, one presence heartbeat.

The only thing genuinely coupled to floating is `src/ui/layout/` plus the
`.kb-panel` / `.kb-launcher` CSS. Everything else is placement-agnostic already.

So the shell split is not a rewrite; it is drawing a line where one effectively
exists:

```
KickbackClient (service worker state, one instance)
        │
        └── <KickbackBody />        tabs, Friends, Gravity, session, Groups, account
                │
   ┌────────────┴────────────┐
FloatingShell            TwitchRailShell
 usePanelLayout           rail anchor + overlay
 drag / resize / collapse  Stream Chat | Watchside switch
 .kb-panel / .kb-launcher  fills the rail; no geometry
```

**Do not force this if a smaller change suffices.** What the code actually
supports today: `KickbackPanel` currently owns both the shell and the body in
one component (~600 lines), so the honest first step is *extracting* the body
rather than inventing an abstraction around it. The extraction is mechanical —
the body already receives everything it needs through `view` and `client` — but
it is real work and should be its own phase, done once, with the floating shell
as the only consumer, before any rail code exists.

## Mode switching

Architecturally straightforward, given the above. What would need to persist:

| Value | Where | Why |
| --- | --- | --- |
| chosen mode (`floating` \| `rail`) | `localStorage`, beside `kickback:layout` | must be readable synchronously on the first frame, exactly like the layout, or the shell flickers |
| floating geometry | `kickback:layout` — **already exists** | switching to the rail and back must return the panel where it was |
| collapsed | `kickback:collapsed` — **already exists** | |
| rail selection (chat vs Watchside) | session-scoped, not persisted | a per-visit choice, not a setting |

Nothing else. Tab, open card and open group are view state and can be discarded
across a mode switch, or preserved trivially by lifting them if it turns out to
matter.

Not designed here, and deliberately: what the control looks like, where it sits,
and whether pop-out (a real window) is a third mode.

## Failure / fallback behaviour

**Practical, and strictly weaker than the primary requirement.** Floating mode
needs *no* Twitch DOM at all — the host attaches to `<body>` and every Twitch
measurement is already optional with a defined zero. So "the rail anchor is
missing" is not an error state that needs inventing; it is the state Watchside
runs in today on every non-channel page.

The rule should be: **the rail is an enhancement over floating, never a
replacement for it.**

- anchor resolves → mount the overlay in the rail
- anchor missing, zero-width, off-screen, or fails the existing plausibility
  checks → floating launcher, exactly as now
- anchor disappears mid-session (navigation, chat collapsed, theatre toggle) →
  return to floating rather than disappearing
- anchor reappears → return to the rail if that is the chosen mode

This means a Twitch redesign that breaks every selector degrades Watchside to
what it is today, which is a working product. That is the property worth
protecting above all others in this area.

## Twitch DOM brittleness

| Risk | Assessment |
| --- | --- |
| DOM replacement on navigation | **real.** The rail is recreated. Needs a `MutationObserver` plus the fallback. |
| React hydration / reconciliation | **low, if we only append.** React does not remove unknown children of a node it manages unless it re-renders that node's children wholesale — which navigation does. That is the same case as above, handled the same way. Never insert *between* Twitch's own children. |
| CSS collisions | **none.** Shadow DOM, both directions, already. |
| z-index | host is `2147483000`. Inside the rail it would need to sit above chat but below Twitch's own modals; this becomes a real question only in overlay mode and is answerable by measurement, not by guessing. |
| Width calculations | rail width varies with theatre mode and viewport. `measureChatRail()` already handles the plausibility checks; a rail shell would size to the anchor rather than to the viewport. |
| MutationObserver cost | `keepAttached()` already observes `document.body` `childList`. A rail observer scoped to the channel root is comparable. |
| Shadow DOM boundaries | our own boundary stays. Note the existing gotcha, already handled in `UserCard`: **the shadow root retargets events**, which is why its outside-click listener uses `composedPath()` and capture. Rail mode does not change this. |
| Twitch experiments / A-B layouts | **unquantified, and the honest gap in this audit.** We have one selector list that worked on the pages we measured. We do not know how many layout variants Twitch is currently running. This is the strongest argument for the fallback and for a measurement phase before any build. |

## Security / extension constraints

Answered from the manifest and the injection code, not speculated:

- **No new permissions.** The content script already runs on
  `https://www.twitch.tv/*` and `https://twitch.tv/*` at `document_idle`.
  Mounting elsewhere *in the same document* requires nothing further.
- **No new CSP surface.** Styles are injected as a `<style>` element into our
  own shadow root by a content script in the isolated world — identical
  mechanism, different parent node. Avatar images already load from Twitch and
  7TV CDNs in the current mount, which is proof rather than inference.
- **No iframes.** Watchside does not use one and rail mode would not introduce
  one. Twitch chat is not an iframe on the channel page.
- **Event isolation is unchanged.** Content scripts run in an isolated world;
  page scripts cannot see our listeners and we cannot see theirs. The shadow
  boundary retargets events for both sides.
- **No secrets move.** The panel never holds a provider token; auth lives in the
  service worker. Rail mode does not touch that boundary.

**The one genuine change:** today Watchside writes into `document.body` only.
Rail mode writes one `appendChild` into a Twitch-controlled subtree. That is not
a policy or security concern, but it is the first time we would be a guest in
somebody else's node, and it is why the fallback is non-negotiable.

## Recommended architecture

1. **One client, one state.** Never two Watchside instances. The service worker
   is already the single source of truth; nothing needs to change to keep it
   that way.
2. **Extract the body from the shell** — one mechanical refactor, landed on its
   own with floating as the only consumer.
3. **Overlay, never surgery.** One `appendChild`. No Twitch node hidden, moved,
   restyled or removed. Chat preservation then requires no mechanism at all.
4. **The switch lives in our overlay**, not in Twitch's header.
5. **Rail is an enhancement; floating is the floor.** Every failure path leads
   back to the floating launcher.
6. **Floating stays a first-class mode permanently.** A user asked for it.

## Implementation phases

| Phase | Work | Ships? |
| --- | --- | --- |
| 0 | **Measure.** Instrument anchor resolution across theatre / collapsed / offline / directory / narrow / logged-out and across whatever Twitch layout variants show up. Answer the experiments question with data. | no |
| 1 | **Extract `KickbackBody`** from `KickbackPanel`; floating shell is the only consumer. Behaviour-identical, fully covered by existing tests. | yes, invisibly |
| 2 | **`TwitchRailShell`, throwaway prototype.** Overlay in the rail, hard-coded on, no setting, no switch. Answer: does chat genuinely survive untouched, and is a 32px strip tolerable? | no |
| 3 | **Fallback machinery.** Anchor resolution, `MutationObserver`, navigation handling, degrade-to-floating. This is the phase that decides whether the feature is safe. | no |
| 4 | **The switch and the mode setting**, persisted as above. | yes |
| 5 | Reconsider the default, with usage data from 1–4. | — |

Phase 0 gates everything. Phase 3 is the one most likely to be underestimated.

## Risks

1. **Twitch layout variants we have not seen.** Unquantified. Mitigated by the
   fallback, but it means a rail mode may simply not appear for some users.
2. **Phase 3 being skipped** because Phase 2's prototype looked fine on one
   machine. The prototype is the easy part; surviving navigation is not.
3. **Silent default drift** — a future checkpoint making the rail the default
   because it "feels finished", against the one piece of real user evidence we
   have. Recorded in *Beta feedback* precisely so this cannot happen quietly.
4. **The 32px strip** turning out to be genuinely irritating, which would push
   toward inserting into Twitch's flow — the brittle option this document
   recommends against. Worth knowing before Phase 4, not after.
5. **Two shells drifting.** Mitigated by Phase 1 landing first: if the body is
   extracted before any rail code exists, there is nothing to duplicate.

## Recommendation

**DEFER.**

Not because it is a bad idea — the audit found no blocker, the state
architecture already supports it cleanly, and the overlay strategy makes chat
preservation a non-problem rather than a hard problem. Defer because:

- **The immediate goal is testers, quickly.** Watchside works today. A rail mode
  is at least five phases, one of which (Phase 3, navigation and fallback) is
  the kind of work that is only ever finished by meeting the real page.
- **Phase 0 has not been done.** We would be building against one selector list
  that worked on the pages we happened to measure. Committing to a native
  surface without knowing how many Twitch layout variants exist is committing to
  an unknown amount of maintenance.
- **The evidence points the other way.** The one real user signal we have says
  the floating overlay is *valued*, not tolerated. That is an argument for
  shipping and gathering more, not for building the alternative first.
- **The cheap half is worth doing anyway.** Phase 1 — extracting the body from
  the shell — is a small, well-tested, behaviour-neutral refactor that makes the
  codebase better whether or not a rail mode is ever built, and it is what makes
  Phase 2 a prototype rather than a rewrite.

**Recommended next action:** ship what exists, get it in front of testers, and
carry Phase 0 as passive measurement while they use it. Revisit with data.
