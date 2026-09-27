export { schema_noteDto, type NoteDto, toNoteDto }

import * as s from "@lib/json/schema"

import { POSIX } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"
import { type NoteDocument } from "@be/domain/note/projection/notes"

const schema_noteDto = s.object({
  noteId: Id.schema<"Note">(),
  title: s.string,
  body: s.string,
  createdAt: POSIX.schema,
  updatedAt: POSIX.schema,
})
type NoteDto = s.Infer<typeof schema_noteDto>

/** Project a read-model document onto the wire shape, dropping `status`: queries only return live notes. */
function toNoteDto(doc: NoteDocument): NoteDto {
  return { noteId: doc.noteId, title: doc.title, body: doc.body, createdAt: doc.createdAt, updatedAt: doc.updatedAt }
}
