import assert from "node:assert/strict"
import { randomUUID, randomBytes, createHash } from "node:crypto"
import { Pool } from "pg"
import * as s from "@lib/json/schema"
import { api } from "@be/api"
import { PlainEndpoint } from "@be/app/endpoint"
import { type NoteDto } from "@be/domain/note/query/noteSchema"
import { Id } from "@be/lib/event-sourcing/event"
import env from "@be/app/environment"
import { codeDigest, loginCodeSecretFromEnv } from "@be/app/loginCodes"

export const HTTP_TIMEOUT_MS = 10000
export const EVENTUAL_TIMEOUT_MS = 60000

export type EventRow = {
  event_id: string
  event_name: string
  aggregate_id: string
  aggregate_version: string | number
  recorded_on: string
  causation_id: string
  correlation_id: string
  payload: string
}

export type EngineSubscription = {
  id: string
  state: string
  desired_state?: string
  error?: string
}

export async function withCleanup<T>(
  action: () => Promise<T>,
  cleanup: Array<() => Promise<unknown>>,
  message: string
): Promise<T> {
  let value!: T
  let actionFailed = false
  let actionError: unknown
  try {
    value = await action()
  } catch (error) {
    actionFailed = true
    actionError = error
  }

  const cleanupErrors: unknown[] = []
  for (const clean of cleanup) {
    try {
      await clean()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (actionFailed && cleanupErrors.length > 0) {
    throw new AggregateError([actionError, ...cleanupErrors], message, { cause: actionError })
  }
  if (actionFailed) throw actionError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, message)
  return value
}

/** Construct only from an executing test hook, never while tests are collected. */
export function createLiveFixture(): LiveFixture {
  return new LiveFixture()
}

export class LiveFixture {
  readonly baseUrl: string
  private readonly pool: Pool
  private currentCaseId: string | undefined
  private createdIds: Set<Id<"Note">> = new Set()
  private closed = false
  private cookie: string | undefined

  constructor() {
    this.baseUrl = process.env["TEST_API_URL"] ?? "http://localhost:8080"
    this.pool = new Pool({
      host: env.EVENT_STORE_HOST,
      port: env.EVENT_STORE_PORT,
      database: env.EVENT_STORE_DATABASE,
      user: env.EVENT_STORE_USER,
      password: env.EVENT_STORE_PASSWORD,
    })
  }

  beginCase(name: string): string {
    assert.equal(this.currentCaseId, undefined, "A live test case is already active")
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "case"
    this.currentCaseId = `${slug}-${randomUUID()}`
    this.createdIds = new Set()
    return this.currentCaseId
  }

  get caseId(): string {
    assert.ok(this.currentCaseId, "Begin a live test case before using its identifier")
    return this.currentCaseId
  }

  async runCase<T>(name: string, action: () => Promise<T>): Promise<T> {
    this.beginCase(name)
    return withCleanup(action, [() => this.finishCase()], `Live case ${this.caseId} and cleanup failed`)
  }

  async finishCase(): Promise<void> {
    const ids = [...this.createdIds]
    const caseId = this.currentCaseId
    this.currentCaseId = undefined
    this.createdIds = new Set()
    const failures: unknown[] = []
    for (const noteId of ids) {
      try {
        await this.call(api.command.note_deleteNote, { noteId })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Unable to clean up notes for live case ${caseId ?? "unknown"}`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  }

  async post(path: string, payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const cookie = this.cookie ?? (await this.signIn())
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
      body: JSON.stringify(payload),
    })
  }

  /** Insert a session for a throwaway user straight into `auth_sessions`, and keep its cookie for every later `post`. */
  private async signIn(): Promise<string> {
    const token = randomBytes(32).toString("base64url")
    await this.pool.query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [createHash("sha256").update(token).digest("hex"), `live-${randomUUID()}`]
    )
    this.cookie = `sid=${token}`
    return this.cookie
  }

  async call<Req, Res>(endpoint: PlainEndpoint<Req, Res>, payload: Req): Promise<Res> {
    const response = await this.post(endpoint.path, s.encode(endpoint.request, payload))
    const body: unknown = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    return s.decode(endpoint.response, body).unwrap((message) => message)
  }

  async eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + EVENTUAL_TIMEOUT_MS
    while (Date.now() < deadline) {
      const value = await read()
      if (accept(value)) return value
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`Condition did not converge within ${EVENTUAL_TIMEOUT_MS / 1000} seconds`)
  }

  async activeNote(noteId: Id<"Note">): Promise<NoteDto | undefined> {
    const { notes } = await this.call(api.query.note_query_notes, {})
    return notes.find((note) => note.noteId.value === noteId.value)
  }

  async engineRequest(path: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
    const response = await this.request(path, init)
    const text = await response.text()
    let body: unknown
    try {
      body = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    return { response, body }
  }

  async engineSubscriptions(): Promise<EngineSubscription[]> {
    const { response, body } = await this.engineRequest("/api/dev/engine/subscriptions")
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.ok(Array.isArray(body))
    return body as EngineSubscription[]
  }

  async subscription(id: string): Promise<EngineSubscription> {
    const subscriptions = await this.engineSubscriptions()
    const item = subscriptions.find((subscription) => subscription.id === id)
    assert.ok(item, `Engine subscription ${id} must be exposed`)
    return item
  }

  async setSubscriptionState(id: string, state: "paused" | "running"): Promise<void> {
    const action = state === "paused" ? "pause" : "resume"
    const { response, body } = await this.engineRequest(
      `/api/dev/engine/subscriptions/${encodeURIComponent(id)}/${action}`,
      { method: "POST" }
    )
    assert.equal(response.status, 200, JSON.stringify(body))
    await this.eventually(
      () => this.engineSubscriptions(),
      (items) => items.find((item) => item.id === id)?.state === state
    )
  }

  async withRestoredSubscription<T>(id: string, action: () => Promise<T>): Promise<T> {
    const subscription = await this.subscription(id)
    assert.ok(
      subscription.state === "running" || subscription.state === "paused",
      `Cannot safely restore subscription ${id} from state ${subscription.state}`
    )
    return withCleanup(
      action,
      [() => this.setSubscriptionState(id, subscription.state as "running" | "paused")],
      `Engine subscription ${id} operation and state restoration failed`
    )
  }

  async createNote(title: string, body: string): Promise<Id<"Note">> {
    const noteId = Id.random<"Note">()
    this.trackNote(noteId)
    await this.call(api.command.note_createNote, { noteId, title, body })
    return noteId
  }

  async history<Tag extends string>(aggregateId: Id<Tag>): Promise<EventRow[]> {
    const rows = await this.pool.query<EventRow>(
      "SELECT event_id, event_name, aggregate_id, aggregate_version, recorded_on::text AS recorded_on, causation_id, correlation_id, payload FROM event_store WHERE aggregate_id = $1 ORDER BY aggregate_version",
      [aggregateId.value]
    )
    return rows.rows
  }

  /** Seeds `auth_login_codes` directly, the way `postgresLoginCodes.send` would, so a test can drive `verify-code` without mail. */
  async seedLoginCode(email: string, code: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_login_codes (email, code_hash, expires_at, sent_at, attempts)
       VALUES ($1, $2, now() + interval '10 minutes', now(), 0)
       ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, sent_at = now(), attempts = 0`,
      [email, codeDigest(loginCodeSecretFromEnv(), email, code)]
    )
  }

  /** How many live login-code rows exist for `email` — used to assert `request-code` wrote none for an unlisted address. */
  async countLoginCodes(email: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT count(*) FROM auth_login_codes WHERE email = $1",
      [email]
    )
    return Number(rows[0]?.count ?? 0)
  }

  /** The stored code row for `email`, if any, so a test can see whether `request-code` replaced it. */
  async loginCode(email: string): Promise<{ codeHash: string; attempts: number } | undefined> {
    const { rows } = await this.pool.query<{ code_hash: string; attempts: number }>(
      "SELECT code_hash, attempts FROM auth_login_codes WHERE email = $1",
      [email]
    )
    const row = rows[0]
    return row === undefined ? undefined : { codeHash: row.code_hash, attempts: row.attempts }
  }

  /** Move `email`'s code back past the resend cooldown and, when `expired`, past its expiry too. */
  async ageLoginCode(email: string, { expired }: { expired: boolean }): Promise<void> {
    await this.pool.query(
      `UPDATE auth_login_codes SET sent_at = now() - interval '1 minute'${expired ? ", expires_at = now() - interval '1 second'" : ""} WHERE email = $1`,
      [email]
    )
  }

  async deliver(row: EventRow): Promise<void> {
    const credentials = Buffer.from(`${env.EVENT_BUS_USERNAME}:${env.EVENT_BUS_PASSWORD}`).toString("base64")
    const response = await this.post(
      "/api/v1/note/projection/notes",
      {
        data_source_id: "postgres_source",
        data_source_description: "Notepad events in PostgreSQL",
        data_destination_id: "Note_Projection_Notes",
        data_destination_description: "Notes read model",
        payload: row,
      },
      { Authorization: `Basic ${credentials}` }
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { result: { success: {} } })
  }

  trackNote(noteId: Id<"Note">): void {
    this.caseId
    this.createdIds.add(noteId)
  }
}
