export { editScalar, readDoc, writeDoc, type Edit, type Loaded, type SaveError }

import { isScalar, isSeq, parseDocument } from "yaml"
import { type Document, type YAMLSeq } from "yaml"
import { err, ok } from "@module/scout/result"
import { type Result } from "@module/scout/result"

type Path = readonly (string | number)[]

type Edit =
  { readonly op: "set"; readonly path: Path; readonly value: unknown } | { readonly op: "delete"; readonly path: Path }

type SaveError =
  | { readonly kind: "missing"; readonly file: string }
  | { readonly kind: "invalid"; readonly file: string; readonly detail: string }
  | { readonly kind: "stale"; readonly file: string }
  | { readonly kind: "not-allowed" }
  | { readonly kind: "failed"; readonly detail: string }

type Loaded = { readonly doc: Document; readonly modified: number }

// skills.yaml is the one file serialized at the default width: its flow
// sequences (`items: [ "a", "b" ]`) collapse onto one long line at lineWidth 0.
// Every other file holds long quoted prose that the 80-column default reflows,
// rewriting lines the user never touched. Verified byte-identical round-trip
// across all 13 data files under this split.
const widthFor = (file: string) => (file === "skills.yaml" ? {} : { lineWidth: 0 })

async function readDoc(root: FileSystemDirectoryHandle, file: string): Promise<Result<Loaded, SaveError>> {
  try {
    const data = await root.getDirectoryHandle("data")
    const handle = await data.getFileHandle(file)
    const blob = await handle.getFile()
    const doc = parseDocument(await blob.text())
    const failure = doc.errors[0]
    if (failure !== undefined) return err({ kind: "invalid", file, detail: failure.message })
    return ok({ doc, modified: blob.lastModified })
  } catch (error) {
    return err(mapError(error, file))
  }
}

// A skill run rewrites these same files between page load and save. Comparing
// mtime against the stamp the caller rendered its fields at turns that race
// into a refusal: the cost is reloading the page, where overwriting costs the
// skill's work. Returns the post-write mtime so the caller can keep editing.
async function writeDoc(
  root: FileSystemDirectoryHandle,
  file: string,
  loaded: Loaded,
  edits: readonly Edit[]
): Promise<Result<number, SaveError>> {
  try {
    const data = await root.getDirectoryHandle("data")
    const handle = await data.getFileHandle(file)
    if ((await handle.getFile()).lastModified !== loaded.modified) return err({ kind: "stale", file })

    for (const edit of edits) {
      if (edit.op === "delete") loaded.doc.deleteIn(edit.path)
      else editScalar(loaded.doc, edit.path, edit.value)
    }

    // createWritable() buffers to a swap file and swaps on close(), so a failed
    // write leaves the original intact rather than truncated.
    const writable = await handle.createWritable()
    try {
      await writable.write(loaded.doc.toString(widthFor(file)))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw error
    }
    return ok((await handle.getFile()).lastModified)
  } catch (error) {
    return err(mapError(error, file))
  }
}

// setIn replaces the node at `path`, dropping any comment attached to it —
// data/job_search.yaml carries trailing comments on individual list items
// (`# North America`) and data/languages.yaml on a level. Mutating an existing
// Scalar's value leaves the node, and its comment, in place. Only a path with
// no node yet falls back to setIn.
function editScalar(doc: Document, path: Path, value: unknown): void {
  const node = path.length === 0 ? null : doc.getIn(path, true)
  if (isScalar(node)) {
    node.value = value
    return
  }
  // Replacing a sequence drops each item's quoting, so `- "Brazil"` comes back
  // as `- Brazil` — the same YAML value, but every line of the list reads as
  // changed in a diff. Editing the items that stayed, and only appending or
  // trimming the tail, keeps the untouched ones byte-identical.
  if (isSeq(node) && Array.isArray(value)) {
    editSeq(node, value)
    return
  }
  doc.setIn(path, value)
}

// The node is reused rather than rebuilt: a surviving item keeps its own
// formatting and trailing comment, and only a genuinely new entry is created.
function editSeq(node: YAMLSeq, value: readonly unknown[]): void {
  for (const [index, next] of value.entries()) {
    const item = node.get(index, true)
    if (isScalar(item)) item.value = next
    else node.set(index, next)
  }
  while (node.items.length > value.length) node.items.pop()
}

function mapError(error: unknown, file: string): SaveError {
  if (error instanceof DOMException) {
    if (error.name === "NotFoundError") return { kind: "missing", file }
    if (error.name === "NotAllowedError") return { kind: "not-allowed" }
  }
  return { kind: "failed", detail: error instanceof Error ? error.message : String(error) }
}
