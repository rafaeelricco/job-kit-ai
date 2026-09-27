export { controller, handler }

import { Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { type Response } from "@be/lib/router"
import { type Command, type CommandResponse, endpoint } from "@be/domain/note/command/updateNote.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth } from "@be/app/auth/policy"
import { Note, activeNote, sameContent } from "@be/domain/note/aggregate/note"
import { NoteUpdated } from "@be/domain/note/events/note/noteUpdated"
import { type NoteError, parseTitle, internalError, respond } from "@be/domain/note/command/noteErrors"

/**
 * Update a note's title and body. A missing or already-deleted note fails
 * with `not_found`. When the new content is identical to what's stored, no
 * `NoteUpdated` event is emitted — the command is a no-op on the write side.
 */
const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
  respond(parseTitle(payload.title))
    .chain((title) =>
      withEventStore<Response, Result<NoteError, CommandResponse>>(internalError, function* (store) {
        const found = (yield* store.try_find(Note, payload.noteId)).chain(activeNote)
        if (found instanceof Nothing) return Failure({ type: "not_found" })
        if (sameContent(found.value, title, payload.body)) return Success({ success: true })
        yield* store.emit({
          aggregate: Note,
          event: new NoteUpdated({
            type: NoteUpdated.type,
            aggregateId: payload.noteId,
            title,
            body: payload.body,
          }),
        })
        return Success({ success: true })
      })
    )
    .chain(respond)

const controller: CommandController<Command, CommandResponse> = {
  endpoint,
  authGuard: Auth.authenticated(),
  handler,
}
