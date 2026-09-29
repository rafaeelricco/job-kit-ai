import { Future } from "@lib/future"
import { type Maybe, Just, Nothing, fromNullable } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { type Aggregate, Id, type IdOf } from "@be/lib/event-sourcing/event"
import {
  type DatabaseEntry,
  type EventStoreDatabase,
  type WithEventStore,
  createEventStore,
  evaluate,
} from "@be/lib/event-sourcing/store"
import { schemas } from "@be/app/events"
import { type SessionStore } from "@be/app/session"
import { type LoginCodes } from "@be/app/loginCodes"
import { type SecretVault } from "@be/app/ai/store/vault"
import { type Attempt, type AttemptState, type Settlement, type Attempts } from "@be/app/ai/store/attempts"
import { type AiConnections } from "@be/app/ai/connections"
import { type Secret } from "@be/domain/ai/adapter"
import { type VaultKeys, type Sealed, vaultKeys, seal, open } from "@be/app/ai/store/crypto"
import { routeViews } from "@be/domain/ai/routes"
import { FakeProvider, testAdapter } from "@tests/support/test-provider/adapter"
import { type ProviderAdapter } from "@be/domain/ai/adapter"

/** Exercises the real encoder/hydrator; only persistence is replaced. */
export class MemoryEventDatabase implements EventStoreDatabase {
  readonly entries: DatabaseEntry[] = []

  async exists(id: Id<"Event">): Promise<boolean> {
    return this.entries.some((entry) => entry.event_id.value === id.value)
  }

  async findAll<T extends Aggregate<string>>(id: IdOf<T>): Promise<DatabaseEntry[]> {
    return this.entries
      .filter((entry) => entry.aggregate_id.value === id.value)
      .sort((a, b) => a.aggregate_version - b.aggregate_version)
  }

  async insert(entry: DatabaseEntry): Promise<void> {
    if (
      this.entries.some(
        (saved) =>
          saved.event_id.value === entry.event_id.value ||
          (saved.aggregate_id.value === entry.aggregate_id.value && saved.aggregate_version === entry.aggregate_version)
      )
    ) {
      throw new Error("Duplicate event or aggregate version")
    }
    this.entries.push({
      ...entry,
      payload: JSON.parse(JSON.stringify(entry.payload)),
    })
  }

  readonly withEventStore: WithEventStore = (onError, procedure) =>
    Future.attemptP(() => evaluate(createEventStore(this, schemas), procedure)).mapRej(onError)
}

/** Keeps raw tokens in a map; the Postgres store's hashing is covered by the integration suite. */
export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, Id<"User">>()
  private issued = 0

  readonly create = (userId: Id<"User">): Future<Error, string> =>
    Future.create((_, resolve) => {
      const token = `token-${++this.issued}`
      this.sessions.set(token, userId)
      resolve(token)
    })
  readonly find = (token: string): Future<Error, Maybe<Id<"User">>> =>
    Future.resolve(fromNullable(this.sessions.get(token) ?? null))
  readonly destroy = (token: string): Future<Error, void> =>
    Future.create((_, resolve) => {
      this.sessions.delete(token)
      resolve(undefined)
    })
}

/** An in-memory `LoginCodes`: one live code per address, single-use, with the sent code readable. */
export class MemoryLoginCodes implements LoginCodes {
  readonly live = new Map<string, string>()
  private issued = 0
  readonly send = (email: string): Future<Error, void> =>
    Future.create((_, resolve) => {
      this.live.set(email, String(100000 + ++this.issued))
      resolve(undefined)
    })
  readonly consume = (email: string, code: string): Future<Error, boolean> =>
    Future.resolve(this.live.get(email) === code && this.live.delete(email))
}

const TEST_KEYS: VaultKeys = vaultKeys("", "test").unwrap((e) => e)
const aad = (workspaceId: Id<"Workspace">, ref: Id<"AiSecret">): string => `${workspaceId.value}\n${ref.value}`

