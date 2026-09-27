export { useAccess, type Access }

import { useCallback, useEffect, useState } from "react"
import { notifyAccessChanged } from "@module/access/access-events"
import {
  hasDirectoryPicker,
  loadHandle,
  persistHandle,
  pickDirectory,
  queryWrite,
  requestWrite,
} from "@module/access/handle"
import { type Permission, type PickError } from "@module/access/handle"
import { err, ok } from "@module/scout/result"
import { type Result } from "@module/scout/result"

type Access =
  | { readonly kind: "hydrating" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "no-handle" }
  | { readonly kind: "prompt" }
  | { readonly kind: "denied" }
  | { readonly kind: "stale" }
  | { readonly kind: "granted" }

const fromPermission = (permission: Permission): Access => {
  switch (permission.kind) {
    case "granted":
      return { kind: "granted" }
    case "prompt":
      return { kind: "prompt" }
    case "denied":
      return { kind: "denied" }
    case "stale":
      return { kind: "stale" }
  }
}

function useAccess(): {
  readonly state: Access
  readonly pick: () => Promise<Result<void, PickError>>
  readonly request: () => Promise<Result<void, Permission>>
  readonly changeFolder: () => Promise<Result<void, PickError>>
} {
  const [state, setState] = useState<Access>({ kind: "hydrating" })

  // Surfaces above the gate hold their own useAccess instance and cannot see
  // this one's state, so a grant is announced rather than propagated. Hydration
  // keeps the plain setter: a mount-time read already has the folder.
  const settle = useCallback((next: Access): void => {
    setState(next)
    if (next.kind === "granted") notifyAccessChanged()
  }, [])

  useEffect(() => {
    let ignore = false

    const hydrate = async (): Promise<void> => {
      if (!hasDirectoryPicker(window)) {
        if (!ignore) setState({ kind: "unsupported" })
        return
      }
      const loaded = await loadHandle()
      if (ignore) return
      if (loaded.kind === "err") {
        setState({ kind: "no-handle" })
        return
      }
      if (loaded.value === null) {
        setState({ kind: "no-handle" })
        return
      }
      const permission = await queryWrite(loaded.value)
      if (!ignore) setState(fromPermission(permission))
    }

    void hydrate()
    return () => {
      ignore = true
    }
  }, [])

  // Picker must run in the click turn — no await before showDirectoryPicker.
  const pick = useCallback(async (): Promise<Result<void, PickError>> => {
    const picked = await pickDirectory()
    if (picked.kind === "err") {
      if (picked.error.kind === "aborted") return picked
      if (picked.error.kind === "unsupported" || picked.error.kind === "insecure") {
        setState({ kind: "unsupported" })
      }
      return picked
    }
    const saved = await persistHandle(picked.value)
    if (saved.kind === "err") {
      // Session still proceeds with the live handle this visit.
      settle({ kind: "granted" })
      return ok(undefined)
    }
    const permission = await queryWrite(picked.value)
    settle(fromPermission(permission))
    return ok(undefined)
  }, [settle])

  const request = useCallback(async (): Promise<Result<void, Permission>> => {
    const loaded = await loadHandle()
    if (loaded.kind === "err" || loaded.value === null) {
      setState({ kind: "no-handle" })
      return err({ kind: "stale" })
    }
    const permission = await requestWrite(loaded.value)
    settle(fromPermission(permission))
    return permission.kind === "granted" ? ok(undefined) : err(permission)
  }, [settle])

  const changeFolder = useCallback(async (): Promise<Result<void, PickError>> => pick(), [pick])

  return { state, pick, request, changeFolder }
}
