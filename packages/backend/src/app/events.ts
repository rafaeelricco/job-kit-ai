import { CSchema, Schemas, TSchema } from "@be/lib/event-sourcing/store"
import { UserRegistered } from "@be/domain/user/events/user/userRegistered"
import { UserJoined } from "@be/domain/user/events/user/userJoined"
import { WorkspaceProvisioned } from "@be/domain/workspace/events/workspace/workspaceProvisioned"
import { SetupStepCompleted } from "@be/domain/workspace/events/workspace/setupStepCompleted"
import { AiAuthorizationStarted } from "@be/domain/workspace/events/workspace/aiAuthorizationStarted"
import { AiConnectionVerified } from "@be/domain/workspace/events/workspace/aiConnectionVerified"
import { AiConnectionReconnected } from "@be/domain/workspace/events/workspace/aiConnectionReconnected"
import { AiConnectionChecked } from "@be/domain/workspace/events/workspace/aiConnectionChecked"
import { AiSwitchConfirmed } from "@be/domain/workspace/events/workspace/aiSwitchConfirmed"
import { AiSwitchDiscarded } from "@be/domain/workspace/events/workspace/aiSwitchDiscarded"
import { AiConnectionDisconnected } from "@be/domain/workspace/events/workspace/aiConnectionDisconnected"
import { AiPreferencesChanged } from "@be/domain/workspace/events/workspace/aiPreferencesChanged"

/** Registers every event class with the event store's schema registry, so it can encode/decode them by type name. */
export const schemas = new Schemas([
  new CSchema(UserRegistered.aggregate, UserRegistered.schema, UserRegistered.type),
  new CSchema(UserJoined.aggregate, UserJoined.schema, UserJoined.type),
  new CSchema(WorkspaceProvisioned.aggregate, WorkspaceProvisioned.schema, WorkspaceProvisioned.type),
  new TSchema(SetupStepCompleted.aggregate, SetupStepCompleted.schema, SetupStepCompleted.type),
  new TSchema(AiAuthorizationStarted.aggregate, AiAuthorizationStarted.schema, AiAuthorizationStarted.type),
  new TSchema(AiConnectionVerified.aggregate, AiConnectionVerified.schema, AiConnectionVerified.type),
  new TSchema(AiConnectionReconnected.aggregate, AiConnectionReconnected.schema, AiConnectionReconnected.type),
  new TSchema(AiConnectionChecked.aggregate, AiConnectionChecked.schema, AiConnectionChecked.type),
  new TSchema(AiSwitchConfirmed.aggregate, AiSwitchConfirmed.schema, AiSwitchConfirmed.type),
  new TSchema(AiSwitchDiscarded.aggregate, AiSwitchDiscarded.schema, AiSwitchDiscarded.type),
  new TSchema(AiConnectionDisconnected.aggregate, AiConnectionDisconnected.schema, AiConnectionDisconnected.type),
  new TSchema(AiPreferencesChanged.aggregate, AiPreferencesChanged.schema, AiPreferencesChanged.type),
])
