export { Note, type NoteStatus, activeNote, sameContent }

import { POSIX } from "@lib/time"
import { type Aggregate, Id } from "@be/lib/event-sourcing/event"
import { type Maybe, Just, Nothing } from "@lib/maybe"

/** The two states a note can be in: live, or soft-deleted so late events still find it. */
const NOTE_STATUSES = ["Active", "Deleted"] as const
type NoteStatus = (typeof NOTE_STATUSES)[number]

type NoteValues = {
  readonly aggregateId: Id<"Note">
  readonly aggregateVersion: number
  readonly title: string
  readonly body: string
  readonly createdAt: POSIX
  readonly updatedAt: POSIX
  readonly status: NoteStatus
}

class Note implements Aggregate<"Note"> {
  static readonly type = "Note"

  readonly values: NoteValues
  constructor(values: NoteValues) {
    this.values = values
  }

  get aggregateId(): Id<"Note"> {
    return this.values.aggregateId
  }

  get aggregateVersion(): number {
    return this.values.aggregateVersion
  }
}

/**
 * `Nothing` for a tombstoned note — the one place callers need to check
 * whether a note is still live before acting on it.
 */
function activeNote(note: Note): Maybe<Note> {
  return note.values.status === "Active" ? Just(note) : Nothing()
}

/** True when `title` and `body` match `note`'s current values — an update that would be a no-op. */
function sameContent(note: Note, title: string, body: string): boolean {
  return note.values.title === title && note.values.body === body
}
