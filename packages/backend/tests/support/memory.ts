import { Future } from "@lib/future"
import { type Maybe, fromNullable } from "@lib/maybe"
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
