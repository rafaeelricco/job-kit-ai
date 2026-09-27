# Auth

Every command and query runs its request through one guard pipeline: `resolveAuth` builds the caller's `AuthContext`, an `Auth.*` builder from `policy.ts` decides allow or deny, and `handleCommand`/`handleQuery` mint the handler's `auth` argument from the allow branch. Sessions, login codes, and Google sign-in sit around that pipeline. Rationale and the capability walkthrough: `packages/backend/src/app/auth/README.md`; reviewer rules: `packages/backend/CLAUDE.md` Auth section.

### Guard the request in `resolveAuth`

`guardRequest` (`packages/backend/src/app/resolveAuth.ts`) is the one place every controller's `authGuard` runs. It resolves the session into an `AuthContext`, calls the guard, and turns a denial into the HTTP reply itself — a guard never touches `req`/`res`.

```ts
// packages/backend/src/app/resolveAuth.ts:68-79
function guardRequest<R extends AuthGuardResult>(
  req: Request,
  sessions: SessionStore,
  authGuard: AuthGuard<R>
): Future<Response, { actor: Actor; auth: Allowed<R> }> {
  return resolveAuth(req, sessions)
    .mapRej((): Response => internalServerError)
    .chain((context) => {
      const r = authGuard(context)
      return isAllowed(r) ? Future.resolve({ actor: context.actor, auth: r }) : Future.reject(denyResponse(r))
    })
}
```

`handleCommand` and `handleQuery` call `guardRequest` between decoding the body and running the handler; nothing calls a handler around that pipeline.

### Pick an `Auth` builder

`Auth` (`packages/backend/src/app/auth/policy.ts:100`) is the only export controllers use to build `authGuard`.

```md
| Builder                          | Allows                                 | Used by                             |
| -------------------------------- | -------------------------------------- | ----------------------------------- |
| `Auth.public()`                  | anyone, including `Anonymous`          | requestCode, verifyCode, whoAmI     |
| `Auth.authenticated()`           | any `User` actor                       | workspace commands/queries, signOut |
| `Auth.system(capability)`        | `system:<capability>` in `privileges`  | none yet                            |
| `Auth.session(capability, msg?)` | `session:<capability>` in `privileges` | none yet                            |
| `Auth.anyOf(...guards)`          | first allow wins, else last denial     | none yet                            |
```

Nothing uses `Auth.system`/`Auth.session`/`Auth.anyOf` yet, and nothing in `resolveAuth` grants a privilege yet either (see below) — the builders exist ahead of the first privileged endpoint.

### Type the handler and controller from the guard

`CommandHandler`/`QueryHandler` and `CommandController`/`QueryController` (`packages/backend/src/app/handlers.ts`) all take the guard's result as their last type parameter, defaulting to the general `AuthGuardResult`. Every controller in the codebase pins the narrower type instead, either inline:

```ts
// packages/backend/src/domain/auth/command/signOut.ts:10-19
const authGuard = Auth.authenticated()

const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({ session }) =>
  session
    .end()
    .mapRej((): Response => internalServerError)
    .map(() => ({}))

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
```

Elsewhere a short alias is named once and reused on both the handler and controller:

```ts
// packages/backend/src/domain/auth/command/verifyCode.ts:12-13
const authGuard = Auth.public()
type Result_ = GuardResult<typeof authGuard>
```

Either way, the handler can only read the `auth` proof its own guard could actually have minted.

### `AuthContext` is privileges, not roles

```ts
// packages/backend/src/app/resolveAuth.ts:18
type AuthContext = { actor: Actor; privileges: GrantKey[] }
```

`resolveAuth` sets `privileges: []` for every actor today, signed in or not — there is no role table yet. A guard reads only `privileges`, never a role, so a future role-to-privilege mapping can't be bypassed by a guard written before it existed.

### Capabilities and `getGrantData`

`SystemCapabilities`/`SessionCapabilities` (`packages/backend/src/app/auth/grants.ts:26-29`) are empty interfaces today, so the derived `GrantData`/`GrantKey` are empty too — no `system:`/`session:` grant exists yet. Once one does, a handler reads its verified metadata through `getGrantData`, never by re-deriving the fact the guard already proved:

```ts
// packages/backend/src/app/auth/grants.ts:92-95
function getGrantData<K extends GrantKey>(key: K, auth: Authorized<K>): GrantData[K] {
  if (auth.grant.key !== key) throw new Error(`Proof does not carry grant: ${key}`)
  return auth.grant.value
}
```

`grant` — the only way to mint a proof — is exported from `grants.ts` for `policy.ts` to call. Import it nowhere else (`packages/backend/CLAUDE.md`).

### Add a capability

1. Add `<Name>: true` to `SystemCapabilities` or `SessionCapabilities` in `packages/backend/src/app/auth/grants.ts`.
2. Grant it from a role table when resolving the auth context. `resolveAuth.ts` has no such table yet — adding the first capability means adding that mapping and replacing the hardcoded `privileges: []`.
3. Build the guard with `Auth.system("<Name>")` / `Auth.session("<Name>")` and assign it to `authGuard`.

Full walkthrough: `packages/backend/src/app/auth/README.md`.

### Sessions: cookie, table, TTL

```ts
// packages/backend/src/app/session.ts:12,18,21
const COOKIE = "sid"
const TABLE = "auth_sessions"
const TTL_SECONDS = 24 * 60 * 60
```

The cookie carries a random 32-byte token (base64url); only its SHA-256 digest is stored in `auth_sessions`, so a leaked table can't be replayed as cookies. `auth_sessions` lives in the event-store Postgres database but outside the replication publication, so sessions never reach the event bus.

