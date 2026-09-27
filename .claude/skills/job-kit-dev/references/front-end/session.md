# Session and auth

The web app models the signed-in user as one three-state union, **`Session = Checking | SignedOut | SignedIn`**,
owned by `App` and handed to routes as a prop. A cached `User` renders as `SignedIn` on the first frame. With
nothing cached, the app shows `Checking` until **`whoAmI`** answers. The **`sid` session cookie** is the only
authorization: the cache is optimistic UI state and grants nothing.

There are two ways to sign in. The email flow sends a 6-digit code (`requestCode`), then `verifyCode` sets the
session from its own reply. The Google flow is a full-page redirect: the server sets the cookie, and the next
boot's `reloadSession` picks it up. **`signOut`** clears the cache first and ends the server session in the
background.

Code: `packages/frontend/src/module/session/` (`session.ts`, `components/protected-route.tsx`, `helpers/return-to.ts`), root
wiring in `packages/frontend/src/app.tsx`, sign-in screen in `packages/frontend/src/pages/sign-in.tsx`. Server: `packages/backend/src/app/session.ts`
(cookie + session store), `packages/backend/src/domain/auth/`, `packages/backend/src/lib/google.ts`. Form mechanics on the sign-in
page: `./forms.md`.

## Audit

- Read `packages/frontend/src/module/session/session.ts`. Confirm that it owns the `"session"` `localStorage` key, the listener
  `Set` and the `generation` counter, and that every write goes through `setSession` / `commitSession`.
- Confirm `packages/frontend/src/app.tsx` holds the only `useState<Session>` and passes `session` to `/sign-in` and
  `ProtectedRoute`.
- The cached shape is `schema_actor` (`packages/backend/src/app/actor.ts`), the same schema `whoAmI.api.ts` replies with.
- Before adding one, search for a second identity source: a `useSession` hook, a React Context, or a
  `localStorage` read of `"session"` outside `session.ts`.
- Server calls go through `api` in `packages/frontend/src/api/endpoints.ts`. Today that is `whoAmI`, `requestCode`,
  `verifyCode` and `signOut`.

Report the audit briefly:

```md
Session Audit:

- Session model (Checking / SignedOut / SignedIn):
- Session API (reloadSession / requestCode / verifyCode / googleSignInHref / signOut):
- Persistence (localStorage "session", User only):
- Subscription (listener Set + storage event, generation guard):
- Route protection (ProtectedRoute on "/*", SignInPage redirect):
- Second identity sources found:
```

## Canonical references (by role)

- **`@module/session/session`**: `initialSession`, `subscribeToSessionUpdates`, `reloadSession`, `requestCode`,
  `verifyCode`, `googleSignInHref`, `signOut`; type `Session`.
- **`@module/session/components/protected-route`**: `ProtectedRoute` gates `/*`.
- **`@module/session/helpers/return-to`**: `returnState(location)` / `returnTo(state)` carry the page a
  visitor was sent away from through `/sign-in` and back.
- **`@be/app/actor`**: `schema_actor`, `Actor`, `UserActor`. The schema encodes and decodes the cache.
- **`@api/endpoints` / `@api/request`**: `api`, `call`, `FetchError`, `fetchErrorToString`.
- **`@lib/maybe`** / **`@lib/future`**: `Maybe` for the cache, `Future` + `Cancel` for every call.

## Imports

    import { initialSession, reloadSession, subscribeToSessionUpdates, type Session } from "@module/session/session"
    import { ProtectedRoute } from "@module/session/components/protected-route"
    import { returnState, returnTo } from "@module/session/helpers/return-to"
    import { fetchErrorToString, type FetchError } from "@api/request"

## 1. The session model

    type Session =
      | { type: "Checking" }
      | { type: "SignedOut"; error: Maybe<FetchError> }
      | { type: "SignedIn"; user: UserActor }

- **`Checking`**: nothing is cached and `whoAmI` is still in flight. Guards wait instead of redirecting, so a
  returning visitor with a live cookie and an empty cache is never sent to `/sign-in` by mistake.
- **`SignedOut.error`**: the `whoAmI` failure that led here, if any. `/sign-in` shows it.
- **`SignedIn`**: a cached or confirmed user. A cached user renders at once while `whoAmI` revalidates.

Match on `session.type` exhaustively, ending in `satisfies never`. There is no separate refresh-status cell.

Known gap: the union cannot say "signed in, but the last check failed", so `app.tsx` drops that error. If a
screen needs it, add a field to `SignedIn` (e.g. `check: RemoteData<FetchError, never>`) rather than a fourth
state.

## 2. The session API

- **`reloadSession()`** calls `api.whoAmI`. A `User` answer is cached and an `Anonymous` answer clears the cache.
  A rejection (network, 5xx, decode) leaves the cache alone. It resolves with the actor either way; `App` handles
  the failure (§4).
