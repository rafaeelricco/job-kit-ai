export { controller, handler }

import { Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { type Response } from "@be/lib/router"
import { type Command, type CommandResponse, endpoint } from "@be/domain/note/command/deleteNote.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth } from "@be/app/auth/policy"
import { Note } from "@be/domain/note/aggregate/note"
import { NoteDeleted } from "@be/domain/note/events/note/noteDeleted"
import { type NoteError, internalError, respond } from "@be/domain/note/command/noteErrors"

/**
 * Delete a note. A missing note fails with `not_found`; deleting a note
 * that is already deleted succeeds without emitting a new `NoteDeleted`
 * event, so retries are safe.
 */
const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
  withEventStore<Response, Result<NoteError, CommandResponse>>(internalError, function* (store) {
    const found = yield* store.try_find(Note, payload.noteId)
    if (found instanceof Nothing) return Failure({ type: "not_found" })
    if (found.value.values.status === "Deleted") return Success({ success: true })
    yield* store.emit({
      aggregate: Note,
      event: new NoteDeleted({
        type: NoteDeleted.type,
        aggregateId: payload.noteId,
      }),
    })
    return Success({ success: true })
  }).chain(respond)

const controller: CommandController<Command, CommandResponse> = {
  endpoint,
  authGuard: Auth.authenticated(),
  handler,
}
