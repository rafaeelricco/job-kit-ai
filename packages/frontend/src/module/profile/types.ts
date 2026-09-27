export type { Answer, Basics, JobSearch, Language, Profile, Recommendation, Resume, SearchPack, SocialProfile, Toggle }

type Resume = {
  readonly file: string // basename under cv/
  readonly bytes: number
  readonly modified: string // ISO day
  readonly active: boolean // names cvs.yaml `base`
  readonly source: string | null // sibling .tex, when present
}

type Answer = {
  readonly id: string // index in qa[]; the file has no id field
  readonly question: string
  readonly answer: string
  readonly answered: boolean // answer.trim() !== "" — an empty row is inert
  readonly scope: string | null
  readonly source: string
  readonly confirmedAt: string
}

type Recommendation = {
  readonly id: string
  readonly author: string
  readonly role: string
  readonly company: string
  readonly relationship: string
  readonly date: string
  readonly channel: string
  readonly url: string
  readonly text: string
}

// A boolean flag read off a YAML mapping, kept in file order so the form lists
// the rows the way the file does rather than an alphabetical reshuffle.
type Toggle = { readonly key: string; readonly on: boolean }

// `country` is documented in data/basics.yaml's header but absent from the
// data; the form offers it so the user can fill it without editing YAML.
type Basics = {
  readonly name: string
  readonly email: string
  readonly phone: string
  readonly location: string
  readonly country: string
  readonly urlLabel: string
  readonly urlHref: string
}

// data/profiles.yaml item 3 uses `x` where items 1-2 use `network`. `key`
// records which spelling that row uses so a save edits the row's own key
// instead of normalizing it.
type SocialProfile = {
  readonly id: string
  readonly key: "network" | "x"
  readonly network: string
  readonly username: string
  readonly url: string
}

type Language = { readonly id: string; readonly name: string; readonly level: string }

type JobSearch = {
  readonly workModel: readonly Toggle[]
  readonly jobTypes: readonly Toggle[]
  readonly datePosted: readonly Toggle[]
  readonly positions: readonly string[]
  readonly locations: readonly string[]
  readonly locationScope: string
  readonly excludeLocations: readonly string[]
  readonly excludeCompanies: readonly string[]
  readonly directRegions: readonly string[]
  readonly marketCurrencies: readonly string[]
  readonly pruneScoreMax: number
}

// `enabled` absent means true (data/search_packs.yaml:22-23). `present` records
// whether the file carries the key, so a save writes one only when it must.
type SearchPack = {
  readonly id: string
  readonly index: number
  readonly surface: string
  readonly entry: string
  readonly enabled: boolean
  readonly enabledPresent: boolean
  readonly formulations: readonly string[]
}

// A section renders from this alone. `gaps` carries per-file parse failures so
// one broken file never blanks the other two sections.
type Profile = {
  readonly label: string
  readonly resumes: readonly Resume[]
  readonly adaptPerVacancy: boolean
  readonly answers: readonly Answer[]
  readonly recommendations: readonly Recommendation[]
  readonly basics: Basics
  readonly socials: readonly SocialProfile[]
  readonly languages: readonly Language[]
  readonly jobSearch: JobSearch
  readonly packs: readonly SearchPack[]
  // file name -> lastModified at read time; backs the stale check on save.
  readonly stamps: Readonly<Record<string, number>>
  readonly gaps: readonly { readonly file: string; readonly detail: string }[]
}
