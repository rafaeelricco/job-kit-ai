export { controller, handler }

import { Just } from "@lib/maybe"
import { type Command, type CommandResponse, endpoint } from "@be/domain/note/command/createNote.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth } from "@be/app/auth/policy"
import { Note } from "@be/domain/note/aggregate/note"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { parseTitle, internalError, respond } from "@be/domain/note/command/noteErrors"

/**
 * Create a note. Idempotent on the client-chosen `noteId`: if a note with
 * that id already exists (e.g. a retried request), the create is not
 * repeated and the same response is returned instead of a duplicate event.
 */
const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
  respond(parseTitle(payload.title)).chain((title) =>
    withEventStore(internalError, function* (store) {
      // The client owns the id, so the stream doubles as the command
      // receipt: a retried create finds it and gets the original reply.
      const noteId = payload.noteId
      const existing = yield* store.try_find(Note, noteId)
      if (existing instanceof Just) return { noteId }
      yield* store.emit({
        aggregate: Note,
        event: new NoteCreated({
          type: NoteCreated.type,
          aggregateId: noteId,
          title,
          body: payload.body,
        }),
      })
      return { noteId }
    })
  )

const controller: CommandController<Command, CommandResponse> = {
  endpoint,
  authGuard: Auth.authenticated(),
  handler,
}
