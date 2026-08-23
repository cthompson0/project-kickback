# Kickback — Twitch social presence

Kickback is a Chrome extension that brings ambient social presence back to the
internet: **see who's around, see what they're doing, and effortlessly join them.**

Kickback injects a panel directly into Twitch, detects which channel you're
watching, and shows which of your friends are around.

**Phase 0** proved the interaction model with mock data. **Phase 1** is making it
real: Checkpoint 3 (authentication) is done — you sign in with Twitch and
Kickback knows who you are. Real friends and real presence come next.

---

## Requirements

- Node.js 20.19+ (developed on 24.x)
- Google Chrome

## 1. Install dependencies

```bash
npm install
```

## 2. Start development

```bash
npm run dev
```

This runs `vite build --watch`, rebuilding `dist/` on every save.

## 3. Build the extension

```bash
npm run build
```

This type-checks (`tsc -b`) and then produces the production bundle.

## 4. Where the built extension is

```
c:\Users\sk8bo\Projects\Kickback\dist
```

`dist/` contains everything Chrome needs:

```
dist/
  manifest.json          MV3 manifest
  kickback-content.js    the whole panel, bundled as one content script
  popup.html             small toolbar popup (not the main interface)
  icons/                 extension icons
```

## 5. Open Chrome's extensions page

Go to `chrome://extensions`.

## 6. Enable Developer Mode

Toggle **Developer mode** in the top-right corner.

## 7. Load unpacked

Click **Load unpacked**.

## 8. Choose the build directory

Select the `dist` folder:

```
c:\Users\sk8bo\Projects\Kickback\dist
```

Select `dist` itself — not the repository root, and not `dist/icons`.

## 9. Open Twitch

Go to <https://www.twitch.tv/lirik> (or any channel).

## 10. Test Kickback

The Kickback panel appears at the top-right, just below Twitch's navigation bar.
See the manual test checklist below.

## 11. Make changes

Edit anything under `src/`. With `npm run dev` running, `dist/` rebuilds
automatically.

## 12. Rebuild and reload

There is no hot reload for content scripts — Chrome caches the injected script
per page load. After a rebuild:

1. Go to `chrome://extensions`.
2. Click the **reload** (↻) button on the Kickback card.
3. Refresh the Twitch tab.

Steps 1–2 are only needed when the bundle changes; a plain tab refresh is enough
if you only reloaded Chrome's copy already.

---

## Backend and authentication (Phase 1)

The Supabase schema, row level security and RPC layer live in `supabase/` —
see `supabase/README.md`.

```bash
npm test            # 451 tests: authorization, auth, presence, groups, emotes, bundle
npm run test:authz  # proves the authorization suite fails when a safeguard is removed
npm run test:emotes # same idea for the emote suite: break an invariant, expect red
npm run db:bundle   # one pasteable .sql for the Supabase SQL editor
npm run verify:config # asks Supabase whether your .env.local key actually works
npm run build:demo  # mock-data build into dist-demo/ (never load this as your real extension)
```

Copy `.env.example` to `.env.local` and fill in the Supabase project URL and
publishable key. `.env.local` is gitignored; the Twitch client secret and the
Supabase service-role key belong in the Supabase dashboard and must never enter
this repository.

### How signing in works

```
panel "Continue with Twitch"
  -> service worker: supabase.auth.signInWithOAuth (PKCE, skipBrowserRedirect)
  -> chrome.identity.launchWebAuthFlow opens id.twitch.tv
  -> Twitch redirects to <project>.supabase.co/auth/v1/callback
  -> Supabase exchanges the code with the client secret it holds
  -> Supabase redirects to https://<extension-id>.chromiumapp.org/?code=...
  -> service worker exchanges the code for a session (PKCE verifier)
  -> session stored in chrome.storage.local
```

The extension holds no client secret. Twitch tabs hold no session at all: the
content script talks to the service worker over a port and receives state.

### Extension identity

The manifest pins a public `key`, which fixes the extension id at
`almhfkicihekhiloapoimglfdoneglni` on every machine and profile. Without it
Chrome invents an id per install and the OAuth redirect URL —
`https://<id>.chromiumapp.org/` — would differ for everyone. The private half
lives in `.keys/` and is gitignored. Regenerating it changes the id and breaks
the registered redirect, so don't.

### Demo mode

`npm run build:demo` produces `dist-demo/` with the Phase 0 mock friends, for
working on the panel without a backend. Production builds contain none of that
code — `tests/extension/bundle.test.ts` asserts it — and production **never**
falls back to mock data when the backend is unreachable. It shows an error.

---

## Emotes (Phase 2B.1)

Group chat draws on three sources, in the order a typed name resolves:

1. **Kickback built-ins** — inline SVG, fixed ids, always available.
2. **7TV channel set** — for the Twitch channel *you* are currently watching.
3. **7TV global set** — always available once fetched.

A few decisions worth knowing about:

- **Identity is `provider + stable id`, never the name or the URL.** Names
  collide across providers, get renamed, and get removed from sets. Combos,
  de-duplication and history all key on the id.
- **Names resolve at send time.** Typing `OMEGALUL` sends
  `[[7tv|01F00Z…|OMEGALUL]]`, so the message records exactly which emote was
  meant. A message stays drawable after the emote leaves the channel, and two
  emotes that share a name are never confused for one another.
