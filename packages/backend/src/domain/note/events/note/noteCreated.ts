export { NoteCreated }

import * as s from "@lib/json/schema"

import { type EventInfo, CreationEvent, Id, toSchema } from "@be/lib/event-sourcing/event"
import { Note } from "@be/domain/note/aggregate/note"

const type = "NoteCreated" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"Note">(),
  title: s.string,
  body: s.string,
})

class NoteCreated extends CreationEvent<Note> {
  static readonly aggregate = Note
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  createAggregate(info: EventInfo): Note {
    return new Note({
      aggregateId: this.values.aggregateId,
      aggregateVersion: 0,
      title: this.values.title,
      body: this.values.body,
      createdAt: info.recorded_on,
      updatedAt: info.recorded_on,
      status: "Active",
    })
  }
}
