export { useIdentity, type Identity }

import { useEffect, useState } from "react"
import { subscribeAccessChanged } from "@module/access/access-events"
import { loadHandle } from "@module/access/handle"
import { parseBasics } from "@module/profile/helpers/parse-profile"
import { subscribeProfileChanged } from "@module/profile/helpers/profile-events"

type Identity = { readonly name: string; readonly email: string }

// Unlike useProfile, this runs above AccessGate: the sidebar renders before a
// folder is chosen and stays mounted if permission is refused. No folder, no
// permission, and no basics.yaml are all ordinary here, and each resolves to
// null so the footer can fall back to the product name instead of an error.
function useIdentity(): Identity | null {
  const [identity, setIdentity] = useState<Identity | null>(null)

  useEffect(() => {
    let ignore = false

    const read = async (): Promise<void> => {
      const found = await readIdentity()
      if (!ignore) setIdentity(found)
    }

    void read()
    // The name shown here is the one the settings page edits, so a save
    // refreshes it rather than leaving a stale name until the next reload. The
    // first read runs before any folder is chosen, so a grant refreshes it too.
    const unsubscribeProfile = subscribeProfileChanged(() => void read())
    const unsubscribeAccess = subscribeAccessChanged(() => void read())

    return () => {
      ignore = true
      unsubscribeProfile()
      unsubscribeAccess()
    }
  }, [])

  return identity
}

async function readIdentity(): Promise<Identity | null> {
  try {
    const handle = await loadHandle()
    if (handle.kind === "err" || handle.value === null) return null
    const data = await handle.value.getDirectoryHandle("data")
    const file = await data.getFileHandle("basics.yaml")
    const parsed = parseBasics(await (await file.getFile()).text())
    if (parsed.kind === "err") return null
    const { name, email } = parsed.value
    // A basics.yaml with neither field filled identifies nobody, so it reads as
    // no identity rather than as an empty row with a blank avatar.
    return name.trim() === "" && email.trim() === "" ? null : { name, email }
  } catch {
    return null
  }
}
