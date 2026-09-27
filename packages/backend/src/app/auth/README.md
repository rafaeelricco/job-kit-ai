# Authorization: Proofs and Policies

## How to Think About Authorization

Every endpoint follows a five-step checklist:

1. **Decide the access level**: public, authenticated, or privileged.
2. **Name the capability** (if privileged): e.g., "AdminPanel".
3. **Scope it in the grant key**: system-wide (`system:AdminPanel`) or session-derived (`session:ImpersonatingUser`).
4. **Compose proofs**: "A or B" is `Auth.anyOf(...)` (or a named policy when the choice has business meaning). A proof carries one grant, so there is no "A and B" yet; `Authorized<A | B>` means either.
5. **Choose the guard**: Pick `Auth.public()`, `Auth.authenticated()`, `Auth.system(...)`, `Auth.session(...)`, or combine with `Auth.anyOf(...)`.

## API Reference

### Guard Builders

- `Auth.public()` — Allow anyone, including anonymous. The handler inspects `actor` itself (e.g., `whoAmI`).
- `Auth.authenticated()` — Require a signed-in user; 401 if anonymous. No privilege needed.
- `Auth.system(capability)` — Require a system-wide privilege; 403 if not granted. Mints a `system:` proof.
- `Auth.session(capability, message?)` — Require a session-derived capability; 403 with an optional custom message. Mints a `session:` proof.
- `Auth.anyOf(...guards)` — "A or B": try each guard in order; the first allow wins, else the last denial.

## Adding Your First Capability

1. Add the name and `true` to `SystemCapabilities` in `grants.ts`:
   ```ts
   interface SystemCapabilities {
     ManageUsers: true
   }
   ```
2. Grant it from a role table in `resolveAuth.ts` when resolving the auth context.
3. Use `Auth.system("ManageUsers")` in your endpoint's `authGuard` field.

## Design Principle

**Proofs are minted only by the builders in `policy.ts` and read only through `getGrantData`.** `GrantProof`'s private constructor stops application code from constructing one directly, but `grant` is exported for `policy.ts`, so keeping minting inside the auth module is a convention: import `grant` nowhere else. Held to that, a handler typed as `Authorized<"system:ManageUsers">` only runs after `Auth.system("ManageUsers")` allowed the request.
