import * as D from "@lib/json/decoder"

const string = D.string
const number = D.stringNumber

const optionalDefault = <T>(value: T, decoder: D.Decoder<T>) => D.optionalDefault(value, decoder)

/** Every environment variable this app reads, each with a development-friendly default so a local run needs no `.env`. */
const envDecoder = D.object({
  NODE_ENV: optionalDefault("development", string),
  PORT: optionalDefault(8080, number),
  EVENT_STORE_USER: optionalDefault("notepad", string),
  EVENT_STORE_PASSWORD: optionalDefault("notepad", string),
  EVENT_STORE_HOST: optionalDefault("postgres", string),
  EVENT_STORE_PORT: optionalDefault(5432, number),
  EVENT_STORE_DATABASE: optionalDefault("notepad_events", string),
  EVENT_STORE_CREATE_TABLE_WITH_NAME: optionalDefault("event_store", string),
  EVENT_STORE_CREATE_REPLICATION_USER_WITH_USERNAME: optionalDefault("notepad_replication", string),
  EVENT_STORE_CREATE_REPLICATION_USER_WITH_PASSWORD: optionalDefault("local_notepad_replication", string),
  EVENT_STORE_CREATE_REPLICATION_PUBLICATION: optionalDefault("notepad_publication", string),
  MONGODB_PROJECTION_USER: optionalDefault("notepad", string),
  MONGODB_PROJECTION_PASSWORD: optionalDefault("local_notepad_mongo", string),
  MONGODB_PROJECTION_HOST: optionalDefault("mongo", string),
  MONGODB_PROJECTION_PORT: optionalDefault(27017, number),
  MONGODB_PROJECTION_DATABASE: optionalDefault("notepad_projections", string),
  MONGODB_PROJECTION_REPLICA_SET: optionalDefault("rs0", string),
  MONGODB_PROJECTION_AUTH_DB: optionalDefault("admin", string),
  EVENT_BUS_USERNAME: optionalDefault("notepad_event_bus", string),
  EVENT_BUS_PASSWORD: optionalDefault("local_notepad_event_bus", string),
  ENGINE_OPERATOR_URL: optionalDefault("http://postie:8081", string),
  ENGINE_OPERATOR_TOKEN: optionalDefault("change-me", string),
  /** Where the SPA lives; Google redirects land here, and the OAuth redirect URI is derived from its origin. */
  APP_URL: optionalDefault("http://localhost:5173/jobs/", string),
  GOOGLE_CLIENT_ID: optionalDefault("", string),
  GOOGLE_CLIENT_SECRET: optionalDefault("", string),
  /** `smtps://user:pass@host:465`. Empty logs mail to stdout (refused in production). */
  SMTP_URL: optionalDefault("", string),
  MAIL_FROM: optionalDefault("Job Kit <login@localhost>", string),
  /** Key for the HMAC of stored login codes; keep it out of the database. Empty uses a fixed key (refused in production). */
  LOGIN_CODE_SECRET: optionalDefault("", string),
})

/**
 * Parsed, validated environment. Importing this module throws if any
 * variable fails to decode — fail fast at startup, by design, rather than
 * deep inside a request.
 */
const environment = D.decode(process.env, envDecoder).unwrap((err) => `Unable to parse environment variables:\n${err}`)
export default environment
