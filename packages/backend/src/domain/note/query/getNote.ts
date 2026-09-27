export { controller, handler }

import { Future } from "@lib/future"
import { type Response } from "@be/lib/router"
import { type Query, type QueryResponse, endpoint } from "@be/domain/note/query/getNote.api"
import { type QueryController, type QueryHandler } from "@be/app/handlers"
import { Auth } from "@be/app/auth/policy"
import { RepoNotes, activeDocument } from "@be/domain/note/projection/notes"
import { toResponse } from "@be/domain/note/command/noteErrors"
import { internalServerError } from "@be/app/responses"
import { toNoteDto } from "@be/domain/note/query/noteSchema"

/** Look up one note by id; a missing or deleted note replies `not_found`. */
const handler: QueryHandler<Query, QueryResponse> = ({ payload, projections }) =>
  projections[RepoNotes.collectionName]
    .getById(payload.noteId)
    .mapRej((): Response => internalServerError)
    .chain((found) =>
      found
        .chain(activeDocument)
        .maybe<Future<Response, QueryResponse>>(Future.reject(toResponse({ type: "not_found" })), (note) =>
          Future.resolve({ note: toNoteDto(note) })
        )
    )

const controller: QueryController<Query, QueryResponse> = { endpoint, authGuard: Auth.authenticated(), handler }
