export { useProfile, type ProfileState, type Save }

import { useCallback, useEffect, useRef, useState } from "react"
import { Future } from "@lib/future"
import { loadHandle } from "@module/access/handle"
import { notifyProfileChanged } from "@module/profile/helpers/profile-events"
import { readProfile } from "@module/profile/helpers/read-profile"
import { readDoc, writeDoc } from "@module/profile/helpers/write-profile"
import { type Edit, type SaveError } from "@module/profile/helpers/write-profile"
import { type Profile } from "@module/profile/types"
import { snapshotProbe } from "@module/scout/helpers/fsa"
import { probe } from "@module/scout/helpers/probe"
import { err, ok } from "@module/scout/result"
import { type Result } from "@module/scout/result"

type ProfileState =
  | { readonly kind: "loading" }
  | { readonly kind: "read-failed"; readonly detail: string }
  | { readonly kind: "wrong-root"; readonly label: string; readonly missing: readonly string[] }
  | { readonly kind: "loaded"; readonly profile: Profile }

type Save = (file: string, edits: readonly Edit[]) => Future<SaveError, void>

// No `enabled` argument, unlike useStore: ProfileGate only mounts this below a
// granted AccessGate, so the handle is already proven reachable.
function useProfile(): {
  readonly state: ProfileState
  readonly save: Save
  readonly reload: () => void
} {
  const [state, setState] = useState<ProfileState>({ kind: "loading" })
  const [nonce, setNonce] = useState(0)
  // The stamps the visible fields were read at. A ref, not state, so save()
  // keeps its empty dependency list and never holds a stale copy.
  const stamps = useRef<Readonly<Record<string, number>>>({})

  useEffect(() => {
    let ignore = false

    const load = async (): Promise<void> => {
      try {
        const loaded = await loadHandle()
        if (ignore) return
        if (loaded.kind === "err") {
          setState({ kind: "read-failed", detail: loaded.error })
          return
        }
        if (loaded.value === null) {
          setState({ kind: "read-failed", detail: "No folder handle stored" })
          return
        }
        // Same required-file probe the store gate runs: without it an arbitrary
        // folder reads as a profile with every section empty, and Settings
        // offers fields whose saves can only fail as missing files.
        const checked = probe(await snapshotProbe(loaded.value))
        if (ignore) return
        if (checked.kind === "failed") {
          setState({ kind: "wrong-root", label: loaded.value.name, missing: checked.missing })
          return
        }
        const profile = await readProfile(loaded.value)
        if (ignore) return
        stamps.current = profile.stamps
        setState({ kind: "loaded", profile })
      } catch (error) {
        if (ignore) return
        setState({ kind: "read-failed", detail: error instanceof Error ? error.message : String(error) })
      }
    }

    void load()

    return () => {
      ignore = true
    }
  }, [nonce])

  // The document is re-read at save time to apply the edits onto whatever is on
  // disk, but the staleness check compares the page-load stamp: the edits were
  // computed from the fields rendered then, so anything written since would be
  // overwritten silently. The post-write stamp is adopted so a second save on
  // the same card does not refuse itself while the reload is still in flight.
  const save = useCallback((file: string, edits: readonly Edit[]): Future<SaveError, void> => {
    const write = async (): Promise<Result<void, SaveError>> => {
      const handle = await loadHandle()
      if (handle.kind === "err" || handle.value === null) return err({ kind: "stale", file })
      const loaded = await readDoc(handle.value, file)
      if (loaded.kind === "err") return loaded
      const expected = { doc: loaded.value.doc, modified: stamps.current[file] ?? loaded.value.modified }
      const written = await writeDoc(handle.value, file, expected, edits)
      if (written.kind === "err") return written
      stamps.current = { ...stamps.current, [file]: written.value }
      setNonce((n) => n + 1)
      // basics.yaml also feeds the sidebar's identity, which lives above this
      // hook's tree and cannot see the nonce.
      notifyProfileChanged()
      return ok(undefined)
    }
    // A write already under way can't be taken back, so there is nothing to cancel.
    return Future.createUncancellable<SaveError, void>((reject, resolve) => {
      void write().then((result) => (result.kind === "ok" ? resolve(undefined) : reject(result.error)))
    })
  }, [])

  const reload = useCallback((): void => setNonce((n) => n + 1), [])

  return { state, save, reload }
}
