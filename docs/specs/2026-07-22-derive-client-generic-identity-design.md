# derive-client: generic identity derivation (whoami for any client)

**Date:** 2026-07-22
**Status:** Design, pending user review
**Ships in:** rkt plugin v0.9.0 (new user-visible capability)
**Builds on:** v0.8.1 (help command + identity guidance)

## Problem

`whoami` and the `@me` token depend on an `identity` block naming an endpoint
that returns the signed-in user. Today that only works when the user's own id
is a **literal path segment**, and it silently fails when the id is a **query
param**. Two real recorded clients prove the gap:

| Client | Identity endpoint | Where the operator's id lives | Works today |
|---|---|---|---|
| kirinari-alayacare | `get.api.v1.employees.924` | literal path segment (`/employees/924`) → id-free | yes |
| luma | `get.user.profile` | required query param (`?username=usr-…`) | no |

The current auto-detector only matches endpoint ids ending in `.me`, so it
found neither. Worse, the mechanism is not merely missing but silently
*wrong*: `assertResolvable` only rejects *path* params, so a query-param
identity endpoint is never blocked; and `buildRequest` (transport.ts:98) fills
a required query param from its **recorded example**
(`params[p.name] ?? (p.required ? p.example : undefined)`), where that example
is just whatever profile the recording happened to visit (`synthesize.ts`
marks a single-sample query param `required`, so its example is always used).
So identity silently reflects the recorded id with no way to override it with
the operator's own, verified id. During a real luma run the recording had
landed on a stranger's public profile, so the example, and therefore `whoami`,
was that stranger. This is a URL-shape-plus-poisoned-example problem, not a
luma quirk: there is no explicit place to pin the operator's own id and no
check that the captured id is actually theirs. The fix must be generic.

## Goal

Derive a working `identity` for any client whose API exposes the current user
as an endpoint keyed by the operator's own id, regardless of whether that id is
a path literal, a path param, or a query param, and make the skill capture and
verify it deterministically instead of guessing.

## Non-goals

- Sites with no current-user API at all (identity server-rendered, never a
  client call). These stay unsupported; the skill says so (v0.8.1 behavior).
- JWT-`sub` auto-seeding. Designed below as a future enhancement but NOT built
  now: it benefits neither recorded client (luma's cookie is opaque; AlayaCare's
  user endpoint keys by employee-id, not the token `sub`). See "Future work."

## Design

Four parts. The first three are the mechanism; the fourth is the skill.

### 1. `IdentitySpec` gains `params`

`plugins/rkt/skills/derive-client/scripts/src/lib/commands-schema.ts`

```ts
export interface IdentitySpec {
  endpoint: string;
  params?: Record<string, string>; // NEW: fixed args for the identity call
  idField: string;
  display: string[];
}
```

- `validateCommandsFile`: when `identity` is present, validate `identity.params`
  (if present) as an object of string→string, AND carry it through the identity
  reconstruction. The current code rebuilds identity as a whitelist
  (`identity = { endpoint, idField, display }`, commands-schema.ts:121) and does
  NOT spread the input, so `params` is dropped unless the reconstruction adds
  `params: i.params`. This is load-bearing: miss it and codegen emits identity
  with no params and `whoami` silently regresses. Do not reuse the command-scoped
  `validateParams` verbatim for this: its error labels are hardcoded to
  `.call.params` (commands-schema.ts:60,63) and would print
  `identity.call.params.x`; validate identity params under an `identity.params`
  label instead. Absent `params` stays valid (back-compat).
