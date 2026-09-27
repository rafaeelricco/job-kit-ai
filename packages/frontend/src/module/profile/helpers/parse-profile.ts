export {
  parseAnswers,
  parseBasics,
  parseCvs,
  parseJobSearch,
  parseLanguages,
  parsePacks,
  parseProfiles,
  parseRecommendations,
}

import { parse } from "yaml"
import {
  type Answer,
  type Basics,
  type JobSearch,
  type Language,
  type Recommendation,
  type SearchPack,
  type SocialProfile,
  type Toggle,
} from "@module/profile/types"
import { err, ok } from "@module/scout/result"
import { type Result } from "@module/scout/result"

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])
const asText = (v: unknown): string =>
  typeof v === "string" ? v
  : typeof v === "number" ? String(v)
  : ""
const asBool = (v: unknown): boolean => v === true
const asNumber = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const toStrings = (v: unknown): readonly string[] => asArray(v).map(asText)
const toToggles = (v: unknown): readonly Toggle[] =>
  Object.entries(asRecord(v) ?? {}).map(([key, value]) => ({ key, on: asBool(value) }))

const load = (text: string): Result<unknown, string> => {
  try {
    return ok(parse(text))
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error))
  }
}

// cvs.yaml is two scalars; an absent adapt_per_vacancy means true, which is the
// skill contract's default, not a guess.
function parseCvs(text: string): Result<{ readonly base: string; readonly adaptPerVacancy: boolean }, string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const root = asRecord(doc.value)
  const adapt = root?.adapt_per_vacancy
  return ok({ base: asText(root?.base), adaptPerVacancy: typeof adapt === "boolean" ? adapt : true })
}

// candidate.yaml screening_defaults.qa[]. A row without a question has no
// identity and is dropped rather than rendered blank.
function parseAnswers(text: string): Result<readonly Answer[], string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const rows = asArray(asRecord(asRecord(doc.value)?.screening_defaults)?.qa)
  return ok(
    rows.flatMap((row, index) => {
      const item = asRecord(row)
      const question = asText(item?.question).trim()
      if (item === null || question === "") return []
      const answer = asText(item.answer)
      const scope = asText(item.scope)
      return [
        {
          id: String(index),
          question,
          answer,
          answered: answer.trim() !== "",
          scope: scope === "" ? null : scope,
          source: asText(item.source),
          confirmedAt: asText(item.confirmed_at),
        },
      ]
    })
  )
}

// A recommendation with no recommender is not one, so an author-less row is
// dropped. `id` is a slug in the file but not guaranteed, so the row index
// backs it — a key has to exist before React can list the rows.
function parseRecommendations(text: string): Result<readonly Recommendation[], string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const rows = asArray(asRecord(doc.value)?.recommendations)
  return ok(
    rows.flatMap((row, index) => {
      const item = asRecord(row)
      const author = asText(item?.author).trim()
      if (item === null || author === "") return []
      const id = asText(item.id).trim()
      return [
        {
          id: id === "" ? String(index) : id,
          author,
          role: asText(item.role),
          company: asText(item.company),
          relationship: asText(item.relationship),
          date: asText(item.date),
          channel: asText(item.channel),
          url: asText(item.url),
          text: asText(item.text),
        },
      ]
    })
  )
}

// basics.yaml is flat scalars plus a nested url map. A non-mapping root reads
// as all-empty rather than a parse failure: an empty file is a form to fill.
function parseBasics(text: string): Result<Basics, string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const root = asRecord(doc.value)
  const url = asRecord(root?.url)
  return ok({
    name: asText(root?.name),
    email: asText(root?.email),
    phone: asText(root?.phone),
    location: asText(root?.location),
    country: asText(root?.country),
    urlLabel: asText(url?.label),
    urlHref: asText(url?.href),
  })
}

// profiles.yaml profiles[]. The file's own rule — a network with an empty
// username is not a link — drops the row. The label key is read back as the row
// spells it (`network`, or `x` on the row that uses it) so a save writes to the
// key already there instead of adding a second one.
function parseProfiles(text: string): Result<readonly SocialProfile[], string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const rows = asArray(asRecord(doc.value)?.profiles)
  return ok(
    rows.flatMap((row, index) => {
      const item = asRecord(row)
      const username = asText(item?.username).trim()
      if (item === null || username === "") return []
      const key = "x" in item && !("network" in item) ? "x" : "network"
      return [{ id: String(index), key, network: asText(item[key]), username, url: asText(item.url) }]
    })
  )
}

// languages.yaml languages[]. A nameless row names no language, so it is
// dropped; `level` is carried verbatim, the file's rule.
function parseLanguages(text: string): Result<readonly Language[], string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const rows = asArray(asRecord(doc.value)?.languages)
  return ok(
    rows.flatMap((row, index) => {
      const item = asRecord(row)
      const name = asText(item?.name).trim()
      if (item === null || name === "") return []
      return [{ id: String(index), name, level: asText(item.level) }]
    })
  )
}

// job_search.yaml is a flat root of bool maps and string lists. The three bool
// maps keep file order so the form reads like the file.
function parseJobSearch(text: string): Result<JobSearch, string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const root = asRecord(doc.value)
  return ok({
    workModel: toToggles(root?.work_model),
    jobTypes: toToggles(root?.job_types),
    datePosted: toToggles(root?.date_posted),
    positions: toStrings(root?.positions),
    locations: toStrings(root?.locations),
    locationScope: asText(root?.location_scope),
    excludeLocations: toStrings(root?.exclude_locations),
    excludeCompanies: toStrings(root?.exclude_companies),
    directRegions: toStrings(root?.direct_regions),
    marketCurrencies: toStrings(root?.market_currencies),
    pruneScoreMax: asNumber(root?.prune_score_max),
  })
}

// search_packs.yaml packs[]. An id-less pack cannot be run or addressed, so it
// is dropped — but `index` counts positions in the unfiltered array, because a
// save writes to the row's place in the file, not its place on screen.
function parsePacks(text: string): Result<readonly SearchPack[], string> {
  const doc = load(text)
  if (doc.kind === "err") return doc
  const rows = asArray(asRecord(doc.value)?.packs)
  return ok(
    rows.flatMap((row, index) => {
      const item = asRecord(row)
      const id = asText(item?.id).trim()
      if (item === null || id === "") return []
      const enabledPresent = "enabled" in item
      return [
        {
          id,
          index,
          surface: asText(item.surface),
          entry: asText(item.entry),
          enabled: enabledPresent ? asBool(item.enabled) : true,
          enabledPresent,
          formulations: toStrings(item.formulations),
        },
      ]
    })
  )
}
