export { PlainEndpoint }

import { Schema } from "@lib/json/schema"

/**
 * One command or query's shape: where it's mounted and how to decode its
 * request and encode its response. Built once per endpoint, shared by the
 * client-facing route table and the server's handler wiring.
 */
class PlainEndpoint<Req, Res> {
  readonly path: string
  readonly request: Schema<Req>
  readonly response: Schema<Res>
  readonly method = "post" as const

  constructor(args: { path: string; request: Schema<Req>; response: Schema<Res> }) {
    this.path = args.path
    this.request = args.request
    this.response = args.response
  }
}