- `assertResolvable`: replace the "identity endpoint must have no path param"
  check with: **every required param of the identity endpoint (path or query)
  must be a key in `identity.params`.** Rationale: the recorded `example` is
  untrustworthy (it is whatever profile the recording visited, possibly a
  stranger's), so identity must not silently depend on it — the operator's own id
  must be pinned explicitly. A path-literal endpoint (AlayaCare's
  `get.api.v1.employees.924`, where `924` is a baked literal segment with no
  params) still passes unchanged; note this back-compat holds only because the id
  is a literal, if it were a path *param* the CURRENT rule
  (commands-schema.ts:143) already rejects it, so no client regresses. Luma's
  required `username` must now appear in `params`. Error message names the missing
  param(s).

  ```ts
  if (commands.identity) {
    const idEp = need("identity", commands.identity.endpoint);
    const supplied = new Set(Object.keys(commands.identity.params ?? {}));
    const missing = idEp.params.filter((p) => p.required && !supplied.has(p.name));
    if (missing.length) {
      throw new Error(
        `commands.json: identity endpoint '${commands.identity.endpoint}' needs ` +
          `param(s) ${missing.map((p) => p.name).join(", ")} in identity.params ` +
          `(set them to your own id, e.g. from your profile URL)`,
      );
    }
  }
  ```

The generated `cli.ts` embeds `IDENTITY` as `JSON.stringify(commands.identity)`
(codegen.ts:338/360), so `params` flows into the generated client with no codegen
change, but ONLY once `validateCommandsFile` carries `params` through (above):
the object codegen serializes is the validator's reconstruction, not the raw file.

### 2. The identity call passes `params`

`runtime.ts`, `identity.ts`, `command-runner.ts`.

- `Caller.fetchJson` gains an optional params arg, forwarded to the existing
  `buildRequest` path that already handles path + query params for commands:
  ```ts
  fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown>;
  ```
  Implementation calls `call(endpointId, params ?? {})` and JSON-parses the body
  (reuse existing renewal/tier logic; no new transport code).
- `identity.ts` `FetchEndpoint` gains the params arg:
  ```ts
  export type FetchEndpoint = (endpointId: string, params?: Record<string, string>) => Promise<unknown>;
  ```
  `resolveIdentity` calls `fetchEndpoint(spec.endpoint, spec.params ?? {})`.
- `command-runner.ts`: this file declares its OWN caller interface
  `RunnerCaller` (command-runner.ts:11) whose `fetchJson(endpointId: string)`
  must be widened to `fetchJson(endpointId: string, params?: Record<string,string>)`
  too, or the closures below fail `tsc` (TS2554, expected 1 got 2). Both call
  sites (`runWhoami` at :56 and the `@me` memo at :46) then pass params:
  `resolveIdentity(site, identity, (id, p) => caller.fetchJson(id, p))`.
  `spec.params` is applied inside `resolveIdentity`, so the closure just forwards
  whatever it is handed.

`@me` still resolves to `getPath(identityResponse, idField)` — unchanged.

### 3. Shape-based identity detection in the scaffolder

`scaffold-commands.ts`. Replace the `/\.me$/`-only finder with a generic ranker
over the manifest's response shapes.

For each endpoint, locate a **user object** = the response root if it directly
carries identity fields, else a top-level object-typed property named one of
`user | profile | account | me | viewer | employee | member`. A candidate must
have, within that user object: at least one name-ish field
(`name | full_name | display_name | first_name`) OR `email`, AND an id-ish
field (`api_id | id | uuid | user_id | username`).

Score a candidate (the path regexes run against the endpoint's `pathTemplate`,
NOT the dotted `id`):
- `+3` `pathTemplate` matches `/(^|/)(me|self|current|viewer|whoami)(/|$)/`
- `+1` `pathTemplate` matches `/(^|/)(user|profile|account|employee|member)(/|$)/`
- `+2` no required params (a true id-free `/me`)
- `+1` user object is the response root (not nested)

Pick the highest score; tie-break by fewest required params, then manifest
order (deterministic — same manifest always yields the same pick). If no
candidate qualifies, emit no `identity` (skill then tells the operator).

Seed the block from the winner (field-name matches are case-insensitive,
first-present-wins in the listed order, so two runs pick identically):
- `endpoint` = winner id
- `idField` = `<userPath>` + first present of
  `api_id | id | uuid | user_id | username` (includes `username`, so the id-ish
  detection set and the seeding set agree — a candidate whose only id-ish field
  is `username` still yields a usable `idField`)
- `display` = `<userPath>` + first present of
  `name | full_name | display_name | first_name`, plus `<userPath>email` when
  present
- `params` = for each **required** param, the recorded `example` value when the
  manifest has one. Seeding the example is deliberate: it surfaces the captured
  id in `commands.json` where the operator can verify or replace it, instead of
  `buildRequest` using it silently — strictly more transparent than today, never
  a regression. When a required param has NO example (rare, since `synthesize`
  only marks a param required when every sample carried it), seed `""` as a
  visible "fill this in" placeholder; the call then fails loudly (empty value)
  until the operator sets it, caught by the mandatory verify (part 4). Failing
  loud is intentional: never ship an identity that guesses.

`<userPath>` is `""` when the user object is the response root, else e.g.
`"user."`.

**Scope limit (documented):** `getPath` (render.ts) walks dotted object paths
only, with no array-bracket syntax, and the ranker inspects object roots and
object properties, so a `/me` that returns a bare array (`[{…}]`) is not
detected and that client keeps no identity. Acceptable for now, noted so it is
not a surprise.

### 4. Skill: deterministic capture + mandatory verify

`SKILL.md`.

- **Recording (Step 5):** replace vague "visit the account/profile page" with:
  "Open **your own** profile or account through the app's own UI (the avatar or
  account menu), never by typing a guessed `/settings`-style URL. If the app
  routes profiles by id (URL like `/user/<id>`, `/u/<id>`, `/employees/<id>`),
  that `<id>` in the URL is **your** id — the current-user endpoint fires on that
  page and its param example captures your id." Warn that landing on a stranger's
  profile (via a wrong URL) poisons the captured id.
