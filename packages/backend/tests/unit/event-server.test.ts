import { expect, test, vi } from "vitest"
import { defineAPI } from "@be/lib/event-sourcing/server"
import { api } from "@be/api"
import { controller as auth_requestCode } from "@be/domain/auth/command/requestCode"
import { controller as auth_verifyCode } from "@be/domain/auth/command/verifyCode"
import { controller as auth_signOut } from "@be/domain/auth/command/signOut"
import { controller as auth_query_whoAmI } from "@be/domain/auth/query/whoAmI"
import { controller as create } from "@be/domain/note/command/createNote"
import { controller as update } from "@be/domain/note/command/updateNote"
import { controller as remove } from "@be/domain/note/command/deleteNote"
import { controller as get } from "@be/domain/note/query/getNote"
import { controller as list } from "@be/domain/note/query/listNotes"
import { accept } from "@be/lib/event-sourcing/projection"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { Id } from "@be/lib/event-sourcing/event"
import { Failure } from "@lib/result"
import { Nothing } from "@lib/maybe"
import * as s from "@lib/json/schema"
import * as d from "@lib/json/decoder"

test("registers every command and query with its matching controller", () => {
  const command = vi.fn()
  const query = vi.fn()
  const impl = {
    command: {
      auth_requestCode,
      auth_verifyCode,
      auth_signOut,
      note_createNote: create,
      note_updateNote: update,
      note_deleteNote: remove,
    },
    query: { auth_query_whoAmI, note_query_note: get, note_query_notes: list },
  }
  defineAPI(api, impl, command, query)
  expect(command.mock.calls).toEqual([
    [api.command.auth_requestCode, auth_requestCode],
    [api.command.auth_verifyCode, auth_verifyCode],
    [api.command.auth_signOut, auth_signOut],
    [api.command.note_createNote, create],
    [api.command.note_updateNote, update],
    [api.command.note_deleteNote, remove],
  ])
  expect(query.mock.calls).toEqual([
    [api.query.auth_query_whoAmI, auth_query_whoAmI],
    [api.query.note_query_note, get],
    [api.query.note_query_notes, list],
  ])
})

test("projection decoder distinguishes supported, unknown and malformed events", () => {
  const decoder = accept([NoteCreated])
  const event = new NoteCreated({ type: NoteCreated.type, aggregateId: new Id("note-1"), title: "Hello", body: "" })
  expect(
    d
      .decode(s.encode(NoteCreated.schema, event), decoder)
      .unwrap(String)
      .maybe<unknown>(null, (value) => value)
  ).toEqual(event)
  expect(d.decode({ type: "FutureEvent" }, decoder).unwrap(String)).toBeInstanceOf(Nothing)
  expect(d.decode({ type: NoteCreated.type }, decoder)).toBeInstanceOf(Failure)
  expect(d.decode({}, decoder)).toBeInstanceOf(Failure)
})

test("deterministic IDs are stable, type-scoped, padded base36 values", async () => {
  const { Note } = await import("@be/domain/note/aggregate/note")
  const id = Id.deterministicForAggregate(Note, "seed").unwrap(String)
  expect(id.value).toBe("44cy64frfoue12stse984zjbpmrk10ox8i2elvdrsv2fmejh9j")
  expect(Id.deterministicForEvent({ type: "Note" }, "seed").unwrap(String).value).toBe(id.value)
  expect(Id.deterministicForEvent({ type: "Other" }, "seed").unwrap(String).value).not.toBe(id.value)
  expect(Id.deterministicForAggregate(Note, "other").unwrap(String).value).not.toBe(id.value)
  expect(new Id("a").compare(new Id("b"))).toBe(-1)
  expect(new Id("b").compare(new Id("a"))).toBe(1)
  expect(new Id("a").compare(new Id("a"))).toBe(0)
})
