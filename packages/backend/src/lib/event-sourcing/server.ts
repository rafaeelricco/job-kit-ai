export { type ApiEndpoints, type Implementation, defineAPI }

import { PlainEndpoint } from "@be/app/endpoint"
import { type CommandController, type QueryController } from "@be/app/handlers"

/**
 * `PlainEndpoint<Req, Res>` is invariant in `Req`/`Res` (its `Schema` carries
 * an encoder, which consumes them), so matching "is this a `PlainEndpoint`
 * regardless of its request/response types" in the conditional types below
 * needs the `any`-bound form (`PlainEndpoint<any, any>`) — the standard,
 * deliberately variance-defeating idiom for that check; `unknown` would make
 * the `extends` clause fail for every concrete endpoint. Controllers are likewise
 * matched with `any` for their guard `Result`, since a handler is contravariant in the proof it receives.
 */
type Endpoints = Record<string, PlainEndpoint<any, any>>
type ApiEndpoints = { command: Endpoints; query: Endpoints }

/** The controllers an `ApiEndpoints` needs: one command or query controller per endpoint. */
type Implementation<A extends ApiEndpoints> = {
  command: Commands<A["command"]>
  query: Queries<A["query"]>
}
type Commands<Api extends Endpoints> = {
  [P in keyof Api]: Api[P] extends PlainEndpoint<infer Req, infer Res> ? CommandController<Req, Res, any> : never
}
type Queries<Api extends Endpoints> = {
  [P in keyof Api]: Api[P] extends PlainEndpoint<infer Req, infer Res> ? QueryController<Req, Res, any> : never
}

/**
 * `Object.keys` erases the key-to-value correlation `Commands`/`Queries`
 * establish at the type level between an endpoint and its controller, so
 * reading a controller back out by a runtime `key` needs one narrowing
 * cast — kept to these two small helpers instead of scattered at each call
 * site, and to `unknown`/`unknown` (rather than `any`/`any`) so the erasure
 * doesn't leak further than this lookup.
 */
function commandFor(
  impl: Implementation<ApiEndpoints>["command"],
  key: string
): CommandController<unknown, unknown, any> {
  return impl[key] as CommandController<unknown, unknown, any>
}

function queryFor(impl: Implementation<ApiEndpoints>["query"], key: string): QueryController<unknown, unknown, any> {
  return impl[key] as QueryController<unknown, unknown, any>
}

/**
 * Wire every endpoint in `api` to its controller in `impl`, via `defineCommand`/
 * `defineQuery`. The framework-specific registration (e.g. mounting an Express
 * route) lives in those two callbacks, not here.
 */
function defineAPI<A extends ApiEndpoints>(
  api: A,
  impl: Implementation<A>,
  defineCommand: (
    endpoint: PlainEndpoint<unknown, unknown>,
    controller: CommandController<unknown, unknown, any>
  ) => void,
  defineQuery: (endpoint: PlainEndpoint<unknown, unknown>, controller: QueryController<unknown, unknown, any>) => void
): void {
  for (const key of Object.keys(api.command)) {
    const endpoint = api.command[key]
    if (endpoint instanceof PlainEndpoint) defineCommand(endpoint, commandFor(impl.command, key))
  }
  for (const key of Object.keys(api.query)) {
    const endpoint = api.query[key]
    if (endpoint instanceof PlainEndpoint) defineQuery(endpoint, queryFor(impl.query, key))
  }
}
