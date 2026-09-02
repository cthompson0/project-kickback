# Chrome v0.8.0 — submission handoff

**Date:** 2026-09-02
**Decision:** submit v0.8.0 to the Chrome Web Store (owner-confirmed)
**Preceded by:** M5E — release convergence (`docs/reports/m5e-release-convergence-2026-09-02.md`)

---

## 1. The artifact

**Do not rebuild it.** The accepted package is on disk and verified unchanged.

| | |
| --- | --- |
| File | `releases/Watchside-Store-v0.8.0.zip` |
| SHA-256 | `cb3af261448280cb33866a4b466fa186dd2bdc691db31e0116766e5ee15e19a0` |
| Size | 186,424 bytes |
| Version | 0.8.0 (manifest and `package.json` agree) |
| Source commit | `e2fe5bd`, tree clean |

Re-verified at handoff time without rebuilding: the hash still matches the M5E
evidence exactly, and `npm run verify:candidate` passes against the file itself —
thirteen markers proving it carries M3D, M5A, M5B, M5C and M5D, and none of the
five forbidden markers (`user:read:subscriptions`, `user:read:emotes`,
`SUPABASE_SERVICE_ROLE`, `service_role`, `sourceMappingURL`).

There is no automated upload path in this repository and no Chrome Web Store API
credential in the environment, so submission is genuinely an owner action rather
than something withheld.

---

## 2. What actually changes on the Store form

M5E recorded this as *"confirm the permission justification covers
`user:read:follows`"*. Inspecting the actual dashboard fields recorded in
`docs/checkpoints/chrome-web-store-private-beta-readiness.md`, that framing needs
correcting:

**There is no Chrome Web Store field for a Twitch OAuth scope.** The
justification fields cover Chrome *manifest* permissions — `identity`, `storage`,
`alarms`, `notifications` — plus host permissions, remote code, single purpose
and the data-use disclosures. `user:read:follows` is a Twitch API scope granted
on Twitch's own consent screen; the Store never asks about it directly.

So nothing is *required* by the form. What is worth changing is one field, for a
concrete reason:

### `identity` permission justification — RECOMMENDED, not required

A reviewer who runs the sign-in flow sees Twitch's consent screen say **"View the
list of channels you follow."** Nothing in the current listing explains why a
friends-list extension asks for that, and an unexplained scope on a consent
screen is a realistic cause of a review question or rejection. The existing
justification also still says *"Kickback"*, which no longer matches the listing.

**Exact replacement text:**

> Used to sign the user in with their Twitch account via
> `chrome.identity.launchWebAuthFlow`. Watchside holds no OAuth client secret and
> never sees the user's Twitch password.
>
> Sign-in requests one read-only Twitch scope, `user:read:follows`. Watchside
> uses it for a single private check: when the user clicks JOIN to watch a
> channel a friend is on, it records whether that user already followed that
> channel. This is how we measure, in aggregate, whether Watchside introduces
> people to creators they did not already follow. It is never shown to friends or
> to anyone else, Watchside never follows or unfollows anything on the user's
> behalf, and no subscription, Bits, payment or emote data is requested or
> accessible.

Every clause is checkable: the scope list is one constant
(`REQUESTED_SCOPES` in `src/background/auth.ts`), the check happens at a socially
initiated JOIN, the Twitch credential lives server-side and is stripped from
browser storage on read (`stripProviderCredentials`), and relationship state has
no client read path at all.

### Everything else on the form — LEAVE UNCHANGED

`storage`, `alarms`, `notifications`, the three host permissions, the host-access
justification, remote code, single purpose and category are all still accurate
for 0.8.0. (If those fields also still say "Kickback", swapping the word for
"Watchside" is cosmetic and safe, but nothing in them is factually wrong.)

---

## 3. Data / privacy declarations

**NO DATA DECLARATION CHANGE REQUIRED.**

Compared the candidate's actual behaviour, `docs/PRIVACY.md`, and the recorded
dashboard answers:

| Dashboard category | Declared | Still correct for 0.8.0? |
| --- | --- | --- |
| Personally identifiable information | Yes | yes — unchanged |
| Authentication information | Yes | yes — unchanged |
| Personal communications | Yes | yes — unchanged |
| User activity | Yes | **yes — this is where both new things land** |
| Web history | **No** | **still No** |
| Health / financial / location / website content | No | unchanged |

**M3D** records whether the user already followed a channel at the moment they
pressed JOIN. That is activity on Twitch, in the category already declared
*Yes*. It is not web history: no URLs, no navigation trail, no other site, and
nothing outside the channel the user chose to join.

**M5C** records an opaque campaign code that Watchside itself issued — the same
string for everybody who follows a given link, carrying nothing about the person.
It is not personally identifiable information, and it is not web history: it
records which Watchside link somebody arrived through, not where they have been.
It also falls under user activity.

The three Limited Use certifications remain honestly true: not sold, not
transferred for unrelated purposes, not used for creditworthiness or lending. No
third-party analytics, pixels or advertising SDKs exist in the package.

