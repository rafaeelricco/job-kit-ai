export { clearHandle, hasDirectoryPicker, loadHandle, persistHandle, pickDirectory, queryWrite, requestWrite }
export type { Permission, PickError }

import { err, ok } from "@module/scout/result"
import { type Result } from "@module/scout/result"

const DB = "job-kit"
const STORE = "directory-handles"
const KEY = "profile-root"
const MODE = { mode: "readwrite" as const }

// Survives the tab only when IndexedDB put fails after a successful pick.
let sessionHandle: FileSystemDirectoryHandle | null = null
// Bumped by every write (persist, clear). A read that started under an older generation answered
// about a folder that has since been replaced or forgotten, so it must not be cached.
let generation = 0

type PickError =
  | { readonly kind: "unsupported" }
  | { readonly kind: "aborted" }
  | { readonly kind: "insecure" }
  | { readonly kind: "failed"; readonly detail: string }

type Permission =
  { readonly kind: "granted" } | { readonly kind: "prompt" } | { readonly kind: "denied" } | { readonly kind: "stale" }

// lib.dom lacks showDirectoryPicker / queryPermission / requestPermission.
type DirectoryPickerWindow = Window & {
  showDirectoryPicker: (options?: {
    id?: string
    mode?: "read" | "readwrite"
    startIn?: "documents" | "desktop" | "downloads"
  }) => Promise<FileSystemDirectoryHandle>
}

type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
  requestPermission: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
}

function hasDirectoryPicker(w: Window): boolean {
  return w.isSecureContext && typeof (w as DirectoryPickerWindow).showDirectoryPicker === "function"
}

async function pickDirectory(): Promise<Result<FileSystemDirectoryHandle, PickError>> {
  if (!window.isSecureContext) return err({ kind: "insecure" })
  if (!hasDirectoryPicker(window)) return err({ kind: "unsupported" })
  try {
    const handle = await (window as unknown as DirectoryPickerWindow).showDirectoryPicker({
      id: "job-kit-profile",
      mode: "readwrite",
      startIn: "documents",
    })
    return ok(handle)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return err({ kind: "aborted" })
    return err({ kind: "failed", detail: error instanceof Error ? error.message : String(error) })
  }
}

async function queryWrite(handle: FileSystemDirectoryHandle): Promise<Permission> {
  try {
    return mapPermission(await (handle as PermissionedHandle).queryPermission(MODE))
  } catch (error) {
    return isNotFound(error) ? { kind: "stale" } : { kind: "denied" }
  }
}

async function requestWrite(handle: FileSystemDirectoryHandle): Promise<Permission> {
  try {
    return mapPermission(await (handle as PermissionedHandle).requestPermission(MODE))
  } catch (error) {
    return isNotFound(error) ? { kind: "stale" } : { kind: "denied" }
  }
}

const mapPermission = (state: PermissionState): Permission => {
  if (state === "granted") return { kind: "granted" }
  if (state === "denied") return { kind: "denied" }
  return { kind: "prompt" }
}

const isNotFound = (error: unknown): boolean => error instanceof DOMException && error.name === "NotFoundError"

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"))
  })
}

async function persistHandle(handle: FileSystemDirectoryHandle): Promise<Result<void, string>> {
  generation += 1
  sessionHandle = handle
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(handle, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB put failed"))
    })
    db.close()
    return ok(undefined)
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}

async function loadHandle(): Promise<Result<FileSystemDirectoryHandle | null, string>> {
  if (sessionHandle !== null) return ok(sessionHandle)
  const startedAt = generation
  try {
    const db = await openDb()
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const request = tx.objectStore(STORE).get(KEY)
      request.onsuccess = () => {
        const value = request.result
        resolve(value instanceof FileSystemDirectoryHandle ? value : null)
      }
      request.onerror = () => reject(request.error ?? new Error("indexedDB get failed"))
    })
    db.close()
    if (startedAt !== generation) return ok(sessionHandle)
    if (handle !== null) sessionHandle = handle
    return ok(handle)
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}

async function clearHandle(): Promise<Result<void, string>> {
  generation += 1
  sessionHandle = null
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB delete failed"))
    })
    db.close()
    return ok(undefined)
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}