/** Uses the real `seal`/`open` over a `Map`, so the vault's crypto (and its AAD binding) is exercised, only persistence is faked. */
export class MemoryVault implements SecretVault {
  private readonly rows = new Map<string, { workspaceId: string; sealed: Sealed }>()
  private readonly locks = new Map<string, Promise<void>>()

  readonly put = (workspaceId: Id<"Workspace">, secret: Secret): Future<Error, Id<"AiSecret">> =>
    Future.create((_, resolve) => {
      const ref = Id.random<"AiSecret">()
      this.rows.set(ref.value, {
        workspaceId: workspaceId.value,
        sealed: seal(TEST_KEYS, aad(workspaceId, ref), secret),
      })
      resolve(ref)
    })

  readonly get = (workspaceId: Id<"Workspace">, ref: Id<"AiSecret">): Future<Error, Maybe<Secret>> =>
    Future.create((_, resolve) => {
      const row = this.rows.get(ref.value)
      resolve(
        row === undefined || row.workspaceId !== workspaceId.value
          ? Nothing()
          : open(TEST_KEYS, aad(workspaceId, ref), row.sealed)
      )
    })

  /**
   * As the Postgres vault: `get`, run `f`, re-seal its `Just` under the same ref and AAD, return what is stored now.
   * Calls on one ref queue on `locks`, the in-memory stand-in for `FOR UPDATE`, so overlapping updates run one after the other.
   */
  readonly update = (
    workspaceId: Id<"Workspace">,
    ref: Id<"AiSecret">,
    f: (secret: Secret) => Future<Error, Maybe<Secret>>
  ): Future<Error, Maybe<Secret>> => Future.attemptP(() => this.locked(ref, () => this.replace(workspaceId, ref, f)))

  private locked<T>(ref: Id<"AiSecret">, run: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(ref.value) ?? Promise.resolve()).then(run)
    this.locks.set(
      ref.value,
      result.then(
        () => undefined,
        () => undefined
      )
    )
    return result
  }

  private async replace(
    workspaceId: Id<"Workspace">,
    ref: Id<"AiSecret">,
    f: (secret: Secret) => Future<Error, Maybe<Secret>>
  ): Promise<Maybe<Secret>> {
    const current = await this.get(workspaceId, ref).promise((e) => e)
    if (current instanceof Nothing) return current
    const changed = await f(current.value).promise((e) => e)
    if (changed instanceof Nothing) return current
    this.rows.set(ref.value, {
      workspaceId: workspaceId.value,
      sealed: seal(TEST_KEYS, aad(workspaceId, ref), changed.value),
    })
    return changed
  }

  /** Every sealed ref this workspace still holds, so a test can prove nothing was left behind. */
  refsFor(workspaceId: Id<"Workspace">): string[] {
    return [...this.rows].filter(([, row]) => row.workspaceId === workspaceId.value).map(([ref]) => ref)
  }

  readonly remove = (workspaceId: Id<"Workspace">, refs: Id<"AiSecret">[]): Future<Error, void> =>
    Future.create((_, resolve) => {
      for (const ref of refs) {
        const row = this.rows.get(ref.value)
        if (row !== undefined && row.workspaceId === workspaceId.value) this.rows.delete(ref.value)
      }
      resolve(undefined)
    })
}

const OPEN_ATTEMPT_STATES: readonly AttemptState[] = ["pending", "verification_failed"]
const LEASE_DURATION = Duration.seconds(30)

type StoredAttempt = Attempt & { leaseUntil: POSIX | null }

/** Mirrors `postgresAttempts`' lease semantics (a 30 s claim, cleared on settle) over a `Map`. */
export class MemoryAttempts implements Attempts {
  private readonly rows = new Map<string, StoredAttempt>()

