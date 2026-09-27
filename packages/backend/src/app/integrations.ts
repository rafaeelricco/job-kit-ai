import { Future } from "@lib/future"
import env from "@be/app/environment"
import { initialize as initializeEventStoreSchema, evaluate } from "@be/lib/event-sourcing/store/postgres"
import { Postgres, defaultPoolSettings } from "@be/lib/postgres"
import { Mongo } from "@be/lib/mongo"
import {
  MongoProjectionStore,
  type WithProjectionReader,
  type WithProjectionWriter,
  describeProjectionStoreError,
} from "@be/app/projectionStore"
import { type WithEventStore } from "@be/lib/event-sourcing/store"
import { schemas } from "@be/app/events"
import { type Repositories, initializeRepositories } from "@be/app/projections"
import { type SessionStore, initializeSessionTable, postgresSessionStore } from "@be/app/session"
import {
  type LoginCodes,
  initializeLoginCodeTable,
  loginCodeSecretFromEnv,
  postgresLoginCodes,
} from "@be/app/loginCodes"
import { mailerFromEnv } from "@be/app/mailer"
import { type GoogleOidc, googleOidc } from "@be/lib/google-oidc"
import { GOOGLE_CALLBACK_PATH } from "@be/lib/google"

/**
 * Everything a request handler needs: the two datastores, ways to run
 * against them, and the initialized read-model repositories.
 */
export type Dependencies = {
  postgres: Postgres
  mongo: Mongo
  withEventStore: WithEventStore
  withProjectionReader: WithProjectionReader
  withProjectionWriter: WithProjectionWriter
  repositories: Repositories
  sessions: SessionStore
  loginCodes: LoginCodes
  google: GoogleOidc
}

function postgresFromEnv(): Postgres {
  return new Postgres({
    user: env.EVENT_STORE_USER,
    password: env.EVENT_STORE_PASSWORD,
    host: env.EVENT_STORE_HOST,
    port: env.EVENT_STORE_PORT,
    database: env.EVENT_STORE_DATABASE,
    poolSettings: defaultPoolSettings,
  })
}

function mongoFromEnv(): Mongo {
  return new Mongo({
    user: env.MONGODB_PROJECTION_USER,
    password: env.MONGODB_PROJECTION_PASSWORD,
    host: env.MONGODB_PROJECTION_HOST,
    port: env.MONGODB_PROJECTION_PORT,
    database: env.MONGODB_PROJECTION_DATABASE,
    settings: {
      replicaSet: env.MONGODB_PROJECTION_REPLICA_SET,
      authSource: env.MONGODB_PROJECTION_AUTH_DB,
    },
  })
}

/** Create the event-store table, indexes and replication publication if missing. */
function initializeEventStore(postgres: Postgres): Future<Error, void> {
  return postgres.withTransaction(
    { isolation: "Serializable" },
    (e) => e,
    (transaction) =>
      Future.attemptP(() =>
        initializeEventStoreSchema({
          transaction,
          database: env.EVENT_STORE_DATABASE,
          table: env.EVENT_STORE_CREATE_TABLE_WITH_NAME,
          replicationUserName: env.EVENT_STORE_CREATE_REPLICATION_USER_WITH_USERNAME,
          replicationUserPass: env.EVENT_STORE_CREATE_REPLICATION_USER_WITH_PASSWORD,
          replicationPublication: env.EVENT_STORE_CREATE_REPLICATION_PUBLICATION,
        })
      )
  )
}

/** Create the Mongo projection collections and indexes if missing. */
function initializeMongoRepositories(mongo: Mongo): Future<Error, Repositories> {
  return mongo.withTransaction(
    (e) => e,
    (t) => initializeRepositories(t.database).mapRej((err) => new Error(describeProjectionStoreError(err)))
  )
}

/**
 * Build a `Dependencies` from the environment: create both clients, ensure
 * the event-store schema and Mongo collections exist, and hand back one
 * Mongo transaction runner usable as both reader and writer.
 */
export function configureDependencies(): Future<Error, Dependencies> {
  const postgres = postgresFromEnv()
  const mongo = mongoFromEnv()
  // One runner serves both: a function that hands out a writer is assignable to
  // `WithProjectionReader`, because a callback that accepts a reader accepts a writer.
  const onMongo: WithProjectionWriter = (onError, f) =>
    mongo.withTransaction(onError, (t) => f(new MongoProjectionStore(t)))
  return initializeEventStore(postgres)
    .chain(() => initializeSessionTable(postgres))
    .chain(() => initializeLoginCodeTable(postgres))
    .chain(() => initializeMongoRepositories(mongo))
    .map((repositories) => ({
      postgres,
      mongo,
      withEventStore: (onError, f) =>
        evaluate(postgres, env.EVENT_STORE_CREATE_TABLE_WITH_NAME, schemas, f).mapRej(onError),
      withProjectionReader: onMongo,
      withProjectionWriter: onMongo,
      repositories,
      sessions: postgresSessionStore(postgres),
      loginCodes: postgresLoginCodes(postgres, mailerFromEnv(), loginCodeSecretFromEnv()),
      google: googleOidc({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: new URL(GOOGLE_CALLBACK_PATH, env.APP_URL).href,
      }),
    }))
}
