import { Future } from "@lib/future"
import { type Response } from "@be/lib/router"
import { PlainEndpoint } from "@be/app/endpoint"
import { type ReadProjections } from "@be/app/projections"
import { type WithEventStore } from "@be/lib/event-sourcing/store"
import { type Actor } from "@be/app/actor"
import { type AuthGuard, type AuthGuardResult } from "@be/app/auth/policy"
import { type Session } from "@be/app/session"
import { type LoginCodes } from "@be/app/loginCodes"
import { type AiConnections } from "@be/app/ai/connections"

/** What the guard's allow branch proved — the handler's `auth`. */
type Allowed<Result extends AuthGuardResult> = Extract<Result, { result: "allow" }>

/**
 * A command's business logic. Receives the decoded payload, the caller and the
 * proof its guard minted, the request's session, and the event store runner;
 * rejects with the HTTP reply to send.
 *
 * ```ts
 * const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
 *   withEventStore(internalError, function* (store) { ... })
 * ```
 */
export type CommandHandler<Req, Res, Result extends AuthGuardResult = AuthGuardResult> = (args: {
  payload: Req
  actor: Actor
  auth: Allowed<Result>
  session: Session
  loginCodes: LoginCodes
  ai: AiConnections
  withEventStore: WithEventStore
}) => Future<Response, Res>

/**
 * A query's business logic. Receives the decoded payload, the caller and its
 * proof, and read-only access to the projections; rejects with the HTTP reply to send.
 */
export type QueryHandler<Req, Res, Result extends AuthGuardResult = AuthGuardResult> = (args: {
  payload: Req
  actor: Actor
  auth: Allowed<Result>
  projections: ReadProjections
}) => Future<Response, Res>

export type CommandController<Req, Res, Result extends AuthGuardResult = AuthGuardResult> = {
  endpoint: PlainEndpoint<Req, Res>
  authGuard: AuthGuard<Result>
  handler: CommandHandler<Req, Res, Result>
}

export type QueryController<Req, Res, Result extends AuthGuardResult = AuthGuardResult> = {
  endpoint: PlainEndpoint<Req, Res>
  authGuard: AuthGuard<Result>
  handler: QueryHandler<Req, Res, Result>
}