  readonly open = (attempt: Attempt): Future<Error, Id<"AiSecret">[]> =>
    Future.create((_, resolve) => {
      const refs: Id<"AiSecret">[] = []
      for (const row of this.rows.values()) {
        if (row.workspaceId.value === attempt.workspaceId.value && OPEN_ATTEMPT_STATES.includes(row.state)) {
          row.state = "superseded"
          row.leaseUntil = null
          if (row.secretRef instanceof Just) refs.push(row.secretRef.value)
          if (row.credentialRef instanceof Just) refs.push(row.credentialRef.value)
        }
      }
      this.rows.set(attempt.attemptId.value, { ...attempt, leaseUntil: null })
      resolve(refs)
    })

  readonly find = (workspaceId: Id<"Workspace">, attemptId: Id<"AiAttempt">): Future<Error, Maybe<Attempt>> =>
    Future.create((_, resolve) => resolve(this.lookup(workspaceId, attemptId)))

  readonly claim = (workspaceId: Id<"Workspace">, attemptId: Id<"AiAttempt">): Future<Error, Maybe<Attempt>> =>
    Future.create((_, resolve) => {
      const row = this.rows.get(attemptId.value)
      const now = POSIX.now()
      if (
        row === undefined ||
        row.workspaceId.value !== workspaceId.value ||
        !OPEN_ATTEMPT_STATES.includes(row.state) ||
        (row.leaseUntil !== null && row.leaseUntil.isAfter(now))
      ) {
        resolve(Nothing())
        return
      }
      row.leaseUntil = now.addDuration(LEASE_DURATION)
      resolve(Just(toAttempt(row)))
    })

  readonly settle = (
    workspaceId: Id<"Workspace">,
    attemptId: Id<"AiAttempt">,
    next: Settlement
  ): Future<Error, boolean> =>
    Future.create((_, resolve) => {
      const row = this.rows.get(attemptId.value)
      if (
        row === undefined ||
        row.workspaceId.value !== workspaceId.value ||
        !OPEN_ATTEMPT_STATES.includes(row.state)
      ) {
        resolve(false)
        return
      }
      row.state = next.state
      row.failure = next.failure
      row.credentialRef = next.credentialRef
      row.leaseUntil = null
      resolve(true)
    })

  readonly cancel = (
    workspaceId: Id<"Workspace">,
    attemptId: Id<"AiAttempt">
  ): Future<Error, Maybe<Id<"AiSecret">[]>> =>
    Future.create((_, resolve) => {
      const row = this.rows.get(attemptId.value)
      if (
        row === undefined ||
        row.workspaceId.value !== workspaceId.value ||
        !OPEN_ATTEMPT_STATES.includes(row.state)
      ) {
        resolve(Nothing())
        return
      }
      const held = [row.secretRef, row.credentialRef].flatMap((ref) => (ref instanceof Just ? [ref.value] : []))
      row.state = "cancelled"
      row.failure = Just("cancelled")
      row.credentialRef = Nothing()
      row.leaseUntil = null
      resolve(Just(held))
    })

  private lookup(workspaceId: Id<"Workspace">, attemptId: Id<"AiAttempt">): Maybe<Attempt> {
    const row = this.rows.get(attemptId.value)
    return row === undefined || row.workspaceId.value !== workspaceId.value ? Nothing() : Just(toAttempt(row))
  }
}

function toAttempt(row: StoredAttempt): Attempt {
  const { leaseUntil: _leaseUntil, ...attempt } = row
  return attempt
}

/** Builds the `AiConnections` a command handler receives in tests: the test adapter over a fresh (or given) `FakeProvider`. */
export function memoryAi(options?: { fake?: FakeProvider; adapter?: ProviderAdapter }): AiConnections {
  const fake = options?.fake ?? new FakeProvider("http://localhost:5173/jobs/")
  return {
    routes: routeViews("test"),
    adapter: () => Just(options?.adapter ?? testAdapter(fake)),
    vault: new MemoryVault(),
    attempts: new MemoryAttempts(),
    fakeProvider: Just(fake),
  }
}
