# Client usage: consuming backend endpoints from the web app

The web app calls the server through `packages/frontend/src/api/endpoints.ts` (a hand-picked catalog of `.api.ts` endpoint objects) and `packages/frontend/src/api/request.ts` (`call`, a thin `fetch` wrapper). `endpoints.ts` compiles against server source directly through the `@be/*` alias: no codegen step, no separate client SDK. `request.ts` imports nothing from `@be`; its `Endpoint` type is structural, and the server's `PlainEndpoint` satisfies it.

### Reach server source through the `@be/*` alias

`packages/frontend/tsconfig.json` maps `@be/*` to the server's `src/`, so an `.api.ts` file's `endpoint`, `Command`, and `CommandResponse` exports are ordinary TypeScript imports from the app:

```jsonc
// packages/frontend/tsconfig.json:26-36
"paths": {
  "@/*": ["./src/*"],
  "@api/*": ["./src/api/*"],
  "@be/*": ["../backend/src/*"],
  // ...
}
```

### Call through the app's own endpoint catalog, not `@be/api`

`packages/frontend/src/api/endpoints.ts` re-exports one flat `api` object, one import per `.api.ts` file the app actually calls:

```ts
// packages/frontend/src/api/endpoints.ts
import { endpoint as whoAmI } from "@be/domain/auth/query/whoAmI.api"
import { endpoint as requestCode } from "@be/domain/auth/command/requestCode.api"
import { endpoint as verifyCode } from "@be/domain/auth/command/verifyCode.api"
import { endpoint as signOut } from "@be/domain/auth/command/signOut.api"

const api = { whoAmI, requestCode, verifyCode, signOut } as const
```

`packages/backend/src/api.ts` (the server's own `command`/`query` registry) is not imported from the app: it pulls in server-only modules (`pg`, `mongodb`) that don't belong in a browser bundle. `packages/frontend/CLAUDE.md` makes this a reviewable rule: "Server endpoints are reached through `api` from `@api/endpoints` and `call` from `@api/request`, never imported from `@be/domain/*` directly" — call sites import from the catalog, and only `endpoints.ts` itself imports a `.api.ts` file directly.

### Send a request with `call`

`call` builds a `Future`, not a `Promise` — it runs nothing until forked, and forking it twice sends the request twice.

```ts
// packages/frontend/src/module/session/session.ts:192-198
function verifyCode(email: string, code: string): Future<FetchError, UserActor> {
  return call(api.verifyCode, { email, code }).map(({ userId }) => {
    const user: UserActor = { type: "User", userId }
    commitSession(Just(user))
    return user
  })
}
```

```ts
// packages/frontend/src/pages/sign-in.tsx:197-205
const verify = (code: string): void => {
  if (submit.isLoading) return
  run(() =>
    verifyCode(email, code).fork(
      (error) => setSubmit(Failed(error)),
      () => {}
    )
  )
}
```

Fork it with `.fork(onError, onSuccess)`; don't `await` it, and don't wrap it in `Future.attemptP` or a `Promise`.

### Handle `FetchError`

`call`'s rejection type (`packages/frontend/src/api/request.ts:1, 7-42`) is a closed union: `NetworkError` (fetch itself failed; a cancel through `fork`'s abort is swallowed, not reported), `BadStatus` (a non-2xx reply; `message` is the server's `{ error: { message } }` body when present, else the status text), and `UnableToDecode` (the response body didn't match the endpoint's response schema). `fetchErrorToString` (`request.ts:100-111`) turns any of the three into one display string:

```ts
// packages/frontend/src/pages/sign-in.tsx:148-151
{submit instanceof Failed ?
  <Alert variant="destructive">
    <AlertDescription>{fetchErrorToString(submit.error)}</AlertDescription>
  </Alert>
: null}
```

### Cookies and the dev proxy

`call` sends `credentials: "include"` on every request (`request.ts:69`), so the `sid` session cookie rides along automatically — no header to set by hand. The cookie is `HttpOnly; SameSite=Lax` (`setCookie` in `packages/backend/src/app/session.ts:130`), which only survives a same-site request, so in dev the app proxies `/api` to the server instead of calling it cross-origin:

```ts
// packages/frontend/vite.config.ts:31-33
server: {
  // The API sets a SameSite=Lax cookie and sends no CORS headers, so it must look same-origin.
  proxy: { "/api": "http://localhost:3010" },
},
```

### Model UI state with `RemoteData`, and cancel on unmount

A call site keeps a `RemoteData<FetchError, T>` for the pending request and stores `fork`'s cancel function so an unmount (or a new submit) can cancel the in-flight one:

```ts
// packages/frontend/src/pages/sign-in.tsx:106-108, 129-136
const [submit, setSubmit] = useState<RemoteData<FetchError, never>>(NotAsked())
const cancel = useRef<Cancel>(() => {})
useEffect(() => () => cancel.current(), [])

const sendCode = (email: string): void => {
  if (submit.isLoading) return
  setSubmit(Loading())
  cancel.current = requestCode(email).fork(
    (error) => setSubmit(Failed(error)),
    () => onSent(email)
  )
}
```

### Derive request/response types from the catalog

The endpoint's schemas are runtime values on `api`, so a call site derives types with `s.Infer` instead of hand-writing an interface or importing from `@be/domain/*` (which `packages/frontend/CLAUDE.md` rules out):

```ts
import * as s from "@lib/json/schema"
import { api } from "@api/endpoints"

type VerifyCodeRequest = s.Infer<typeof api.verifyCode.request>
type VerifyCodeResponse = s.Infer<typeof api.verifyCode.response>
```

`packages/frontend/src/module/session/session.ts` still hand-writes its return types (`Future<FetchError, UserActor>`); prefer the derived form for new code.

### Add or change an endpoint

Change the contract on the server first so the client compiles against the final schema, not the other way around:

1. Add or edit the `.api.ts` file's `PlainEndpoint` (`request`/`response` schemas, `path`) under `packages/backend/src/domain/<area>/{command,query}/`. `PlainEndpoint` is always a POST (`packages/backend/src/app/endpoint.ts:14`).
2. Add the new `endpoint` export to `packages/frontend/src/api/endpoints.ts`'s `api` object — one import, one key.
3. Run `pnpm typecheck` in `packages/backend/` and in `packages/frontend/`. A request/response shape mismatch, or a call site still passing the old payload shape, fails the app's typecheck immediately because it compiles the server's schemas in directly.

### Client-usage checklist

```md
- [ ] Endpoint imported from `@api/endpoints`, not `@be/api` or a `.api.ts` file directly at the call site.
- [ ] Request payload matches the endpoint's `request` schema; no `as` cast.
- [ ] `call(...)` is forked (`.fork(onError, onSuccess)`), never awaited.
- [ ] The fork's cancel function is stored and called on unmount (or before a new submit).
- [ ] `FetchError` is handled at the call site, via `RemoteData` or an equivalent explicit state.
- [ ] Types are derived with `s.Infer<typeof api.<name>.request | response>`, not a duplicated interface.
- [ ] A changed `.api.ts` schema was typechecked in both `packages/backend/` and `packages/frontend/` before the client code that depends on it.
```
