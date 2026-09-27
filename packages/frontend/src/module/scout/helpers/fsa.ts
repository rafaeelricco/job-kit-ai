export { readJobs, readSkills, snapshotProbe, trashJobs }

import { dossierName } from "@module/scout/helpers/dossier-name"
import { type ProbeFiles } from "@module/scout/helpers/probe"
import { err, ok, partition } from "@module/scout/result"
import { type Result } from "@module/scout/result"
import { type ParseError, type TrashFailure, type TrashOpError, type Trashed } from "@module/scout/types"

type MovableHandle = FileSystemFileHandle & {
  move: (parent: FileSystemDirectoryHandle, name?: string) => Promise<void>
}

const isNotFound = (error: unknown): boolean => error instanceof DOMException && error.name === "NotFoundError"

const isNotAllowed = (error: unknown): boolean => error instanceof DOMException && error.name === "NotAllowedError"

async function snapshotProbe(root: FileSystemDirectoryHandle): Promise<ProbeFiles> {
  let data: FileSystemDirectoryHandle
  try {
    data = await root.getDirectoryHandle("data")
  } catch {
    return { candidate: false, jobSearch: false }
  }
  const candidate = await data.getFileHandle("candidate.yaml").then(
    () => true,
    () => false
  )
  const jobSearch = await data.getFileHandle("job_search.yaml").then(
    () => true,
    () => false
  )
  return { candidate, jobSearch }
}

const INLINE_ITEMS = /^\s*items:\s*\[(.*)\]\s*(?:#.*)?$/
const BLOCK_ITEM = /^\s*-\s+(?:"([^"]+)"|'([^']+)'|([^:#]+))\s*$/

const splitInlineItems = (raw: string): readonly string[] =>
  [...raw.matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((match) => match[1] ?? match[2])
    .filter((item): item is string => item !== undefined)

const parseSkillItems = (text: string): readonly string[] =>
  text.split("\n").flatMap((line) => {
    const inline = INLINE_ITEMS.exec(line)
    if (inline?.[1] !== undefined) return splitInlineItems(inline[1])
    const block = BLOCK_ITEM.exec(line)
    if (!block) return []
    const item = (block[1] ?? block[2] ?? block[3])?.trim() ?? ""
    return item !== "" ? [item] : []
  })

async function readSkills(root: FileSystemDirectoryHandle): Promise<readonly string[]> {
  try {
    const data = await root.getDirectoryHandle("data")
    const handle = await data.getFileHandle("skills.yaml")
    const text = await (await handle.getFile()).text()
    return parseSkillItems(text)
  } catch {
    return []
  }
}

async function readJobs(
  root: FileSystemDirectoryHandle
): Promise<Result<readonly Result<{ readonly file: string; readonly raw: string }, ParseError>[], string>> {
  let jobs: FileSystemDirectoryHandle
  try {
    const scout = await root.getDirectoryHandle("scout")
    jobs = await scout.getDirectoryHandle("jobs")
  } catch (error) {
    if (isNotFound(error)) return ok([])
    return err(error instanceof Error ? error.message : String(error))
  }

  try {
    const names: string[] = []
    for await (const [name, entry] of jobs.entries()) {
      if (entry.kind === "file" && name.endsWith(".md")) names.push(name)
    }
    names.sort()
    const files = await Promise.all(
      names.map(async (file): Promise<Result<{ readonly file: string; readonly raw: string }, ParseError>> => {
        try {
          const handle = await jobs.getFileHandle(file)
          const raw = await (await handle.getFile()).text()
          return ok({ file, raw })
        } catch (error) {
          return err({
            file,
            at: "read",
            cause: { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) },
          })
        }
      })
    )
    return ok(files)
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}

async function trashJobs(
  root: FileSystemDirectoryHandle,
  files: readonly string[]
): Promise<Result<Trashed, TrashOpError>> {
  let jobs: FileSystemDirectoryHandle
  try {
    const scout = await root.getDirectoryHandle("scout")
    jobs = await scout.getDirectoryHandle("jobs")
  } catch (error) {
    if (isNotFound(error)) return err({ kind: "jobs-missing" })
    if (isNotAllowed(error)) return err({ kind: "not-allowed" })
    return err({ kind: "failed", detail: error instanceof Error ? error.message : String(error) })
  }

  let trash: FileSystemDirectoryHandle
  try {
    trash = await jobs.getDirectoryHandle(".trash", { create: true })
  } catch (error) {
    if (isNotAllowed(error)) return err({ kind: "not-allowed" })
    if (isNotFound(error)) return err({ kind: "stale" })
    return err({ kind: "failed", detail: error instanceof Error ? error.message : String(error) })
  }

  const results = await Promise.all(files.map((file) => moveOne(jobs, trash, file)))
  const { values, errors } = partition(results)
  return ok({ moved: values, failed: errors })
}

async function moveOne(
  jobs: FileSystemDirectoryHandle,
  trash: FileSystemDirectoryHandle,
  file: string
): Promise<Result<string, TrashFailure>> {
  const confined = dossierName(file)
  if (confined.kind === "err") return confined

  try {
    const source = await jobs.getFileHandle(file)
    const target = await freeName(trash, file)
    if (typeof (source as MovableHandle).move === "function") {
      await (source as MovableHandle).move(trash, target)
      return ok(file)
    }
    const blob = await (await source.getFile()).arrayBuffer()
    const dest = await trash.getFileHandle(target, { create: true })
    const writable = await dest.createWritable()
    await writable.write(blob)
    await writable.close()
    await jobs.removeEntry(file)
    return ok(file)
  } catch (error) {
    return err({ file, reason: error instanceof Error ? error.message : String(error) })
  }
}

async function freeName(trash: FileSystemDirectoryHandle, file: string): Promise<string> {
  try {
    await trash.getFileHandle(file)
    return `${file.slice(0, -".md".length)}-${Date.now()}.md`
  } catch {
    return file
  }
}