- **`requestCode(email)`** calls `api.requestCode`. There is no allowlist: the server emails a code to any
  well-formed address, and the reply is always `{}`. The server ignores a resend within 30 seconds
  (`RESEND_COOLDOWN_SECONDS`, exported from `requestCode.api.ts` and imported by the sign-in page through
  `@api/endpoints`, not hand-copied) and locks the address after 5 wrong codes.
- **`verifyCode(email, code)`** calls `api.verifyCode`, which replies `{ userId }`. The client builds
  `{ type: "User", userId }` and commits it; no follow-up `whoAmI`. Known gap: the reply carries only `userId`.
  If `UserActor` gains fields, change the server to reply `{ actor }` instead of growing the client-side
  construction.
- **`googleSignInHref(returnTo)`** returns `/api/v1/auth/google/start?returnTo=…`. Navigate to it with an
  `<a href>`, never `fetch` it: Google's consent screen needs the whole window. The server sanitizes `returnTo`,
  sets `sid` on the callback and redirects back. Failures land on `/sign-in?error=cancelled|failed|unavailable`.
- **`signOut()`** commits `Nothing()` first, so the UI goes anonymous at once, then calls `api.signOut` in the
  background. If that request fails, it runs `reloadSession`. A session that survived brings a "still signed in"
  toast; a failed `whoAmI` brings a "could not reach the server" toast. Both are skipped when the identity
  changed in the meantime (a sign-in in this tab, or any change from another tab).

## 3. Persistence, subscription, and the generation guard

- `localStorage["session"]` holds `JSON.stringify(s.encode(schema_actor, user))`. `userId` is an `Id`, so
  `JSON.stringify` alone would not round-trip it. Only a `User` is written, and `Nothing` removes the key. Reads
  decode with `s.stringified(schema_actor)`; a decode failure or a stale `Anonymous` entry counts as nothing
  cached. Storage exceptions are swallowed, because the cache is only a convenience.
- Updates in the same tab reach every listener in the module-level `Set` through `setSession`. Updates from other
  tabs arrive through the browser `storage` event (key `"session"`, or `null` for `localStorage.clear()`).
- `generation` counts identity changes newer than the server's last answer. `commitSession` (sign-in, sign-out)
  and every cross-tab event bump it. `reloadSession` reads it when the Future runs and writes the cache only if
  it has not changed, so a slow `whoAmI` cannot overwrite a newer sign-in or sign-out.
- Every path to signed-out calls `clearHandle()` from `@module/access/handle`. The next account in this browser
  therefore cannot open the previous account's profile folder.

## 4. Root lifecycle and protected routes

- `App` seeds `useState<Session>(initialSession)`, then one `useEffect` subscribes and forks `reloadSession()`.
  Success needs no handler, because the write reaches `App` through the subscription. On failure a `SignedIn`
  session is kept; anything else becomes `SignedOut { error: Just(error) }`. The cleanup cancels the request and
  unsubscribes.
- `<ProtectedRoute session={session}>` wraps `/*`. `Checking` shows "Checking your session…", `SignedOut`
  renders `<Navigate to="/sign-in" replace state={returnState(location)} />`, and `SignedIn` renders the
  children. It passes no user down, because nothing needs it yet.
- `/sign-in` takes `session` too, and a `SignedIn` session renders `<Navigate to={returnTo(location.state)} replace />`.
  A successful `verifyCode` therefore redirects without a success handler.
- `/legal/terms` and `/legal/privacy` are public.

## 5. Server contract

- The `sid` cookie holds a random token, sent as `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` in production.
  The database stores only the token's SHA-256, and every sign-in issues a new token.
- A session lasts 24 hours from sign-in; activity does not extend it.
- `whoAmI` is `Auth.public()` and answers `Anonymous` without a session. `signOut` is `Auth.authenticated()`,
  so it returns 401 without a session. Signing out deletes the row but sends no clearing `Set-Cookie`, so a slow
  sign-out reply cannot delete the cookie of a newer sign-in.
- `call` sends `credentials: "include"`; there is no `Authorization` header.

Known risk: the app asks the server about the session only at boot, and `call` treats a 401 as an ordinary
`BadStatus`. A tab left open past the 24-hour lifetime stays `SignedIn`. This is harmless while the app calls
only the four auth endpoints. Before wiring a guarded endpoint, revalidate on `visibilitychange` or run
`reloadSession()` when a call returns 401.

## Do / Do not

- Do: keep `App` the one owner of `Session` and hand it down as a prop.
- Do: route every write through `setSession`; sign-in and sign-out go through `commitSession`.
- Do: set the session from the `verifyCode` reply, with no follow-up `whoAmI`.
- Do: keep a cached `SignedIn` session when a reload fails.
- Do: navigate to `googleSignInHref`; never fetch it.
- Do not: store the cookie, token or code in `localStorage`. Store only the encoded `User`.
- Do not: add a React Context, a `useSession` hook or a second store for identity.
- Do not: treat the cached user as authorization; the server decides.
- Do not: merge `Checking` into `SignedOut`, or guards will send returning visitors to `/sign-in`.
