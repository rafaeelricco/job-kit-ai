export { readProfile }

import {
  parseAnswers,
  parseBasics,
  parseCvs,
  parseJobSearch,
  parseLanguages,
  parsePacks,
  parseProfiles,
  parseRecommendations,
} from "@module/profile/helpers/parse-profile"
import { type Basics, type JobSearch, type Profile, type Resume } from "@module/profile/types"
import { type Result } from "@module/scout/result"

type Gap = { readonly file: string; readonly detail: string }

// job-apply's CV ladder: `base` under cv/, and this file when base is absent,
// unreadable, or empty.
const FALLBACK_RESUME = "en-us-resume.pdf"

const emptyBasics: Basics = {
  name: "",
  email: "",
  phone: "",
  location: "",
  country: "",
  urlLabel: "",
  urlHref: "",
}

const emptyJobSearch: JobSearch = {
  workModel: [],
  jobTypes: [],
  datePosted: [],
  positions: [],
  locations: [],
  locationScope: "",
  excludeLocations: [],
  excludeCompanies: [],
  directRegions: [],
  marketCurrencies: [],
  pruneScoreMax: 0,
}

// Each file is read independently: a missing recommendations.yaml is an empty
// section, and an unparseable candidate.yaml costs only the Answers section.
async function readProfile(root: FileSystemDirectoryHandle): Promise<Profile> {
  const gaps: Gap[] = []
  const stamps: Record<string, number> = {}

  const data = await root.getDirectoryHandle("data").then(
    (handle) => handle,
    () => null
  )

  // Each file is parsed independently: one unparseable file pushes a gap and
  // leaves its own section empty rather than blanking the others.
  async function section<T>(name: string, parse: (text: string) => Result<T, string>, fallback: T): Promise<T> {
    if (data === null) return fallback
    const found = await readStamped(data, name)
    if (found === null) return fallback
    stamps[name] = found.modified
    const parsed = parse(found.text)
    if (parsed.kind === "err") {
      gaps.push({ file: `data/${name}`, detail: parsed.error })
      return fallback
    }
    return parsed.value
  }

  // cvs.yaml stays hand-rolled: it is the one file whose parse feeds two
  // unrelated fields, `base` (the resume listing) and `adaptPerVacancy`.
  const cvs = data === null ? null : await readStamped(data, "cvs.yaml")
  let base = ""
  let adaptPerVacancy = true
  if (cvs !== null) {
    stamps["cvs.yaml"] = cvs.modified
    const parsed = parseCvs(cvs.text)
    if (parsed.kind === "err") gaps.push({ file: "data/cvs.yaml", detail: parsed.error })
    else {
      base = parsed.value.base
      adaptPerVacancy = parsed.value.adaptPerVacancy
    }
  }

  const answers = await section("candidate.yaml", parseAnswers, [])
  const recommendations = await section("recommendations.yaml", parseRecommendations, [])
  const basics = await section("basics.yaml", parseBasics, emptyBasics)
  const socials = await section("profiles.yaml", parseProfiles, [])
  const languages = await section("languages.yaml", parseLanguages, [])
  const jobSearch = await section("job_search.yaml", parseJobSearch, emptyJobSearch)
  const packs = await section("search_packs.yaml", parsePacks, [])

  return {
    label: root.name,
    resumes: await listResumes(root, base),
    adaptPerVacancy,
    answers,
    recommendations,
    basics,
    socials,
    languages,
    jobSearch,
    packs,
    stamps,
    gaps,
  }
}

// An absent optional file is indistinguishable from an unreadable one at the
// call site, and neither throws: both read as "this section has nothing".
// `modified` is kept so a save can refuse a file a skill changed underneath.
async function readStamped(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<{ readonly text: string; readonly modified: number } | null> {
  try {
    const blob = await (await dir.getFileHandle(name)).getFile()
    return { text: await blob.text(), modified: blob.lastModified }
  } catch {
    return null
  }
}

async function listResumes(root: FileSystemDirectoryHandle, base: string): Promise<readonly Resume[]> {
  let cv: FileSystemDirectoryHandle
  try {
    cv = await root.getDirectoryHandle("cv")
  } catch {
    return []
  }

  // job-apply's CV ladder falls back to cv/en-us-resume.pdf when `base` is
  // absent, unreadable, or empty — the state the shipped cvs.yaml template
  // ships in. Resolving it here is what makes the badge name the file that
  // would actually be attached.
  const activeFile = base === "" ? FALLBACK_RESUME : base

  const pdfs: string[] = []
  const tex = new Set<string>()
  try {
    for await (const [name, entry] of cv.entries()) {
      if (entry.kind !== "file") continue
      if (name.endsWith(".pdf")) pdfs.push(name)
      else if (name.endsWith(".tex")) tex.add(name)
    }
  } catch {
    return []
  }
  pdfs.sort()

  const resumes = await Promise.all(
    pdfs.map(async (file): Promise<Resume> => {
      const stem = file.slice(0, -".pdf".length)
      const sibling = `${stem}.tex`
      let bytes = 0
      let modified = ""
      try {
        const handle = await cv.getFileHandle(file)
        const blob = await handle.getFile()
        bytes = blob.size
        modified = new Date(blob.lastModified).toISOString().slice(0, 10)
      } catch {
        // A PDF that lists but will not open still belongs on screen — naming
        // it is how the user learns the file is unreadable.
      }
      return {
        file,
        bytes,
        modified,
        active: file === activeFile,
        source: tex.has(sibling) ? sibling : null,
      }
    })
  )

  return resumes
}