**The privacy policy already describes both**, in plain language, under *"The
Twitch authorisation Watchside stores"*, *"The one check Watchside makes with
it"* and *"How you found Watchside"*. The published policy is live at
`https://anoteros-labs.github.io/watchside/privacy/` and is generated from
`docs/PRIVACY.md`, so the two cannot drift.

---

## 4. Release notes

Paste into the Store's release-notes field:

```
Getting started is clearer. Watchside now explains what it does before asking
for anything, suggests people you may know through friends you already have,
and tells you when your friends are online but nothing is on — instead of
showing an empty panel either way.

There's a support page you can reach even when the panel won't open, linked
from the account panel.

When something goes wrong, Watchside now says what happened in plain language
rather than showing an internal error message.

Easier to read and easier to use without a mouse: better contrast on faint
text and on the JOIN button, and the panel now announces itself properly to
screen readers.

Badges show what there is still to earn, not just what you've earned. Groups
now explain how they differ from the tab that appears while you're watching
alongside someone.
```

Nothing about measurement, milestones, schema or instrumentation. The fuller
version is in `CHANGELOG.md` under `## 0.8.0`.

---

## 5. Store assets

**YES — the current assets are accurate enough to submit unchanged.**

`screenshots/store-01-presence.png`, `store-02-gravity-join.png`,
`store-03-together.png` and `assets/store/out/chrome-promo-440x280.png` were
generated for 0.7.0. Since then the panel's layout, tabs, controls and flow are
identical; what changed is one shade of purple behind the JOIN button and the
brightness of some secondary text. A slightly different accent is not misleading
about what the product is or does.

Store Assets remains the next dedicated step and is **not** started here.

---

## 6. watchside.app HTTPS

**Still provisioning. Not usable, and not blocking this submission.**

Checked once: no certificate issued; `https://watchside.app/` fails with
`ERR_TLS_CERT_ALTNAME_INVALID`. GitHub continues to report both apex and `www`
as valid, served by Pages, `caa_error: null`, `is_https_eligible: true` —
queued, not refused. **DNS was not touched.**

The v0.8.0 extension never resolves `watchside.app`; invite links still point at
the live Pages route, which answers 200. Nothing in the submission depends on
the domain.

---

## 7. M3D live acceptance — stated exactly as M5E left it

**M3D is accepted in the candidate through deterministic, package and server
evidence, but one real end-to-end JOIN acceptance remains unrun.**

Not weakened, not exaggerated. `npm run verify:m3d` refuses to start without two
owner-held items, which is the behaviour it was built to have after two real
human JOINs were spent discovering setup state.

To run it later — no secrets in chat, nothing pasted anywhere shared:

1. Restore `scripts/firefox-e2e/seeds.json` (the two canonical seed profiles;
   see `scripts/firefox-e2e/seeds.example.json` for the shape).
2. In a terminal, set the token for that shell only — it is the same value as
   `TWITCH_EVENTSUB_ADMIN_TOKEN` in Supabase Function secrets:

   ```
   $env:WATCHSIDE_ADMIN_TOKEN = '<paste locally, not into any chat>'
   npm run verify:m3d
   ```

Exit code 3 means a precondition was not met and **no JOIN was spent**. The
harness drives the browsers itself; no human generates a JOIN.

This can be done before or after submission. It is not a gate on shipping — the
alternative to shipping unverified is M3D continuing to measure nobody, which it
has done since before 0.7.0.

---

## 8. Owner submission checklist

1. Open the **Chrome Web Store Developer Dashboard** and select **Watchside**
   (item `ngfopkeokddfnncdhfkhnffilbdhkkip`).
2. **Package → Upload new package**, and choose
   `releases/Watchside-Store-v0.8.0.zip`.
3. **Privacy practices → Permission justification → `identity`**: replace with
   the text in §2. Leave every other justification unchanged.
4. **Privacy practices → data collection**: change nothing (§3). Confirm the
   three Limited Use certifications are still ticked.
5. **Store listing → release notes**: paste §4.
6. Leave the listing name, description, category, screenshots and promo tile
   unchanged (§5).
7. **Submit for review.**

Nothing else needs touching. Do not submit anything to Firefox.

---

## 9. Firefox

**KEEP WAITING.** v0.6 is still in its first AMO review. Do not upload v0.8.0,
do not withdraw v0.6, do not reset the queue.

`Watchside-AMO-Candidate-v0.8.0.zip` (`acef1c34…`) and
`Watchside-AMO-Source-v0.8.0.zip` (`580f33ea…`) are already built and verified,
so replacement is same-day ready the moment Mozilla acts either way.

---

## 10. Marketing gate

**WAITING FOR DISTRIBUTION.** Submitting Chrome does not open it.

Meaningful growth still needs all five:

1. Chrome v0.8.0 approved and live
2. `watchside.app` serving HTTPS
3. the canonical campaign URL operational — campaign links exist only at
   `watchside.app/c/<code>`, so this follows from 2
4. one real production campaign touch binding to an account
5. the resulting acquisition data sanity-checking

No paid, creator, TikTok or X campaigns yet. Organic beta activity continues.