- **Precedence on a name collision: channel beats global beats nothing.**
  Kickback built-ins are unaffected — they use `:tokens:` and cannot collide.
- **The composer offers *your* channel's emotes, not a union of the group's.**
  A union would be unbounded, surprising, and would leak what other members are
  watching. Once sent it makes no difference: the recipient renders from the id.
- **Provider data is untrusted.** Ids and names are validated against strict
  patterns and the image URL is *derived* from the id — `data.host.url` from
  the payload is deliberately ignored, so a hostile response cannot point chat
  at an arbitrary host.
- **7TV is reached only from the service worker**, never from the Twitch page.

### Why there are no Twitch emotes

Every Twitch emote endpoint — global, channel, and user-entitled alike —
requires an OAuth token. Verified empirically: `GET
/helix/chat/emotes/global` returns `401 OAuth token is missing` with no auth
and with a Client-Id header. Obtaining and refreshing such a token needs the
Twitch client secret, which must stay in the Supabase dashboard and cannot
enter the extension. See the Phase 2B.1 report for what a server-side component
would involve.

## Manual test checklist

1. Open `twitch.tv/lirik` — the panel shows **You're watching LIRIK** and
   **Continue with Twitch**. No friends, no groups, nothing invented.
2. Click **Continue with Twitch**, authorise, and land back on Twitch. The
   header shows your Twitch avatar and the panel says *Your Kickback is quiet.*
3. Click your avatar — display name, `@twitchlogin`, friend code, Sign out.
4. **Groups** tab shows *Groups are coming.*
5. Reload Twitch, and navigate between channels — you stay signed in, and the
   current-channel line keeps up.
6. Close and reopen Chrome — still signed in.
7. Sign out — back to **Continue with Twitch**. Sign in again; it works.

## Project structure

```
src/
  core/                     platform-agnostic domain
    types.ts                User, Presence, Activity, Platform, Group
    presence.ts             here/gathering/sorting/duration helpers
  platforms/twitch/         everything Twitch-specific
    channels.ts             URL -> channel parsing, display names
    navigation.ts           SPA channel-change detection
    anchor.ts               where the panel sits relative to Twitch's nav
    join.ts                 navigate to a channel
  mock/                     Phase 0 stand-in for the presence service
    users.ts                user directory
    social.ts               friend list + groups
    presenceService.ts      seeded presence + gentle live drift
  ui/                       React panel
    KickbackPanel.tsx       shell: header, current activity, tabs, footer
    useKickbackState.ts     wires Twitch navigation + presence into React
    ErrorBoundary.tsx       fail closed so Twitch is never affected
    kickback.css            all panel styles (injected into a shadow root)
    components/             Avatar, PersonRow, FriendsTab, GroupsTab, JoinButton, Icons
  content/
    index.tsx               content-script entry: mounts the shadow-DOM host

public/                     copied verbatim into dist/
  manifest.json
  popup.html
  icons/
```

### Architecture notes

- **Domain first, Twitch second.** A friend is a `User` with a `Presence`; what
  they're doing is an `Activity` such as
  `{ type: 'watching', platform: 'twitch', channel: 'lirik' }`. Nothing in
  `core/` knows what Twitch is. There are no speculative abstractions for other
  platforms — just no decisions that would block one.
- **Twitch is never mutated.** Kickback appends one host element to `<body>`
  with its own shadow root and renders entirely inside it. No Twitch node is
  moved, wrapped, or removed, and no Kickback CSS can leak into the page.
- **SPA navigation.** A content script can't patch the page's `history` object,
  so channel detection polls `location.pathname` (400 ms) and also listens for
  `popstate`, `hashchange`, and `<title>` mutations.
- **Failure is silent.** An error boundary hides the panel rather than letting a
  Kickback bug affect Twitch.

### Mock data

Mock data lives in `src/mock/` and is deliberately shaped for testing:

- Jake and Matt sit on `lirik` so group aggregation is always demonstrable.
- Dave is always offline; Chris is often online but idle.
- Chris, Nina and Kenji wander between channels every 20–35 seconds so the panel
  feels alive.
- **Sarah follows you.** A few seconds after you open a channel she joins it, so
  the "my friends are already here" moment is reachable on any channel rather
  than only the handful baked into the seed data. See `DEMO_FOLLOWER_ID` in
  `src/mock/presenceService.ts`.
- Kenji belongs to *Late Night Crew* but is not on the friends list, because
  groups are conceptually independent of friendships.

---

## Known limitations (Phase 0)

- Everything is mocked and local. Nothing is shared between browsers or users.
- Join performs a full page navigation to `twitch.tv/<channel>`; Twitch's own
  router isn't reachable from a content script.
- Channel detection is path-based. Any non-reserved first path segment is
  treated as a channel, and a VOD or clip page counts as "watching" that
  channel.
- Display names come from a small lookup table plus capitalisation, not the
  Twitch API, so an unusual channel's casing may be slightly off.
- The panel floats above Twitch rather than being docked into its layout, so on
  narrow windows it overlaps the top of chat. It is collapsible for that reason.
- Group chat is a disabled visual placeholder only.
- Chrome only. No Firefox manifest, no mobile Twitch.
