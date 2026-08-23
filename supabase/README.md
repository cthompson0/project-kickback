# Kickback backend (Supabase)

Postgres schema, row level security, and the RPC layer for Phase 1.

## Applying the migrations

The files in `migrations/` are ordinary SQL and must run **in filename order**.

```
0001_schema.sql          tables, constraints, indexes
0002_policies.sql        privileges + row level security
0003_rpcs.sql            every mutation, plus the read helpers
0004_auth_bootstrap.sql  auth.users -> Kickback identity
0005_realtime.sql        realtime publication (Supabase only; no-op elsewhere)
```

To apply them to the hosted project, generate a single pasteable script:

```bash
npm run db:bundle
```

then open **Supabase → SQL Editor → New query**, paste the contents of
`supabase/.generated/apply_all.sql`, and run it. It is safe to run more than
once (`create table if not exists`, `create or replace function`,
`drop policy if exists`).

The Supabase CLI is deliberately *not* required: `supabase db push` needs the
database password, and this project does not ask for it.

## What the database guarantees

The security model does not depend on the extension behaving itself.

- **Clients hold `SELECT` and nothing else.** `0002` revokes INSERT/UPDATE/DELETE
  from `anon` and `authenticated` on every table. Supabase's default privileges
  grant those automatically, so the revokes are load-bearing.
- **`anon` has no access at all.** An unauthenticated caller cannot read a row
  or execute an RPC.
- **All mutations go through `SECURITY DEFINER` functions** whose actor is
  always `auth.uid()`. No function takes an actor id, so there is nothing for a
  client to forge.
- **Presence is stored pre-redacted.** `report_presence()` applies the caller's
  own privacy setting *before* writing, so a hidden channel is not filtered on
  read — it was never persisted.

## Friendship representation: mirrored rows

Evaluated as requested before freezing the schema.

**Option A — one canonical undirected row**, `(least(a,b), greatest(a,b))`.
One row per friendship, so the invariant "a friendship is one fact" is free and
cannot drift.

**Option B — two mirrored directed rows**, `(a→b)` and `(b→a)`.

Option B was chosen. The deciding factor is that RLS policies and friend-list
queries are evaluated on *every* presence row, for every subscriber, on every
realtime event:

| | Canonical | Mirrored |
|---|---|---|
| "is X my friend?" in an RLS policy | `(user_a = me and user_b = X) or (user_b = me and user_a = X)` | `user_id = me and friend_id = X` |
| Index usage | needs both orderings, or a function index | plain PK prefix lookup |
| "list my friends" | `union` of two projections, or a `case` | `where user_id = me` |
| Rows per friendship | 1 | 2 |
| Risk | none | a half-written pair |

The mirrored form makes the hot path — the `is_friend()` predicate inside the
`presence` policy — a single-column primary-key lookup with no `OR`. Given that
this predicate runs per subscriber per realtime event, that simplicity is worth
more than the duplicate row.

The cost of Option B is the two-row invariant, and **application code is never
responsible for it**:

- Clients have no write access to `friendships` whatsoever.
- The only function that inserts is `create_friendship(a, b)`, which writes both
  rows in a **single statement**, so the pair is atomic by construction — there
  is no window in which one row exists without the other.
- `create_friendship` is internal: `EXECUTE` is revoked from `anon`,
  `authenticated` and `PUBLIC`. Only the other RPCs can reach it.
- `remove_friend()` deletes both directions in one statement.
- `friendships_not_self` and the composite primary key make self-friendship and
  duplicate rows impossible regardless of caller.

Tests assert the pair is exactly two rows after every path that creates a
friendship — direct acceptance, reciprocal auto-accept, and repeated requests.

## Testing

```bash
npm test           # authorization suite (47 assertions)
npm run test:authz # proves the suite fails when the safeguards are removed
```

The suite runs the real migration files against real PostgreSQL 18 via PGlite,
in-process — no Docker, no hosted round-trip, no credentials. Every test acts as
a genuine `authenticated` Postgres role with a JWT subject claim, which is
exactly how PostgREST executes a client request, so RLS and privileges are
enforced by Postgres itself rather than simulated.

The harness deliberately reproduces Supabase's permissive default privileges
before applying the migrations, so the revokes are exercised rather than
vacuously true.
