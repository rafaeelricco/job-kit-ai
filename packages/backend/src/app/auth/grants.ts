/**
 * @file Branded authorization proofs — the evidence layer of the auth system
 * (see ./README.md). Builders in ./policy.ts mint these proofs; handlers read
 * them via {@link getGrantData}.
 */

export {
  type SystemCapabilities,
  type SessionCapabilities,
  type GrantData,
  type GrantKey,
  type Public,
  type Authenticated,
  type Authorized,
  type GrantProof,
  getGrantData,
  grant,
}

import { type UserActor } from "@be/app/actor"

/**
 * Role-granted capabilities, by name (`Name: true`). Empty until the first
 * privileged endpoint adds its capability together with a role → privilege table.
 */
interface SystemCapabilities {}

/** Capabilities derived from session state (e.g. an active impersonation), by name. Empty for now. */
interface SessionCapabilities {}

/**
 * The capability catalog: every grant the system can prove, keyed by
 * `"<scope>:<Capability>"`. The value is the verified metadata a handler reads via
 * {@link getGrantData}; `system:` and `session:` grants carry none.
 */
type GrantData = { [P in keyof SystemCapabilities & string as `system:${P}`]: Public } & {
  [P in keyof SessionCapabilities & string as `session:${P}`]: Public
}

type GrantKey = keyof GrantData
type Public = Record<never, never>
type Authenticated = { actor: UserActor }

/**
 * An unforgeable, minted proof that one capability check passed, carrying that
 * grant's verified metadata. The private constructor means a proof can only be
 * produced by {@link GrantProof.mint} inside this module — application code
 * cannot fabricate one.
 */
class GrantProof<P extends GrantKey> {
  private readonly _key: P
  private readonly _value: GrantData[P]

  private constructor(key: P, value: GrantData[P]) {
    this._key = key
    this._value = value
  }

  get key(): P {
    return this._key
  }

  get value(): GrantData[P] {
    return this._value
  }

  /** Mint a proof pairing `actor` with grant `key` and its verified metadata. */
  static mint<K extends GrantKey>(actor: UserActor, key: K, value: GrantData[K]): Authorized<K> {
    return { actor, grant: new GrantProof(key, value) }
  }
}

/**
 * The proof a handler receives: an authenticated actor plus a {@link GrantProof}
 * for grant `P`. A proof carries exactly one grant: `Authorized<A | B>` is "A or B",
 * and `getGrantData` throws if asked for the one it does not carry.
 */
type Authorized<P extends GrantKey> = Authenticated & { readonly grant: GrantProof<P> }

/**
 * Mint a proof for a `system:`/`session:` grant. Both catalogs map every name to
 * `Public`, so the value is always `{}`; the cast restates that for a generic `K`.
 */
function grant<K extends GrantKey>(actor: UserActor, key: K): Authorized<K> {
  return GrantProof.mint(actor, key, {} as GrantData[K])
}

/**
 * Read the verified metadata a proof carries for grant `K`. The `Authorized<K>`
 * parameter makes it a compile error to ask for a grant the proof lacks.
 */
function getGrantData<K extends GrantKey>(key: K, auth: Authorized<K>): GrantData[K] {
  if (auth.grant.key !== key) throw new Error(`Proof does not carry grant: ${key}`)
  return auth.grant.value
}