A `Session`, built per request from the request's own token, is the handler's handle on sign-in and sign-out:

```ts
// packages/backend/src/app/session.ts — Session
start(userId: Id<"User">): Future<Error, void>   // issues a fresh token, queues Set-Cookie
end(): Future<Error, void>                        // destroys the request's own session, if any
```

`start` never reuses the request's incoming token, so a cookie planted before sign-in can't become a signed-in session. `handleCommand` builds the `Session` and writes `session.headers` (a `Set-Cookie`, once `start` ran) onto the reply.

### Login codes: 6 digits, 10 minutes, HMAC

`packages/backend/src/app/loginCodes.ts` issues and consumes one-time email codes, stored in `auth_login_codes` (also outside the replication publication).

```ts
// packages/backend/src/app/loginCodes.ts:9,13,15
import { RESEND_COOLDOWN_SECONDS } from "@be/domain/auth/command/requestCode.api"
const CODE_TTL_SECONDS = 10 * 60
const MAX_ATTEMPTS = 5
```

- A code is six digits (`randomInt(0, 1_000_000)`, zero-padded).
- `codeDigest` is `HMAC-SHA256(LOGIN_CODE_SECRET, "<email>\n<code>")`, so a leaked table can't be brute-forced back into live codes the way a plain SHA-256 of six digits could.
- `loginCodeSecretFromEnv()` falls back to a fixed development key when `LOGIN_CODE_SECRET` is empty, and throws if `NODE_ENV === "production"` with no secret set.
- `RESEND_COOLDOWN_SECONDS` (30) is exported from `requestCode.api.ts`, not redefined here: `loginCodes.ts` imports it for the cooldown check, and the frontend imports the same value through `@api/endpoints`, so neither side hand-copies the number.
- `send` no-ops inside the 30s resend cooldown or once `MAX_ATTEMPTS` (5) wrong guesses have been spent on the live code; `consume` deletes the row on success and compares digests with `timingSafeEqual`.

`requestCode`/`verifyCode` (both `Auth.public()`) are the only callers — `packages/backend/src/domain/auth/command/{requestCode,verifyCode}.ts`.

### Google OIDC: two GET routes outside `defineAPI`

Google sign-in is two browser navigations, not a JSON command, so it is mounted as plain `app.get` routes (`mountGoogleSignIn`, `packages/backend/src/index.ts:93-119`) instead of going through `defineAPI`/`mountApi`.

```ts
// packages/backend/src/lib/google.ts:25-31
const GOOGLE_START_PATH = "/api/v1/auth/google/start"
const GOOGLE_CALLBACK_PATH = "/api/v1/auth/google/callback"
const GOOGLE_COOKIE = "g_oauth"
```

- `startGoogleSignIn` generates `state`/`nonce`/a PKCE `verifier`, stores them plus the sanitized `returnTo` in the `g_oauth` cookie (10 minutes), and redirects to Google's consent screen with the PKCE `S256` challenge.
- `finishGoogleSignIn` checks `state`, exchanges the code with the saved `verifier`, and requires `claims.nonce` to match and `claims.email_verified === true` before signing anyone in — an unverified Google email is refused outright.
- `safeReturnTo` only allows an internal path (`/x`); `//evil.com` and `/\evil.com` fall back to `/`, and `appUrl` re-checks the resolved URL's origin so a tab- or newline-smuggled path can't resolve off-site.
- Errors land the browser back on `/sign-in?error=<cancelled|failed|unavailable>` — `finishGoogleSignIn` never rejects.

`GoogleOidc` (`packages/backend/src/lib/google-oidc.ts`) wraps `google-auth-library`: `configured` is `false` when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are empty, and `exchange` returns an ID token's claims only after the library has checked its signature, issuer, audience, and expiry.

### One user, however they signed in: `provisionUser`

A verified email — from a consumed login code or Google's `email_verified` claim — reaches `provisionUser` (`packages/backend/src/domain/auth/provisionUser.ts`), which creates the `User` and `Workspace` on first sign-in and finds them on every one after:

```ts
// packages/backend/src/domain/auth/provisionUser.ts:24,30
const userId = User.idForEmail(email)
const workspaceId = Workspace.idForOwner(userId)
```

Both ids are deterministic, so a login-code sign-in and a Google sign-in for the same address reach the same user. Two racing first sign-ins collide on aggregate version 0; the event store retries the loser, which then finds both aggregates already created.

### Auth status rules

```md
- 401 Unauthorized: caller is anonymous, or the session cookie doesn't resolve (`unauthenticated()` in `policy.ts`).
- 403 Forbidden: caller is signed in but lacks the required capability (`Auth.system`/`Auth.session` deny).
- 401 (`invalid_code`) on `verifyCode`: a wrong, expired, used, or locked-out code — deliberately one message for all four (`authErrors.ts`).
```

### Auth review checklist

- [ ] `authGuard` is built from an `Auth.*` builder in `packages/backend/src/app/auth/policy.ts`; `Auth.public()` on an endpoint that reads or writes user data has a reason in the PR description.
- [ ] A handler that reads `auth` gets `GuardResult<typeof authGuard>` on both handler and controller, inline or as a named alias.
- [ ] `grant` is imported only inside `packages/backend/src/app/auth/`; handlers read grant metadata through `getGrantData`.
- [ ] The guard itself is a pure, synchronous function of `AuthContext` — no `Future`, `Promise`, or other IO.
- [ ] The endpoint runs through `handleCommand`/`handleQuery`; nothing calls a handler around that pipeline.
- [ ] A new capability is added to `grants.ts` and granted from a role mapping before any guard checks it.