- **Shaping (Step 10):** the identity bullet documents `params` and instructs:
  take the scaffolder's detected identity, and if it needs a param, confirm the
  seeded value is **your** id (matches your profile URL), not a placeholder or a
  stranger's.
- **Verify (a mandatory new sub-step of the existing Step 11, "Regenerate and
  read the drift report"):** after regenerating, run `whoami` and confirm it
  prints the operator's real name/email. If it prints a stranger, a blank, or
  errors, the identity is wrong: fix `identity.params` (or re-record the correct
  profile) and repeat. Do not declare identity done without this check. This is
  the guard that would have caught the David-Tesler regression immediately.

## Data flow (whoami, Luma)

1. `luma whoami` → `runWhoami(SITE, IDENTITY, caller)`.
2. `resolveIdentity` cache-miss → `fetchEndpoint("get.user.profile", {username: "usr-<you>"})`.
3. `caller.fetchJson` → `call("get.user.profile", {username: "usr-<you>"})` →
   `buildRequest` appends `?username=usr-<you>` → live GET.
4. `getPath(body, "user.api_id")` → id; `display` = `["user.name"]` (luma's
   profile user object carries no `email`, so name only).
5. `whoamiLine` prints `Ada Lovelace`. Cached at 0600.

## Error handling

- Identity endpoint missing a required param not in `params` → `assertResolvable`
  throws at generate time with the param name (fail fast, before a bad client
  ships).
- Identity call returns no `idField` → existing `resolveIdentity` throw
  ("identity endpoint returned no idField '…'") — now more likely to fire
  helpfully if `params` are wrong.
- No qualifying user endpoint → no identity block; `whoami` prints the existing
  "this client has no identity endpoint" message.
- A seeded blank param (`""`) reaches runtime → the call goes out with an empty
  value and the verify step catches the wrong/empty result.

## Testing

- **commands-schema:** `params` validates as a string map; `assertResolvable`
  accepts an identity endpoint whose required query param is in `params`, and
  rejects one whose required param is missing (path AND query cases). Back-compat:
  a param-free identity (AlayaCare shape) still passes.
- **runtime/identity:** `fetchJson(id, params)` forwards params into the request
  (assert the built URL carries the query param, via a fake transport);
  `resolveIdentity` passes `spec.params` to the fetch closure.
- **scaffold:** shape ranker picks a nested `user`-object endpoint over an
  unrelated id-free endpoint; seeds `idField`/`display`/`params` (from example);
  picks a true `/me` over a param-keyed candidate; emits no identity when nothing
  qualifies; deterministic across runs.
- **integration/smoke (in the plan, manual):** regenerate the real luma client
  with a hand-set `identity.params.username = <the operator's own id>` and run
  `whoami`; confirm it prints the operator, not a stranger. (The auto-seed needs
  a re-record that visits the operator's own profile; the smoke can use a
  hand-set id to prove the mechanism end to end.)
- Full gate: `bun test`, `bunx tsc --noEmit` (scripts + generated closure probe),
  `claude plugin validate plugins/rkt`.

## Future work (designed, NOT built)

**JWT-`sub` auto-seeding.** When the auth credential is a JWT, decode its payload
(base64, no verification) at derive time and, when a claim value (`sub`,
`preferred_username`, `email`, `uid`) equals a candidate identity endpoint's
recorded param example, seed `params` from it with high confidence and no
operator navigation. Trigger to build: a real client whose user endpoint keys by
a token claim. Not built now because it benefits no current client (luma's
cookie is opaque; AlayaCare keys by employee-id ≠ token `sub`), and it adds
token-decoding, a manifest identity hint, and PII-handling for a hypothetical
gain.

## Requirement → component map

| Requirement | Component |
|---|---|
| Identity works for path-literal id (AlayaCare) | unchanged; still passes new `assertResolvable` |
| Identity works for query-param id (Luma) | `IdentitySpec.params` + resolver forwarding (parts 1-2) |
| Identity works for a true `/me` | scaffold ranker prefers id-free (part 3) |
| Required identity params validated | `assertResolvable` change (part 1) |
| Generic auto-detection, not `.me`-only | shape ranker (part 3) |
| Deterministic capture, no URL guessing | SKILL Step 5 (part 4) |
| whoami correctness guaranteed | mandatory verify, SKILL Step 11 (part 4) |
| No speculative code | JWT-`sub` demoted to Future work |
| Ships as 0.9.0 | release-time per AGENTS.md |
