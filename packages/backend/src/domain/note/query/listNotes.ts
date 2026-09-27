export { controller, handler }

import { type Response } from "@be/lib/router"
import { type Query, type QueryResponse, endpoint } from "@be/domain/note/query/listNotes.api"
import { type QueryController, type QueryHandler } from "@be/app/handlers"
import { Auth } from "@be/app/auth/policy"
import { RepoNotes } from "@be/domain/note/projection/notes"
import { internalServerError } from "@be/app/responses"
import { toNoteDto } from "@be/domain/note/query/noteSchema"

const handler: QueryHandler<Query, QueryResponse> = ({ projections }) =>
  projections[RepoNotes.collectionName]
    .findActive()
    .mapRej((): Response => internalServerError)
    .map((notes) => ({ notes: notes.map(toNoteDto) }))

const controller: QueryController<Query, QueryResponse> = { endpoint, authGuard: Auth.authenticated(), handler }
