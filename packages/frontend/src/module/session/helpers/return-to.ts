export { returnState, returnTo }

import * as s from "@lib/json/schema"
import { type Json } from "@lib/json/types"

const schema_returnState = s.object({ from: s.string })

function returnState(location: { pathname: string; search: string; hash: string }): Json {
  return s.encode(schema_returnState, { from: location.pathname + location.search + location.hash })
}

/** Router state is `unknown` (history survives reloads and other code), so decode it like any boundary value. */
function returnTo(state: unknown): string {
  return s.decode(schema_returnState, state).either(
    () => "/",
    ({ from }) => from
  )
}
