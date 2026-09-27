import { endpoint as auth_requestCode } from "@be/domain/auth/command/requestCode.api"
import { endpoint as auth_verifyCode } from "@be/domain/auth/command/verifyCode.api"
import { endpoint as auth_signOut } from "@be/domain/auth/command/signOut.api"
import { endpoint as auth_query_whoAmI } from "@be/domain/auth/query/whoAmI.api"
import { endpoint as note_createNote } from "@be/domain/note/command/createNote.api"
import { endpoint as note_updateNote } from "@be/domain/note/command/updateNote.api"
import { endpoint as note_deleteNote } from "@be/domain/note/command/deleteNote.api"
import { endpoint as note_query_note } from "@be/domain/note/query/getNote.api"
import { endpoint as note_query_notes } from "@be/domain/note/query/listNotes.api"

export const api = {
  command: { auth_requestCode, auth_verifyCode, auth_signOut, note_createNote, note_updateNote, note_deleteNote },
  query: { auth_query_whoAmI, note_query_note, note_query_notes },
}
