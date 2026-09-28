// eslint-disable-next-line react-refresh/only-export-components -- the hook reads the same context the provider writes; splitting them would force every consumer to import from two files for one concept.
export { AiSetupProvider, useAiSetup }

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"

import { api } from "@api/endpoints"
import { call, type FetchError } from "@api/request"
import { type Cancel } from "@lib/future"
import { Failed, Loading, NotAsked, Ready, type RemoteData } from "@lib/remote-data"
import { type AiSetupView } from "@module/ai/types"

type AiSetupCell = {
  /** The whole setup snapshot: `NotAsked` until the mount read fires, then `Loading` / `Failed` / `Ready`. */
  readonly state: RemoteData<FetchError, AiSetupView>
  /**
   * Swap the cell's value in place with a command response's own `setup`. Every AI command returns the setup it
   * produced, so the acting tab never has to wait for the read-model projection to catch up before it can render.
   * Stable across renders, so an effect can list it as a dependency.
   */
  readonly replace: (setup: AiSetupView) => void
  /** Re-run the `aiSetup` read from scratch (`Loading` again), for a caller that wants the projection's own view. */
  readonly reload: () => void
}

const AiSetupContext = createContext<AiSetupCell | null>(null)

/**
 * Holds one `RemoteData<FetchError, AiSetupView>` cell for the whole app: the onboarding wizard, the setup gate,
 * the reconnect banner and the settings AI panel all read it, so a command response written on one route is what
 * the next route sees (the `aiSetup` projection lags commands by a few seconds). `App` renders exactly one, keyed
 * on the signed-in user so a different account never inherits the previous one's cell. While `enabled` is false
 * (no signed-in user) it stays `NotAsked` and reads nothing. Follows the page-state-cell recipe in `pages.md`:
 * seed `NotAsked`, set `Loading` then `fork` inside `useEffect`, and return the fork's cancel.
 */
function AiSetupProvider({ enabled, children }: { readonly enabled: boolean; readonly children: ReactNode }) {
  const [state, setState] = useState<RemoteData<FetchError, AiSetupView>>(NotAsked())
  const [generation, setGeneration] = useState(0)
  const cancel = useRef<Cancel>(() => {})

  useEffect(() => {
    if (!enabled) return
    // The page-state-cell recipe (pages.md): seed `NotAsked`, then flip to `Loading` the moment the mount read
    // starts, so a slow read shows a spinner instead of a stale `NotAsked` screen. `Failed`/`Ready` land later
    // from the fork's own async callbacks, which this rule doesn't flag.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setState(Loading())
    cancel.current = call(api.aiSetup, {}).fork(
      (error) => setState(Failed(error)),
      (setup) => setState(Ready(setup))
    )
    return () => cancel.current()
  }, [enabled, generation])

  const replace = useCallback((setup: AiSetupView): void => setState(Ready(setup)), [])
  const reload = useCallback((): void => setGeneration((n) => n + 1), [])

  return <AiSetupContext.Provider value={{ state, replace, reload }}>{children}</AiSetupContext.Provider>
}

function useAiSetup(): AiSetupCell {
  const cell = useContext(AiSetupContext)
  if (cell === null) throw new Error("useAiSetup must be used within an AiSetupProvider")
  return cell
}
