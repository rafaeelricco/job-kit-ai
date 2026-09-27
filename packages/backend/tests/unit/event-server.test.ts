import { expect, test, vi } from "vitest"
import { defineAPI } from "@be/lib/event-sourcing/server"
import { api } from "@be/api"
import { controller as auth_requestCode } from "@be/domain/auth/command/requestCode"
import { controller as auth_verifyCode } from "@be/domain/auth/command/verifyCode"
import { controller as auth_signOut } from "@be/domain/auth/command/signOut"
import { controller as auth_query_whoAmI } from "@be/domain/auth/query/whoAmI"
import { controller as ai_completeSetupStep } from "@be/domain/ai/command/completeSetupStep"
import { controller as ai_startAuthorization } from "@be/domain/ai/command/startAuthorization"
import { controller as ai_advanceAuthorization } from "@be/domain/ai/command/advanceAuthorization"
import { controller as ai_cancelAuthorization } from "@be/domain/ai/command/cancelAuthorization"
import { controller as ai_confirmSwitch } from "@be/domain/ai/command/confirmSwitch"
import { controller as ai_discardSwitch } from "@be/domain/ai/command/discardSwitch"
import { controller as ai_testConnection } from "@be/domain/ai/command/testConnection"
import { controller as ai_disconnect } from "@be/domain/ai/command/disconnect"
import { controller as ai_setPreferences } from "@be/domain/ai/command/setPreferences"
import { controller as ai_query_setup } from "@be/domain/ai/query/getSetup"
import { accept } from "@be/lib/event-sourcing/projection"
import { WorkspaceProvisioned } from "@be/domain/workspace/events/workspace/workspaceProvisioned"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
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
      ai_completeSetupStep,
      ai_startAuthorization,
      ai_advanceAuthorization,
      ai_cancelAuthorization,
      ai_confirmSwitch,
      ai_discardSwitch,
      ai_testConnection,
      ai_disconnect,
      ai_setPreferences,
    },
    query: { auth_query_whoAmI, ai_query_setup },
  }
  defineAPI(api, impl, command, query)
  expect(command.mock.calls).toEqual([
    [api.command.auth_requestCode, auth_requestCode],
    [api.command.auth_verifyCode, auth_verifyCode],
    [api.command.auth_signOut, auth_signOut],
    [api.command.ai_completeSetupStep, ai_completeSetupStep],
    [api.command.ai_startAuthorization, ai_startAuthorization],
    [api.command.ai_advanceAuthorization, ai_advanceAuthorization],
    [api.command.ai_cancelAuthorization, ai_cancelAuthorization],
    [api.command.ai_confirmSwitch, ai_confirmSwitch],
    [api.command.ai_discardSwitch, ai_discardSwitch],
    [api.command.ai_testConnection, ai_testConnection],
    [api.command.ai_disconnect, ai_disconnect],
    [api.command.ai_setPreferences, ai_setPreferences],
  ])
  expect(query.mock.calls).toEqual([
    [api.query.auth_query_whoAmI, auth_query_whoAmI],
    [api.query.ai_query_setup, ai_query_setup],
  ])
})

test("projection decoder distinguishes supported, unknown and malformed events", () => {
  const decoder = accept([WorkspaceProvisioned])
  const event = new WorkspaceProvisioned({
    type: WorkspaceProvisioned.type,
    aggregateId: new Id("workspace-1"),
    ownerId: new Id("user-1"),
  })
  expect(
    d
      .decode(s.encode(WorkspaceProvisioned.schema, event), decoder)
      .unwrap(String)
      .maybe<unknown>(null, (value) => value)
  ).toEqual(event)
  expect(d.decode({ type: "FutureEvent" }, decoder).unwrap(String)).toBeInstanceOf(Nothing)
  expect(d.decode({ type: WorkspaceProvisioned.type }, decoder)).toBeInstanceOf(Failure)
  expect(d.decode({}, decoder)).toBeInstanceOf(Failure)
})

test("deterministic IDs are stable, type-scoped, padded base36 values", () => {
  const id = Id.deterministicForAggregate(Workspace, "seed").unwrap(String)
  expect(id.value).toBe("5nv0a4k6ep0qmf3x5zz6bn87i3lng56tafnuh0skhhuasn3gwa")
  expect(Id.deterministicForEvent({ type: "Workspace" }, "seed").unwrap(String).value).toBe(id.value)
  expect(Id.deterministicForEvent({ type: "Other" }, "seed").unwrap(String).value).not.toBe(id.value)
  expect(Id.deterministicForAggregate(Workspace, "other").unwrap(String).value).not.toBe(id.value)
  expect(new Id("a").compare(new Id("b"))).toBe(-1)
  expect(new Id("b").compare(new Id("a"))).toBe(1)
  expect(new Id("a").compare(new Id("a"))).toBe(0)
})
