export {
  type Repository, // export only type here to prevent instantiation outside of module.
  MongoProjectionStore,
  createRepository,
  type ProjectionReader,
  type ProjectionWriter,
  Collection as Collection,
  type JsonDoc,
  type RepositoryArgs,
  type WithProjectionReader,
  type WithProjectionWriter,
  type ProjectionStoreError,
  describeProjectionStoreError,
}

import { Collection, Db } from "mongodb"
import { type JsonObject } from "@lib/json/types"
import * as JsonSchema from "@lib/json/schema"
import { Future } from "@lib/future"
import { type Maybe, fromOptional } from "@lib/maybe"
import { MongoTransaction } from "@be/lib/mongo"
import { type Filter, type FindOptions, type Document, type InsertOneOptions } from "mongodb"

type Schema<T> = JsonSchema.Schema<T>
type JsonDoc = JsonObject & { _id: string }

type RepositoryArgs<T> = {
  collectionName: string
  createIndexes: (collection: Collection<JsonDoc>) => Promise<void>
  schema: Schema<T>
  toId: (v: T) => string
}

/**
 * Represents an initialized collection. You can only get an
 * instance of this class if the collection has been initialized.
 */
class Repository<T> {
  readonly values: RepositoryArgs<T>
  constructor(values: RepositoryArgs<T>) {
    this.values = values
  }
}

type IdAndDoc<T> = { _id: string; document: T }

/** Wrap a document schema so its `_id` round-trips alongside it when encoding/decoding. */
const schemaIdAndValue = <T>(schema: Schema<T>): Schema<IdAndDoc<T>> => {
  const idSchema = JsonSchema.object({ _id: JsonSchema.string }).dimap(
    ({ _id }) => _id,
    (_id) => ({ _id })
  )

  return JsonSchema.both(idSchema, schema).dimap(
    ([_id, document]) => ({ _id, document }),
    ({ _id, document }) => [_id, document]
  )
}

/**
 * What a query may do with the read model. There is no write method to call,
 * so "a query that writes" is a compile error rather than a runtime rejection.
 */
type ProjectionReader = Pick<MongoProjectionStore, "find" | "findOne" | "count" | "aggregate">

/** What a projection may do: everything a reader can, plus `insert` and `upsert`. */
type ProjectionWriter = ProjectionReader & Pick<MongoProjectionStore, "insert" | "upsert">

/**
 * Run `f` with read access inside one Mongo transaction.
 *
 * ```ts
 * withProjectionReader(hideStoreError, (store) => RepoNotes.reader(repo, store).findActive())
 * ```
 */
type WithProjectionReader = <E, T>(onError: (e: Error) => E, f: (s: ProjectionReader) => Future<E, T>) => Future<E, T>

/** Same, with write access. Only the projection endpoint gets one of these. */
type WithProjectionWriter = <E, T>(onError: (e: Error) => E, f: (s: ProjectionWriter) => Future<E, T>) => Future<E, T>

/**
 * Failure modes surfaced by `MongoProjectionStore`. Driver failures keep the
 * underlying `Error` for logging; decode failures name the collection they
 * came from so callers can report which projection is corrupt.
 */
type ProjectionStoreError = { type: "driver"; error: Error } | { type: "decode"; collection: string; reason: string }

function driverError(error: Error): ProjectionStoreError {
  return { type: "driver", error }
}

function describeProjectionStoreError(e: ProjectionStoreError): string {
  switch (e.type) {
    case "driver":
      return e.error.message
    case "decode":
      return `Unable to decode '${e.collection}': ${e.reason}`
    default: {
      const _exhaustiveCheck: never = e
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/**
 * Create a collection and its indexes if missing, and hand back the
 * `Repository` token that proves it exists. Startup-only: it is not a
 * store method because it is neither a read nor a transactional write.
 */
function createRepository<T>(db: Db, args: RepositoryArgs<T>): Future<ProjectionStoreError, Repository<T>> {
  console.log(`Initializing '${args.collectionName}'`)

  const ensureCollectionExists = (): Future<ProjectionStoreError, void> =>
    Future.attemptP(() => db.listCollections().toArray())
      .mapRej(driverError)
      .chain((collections) => {
        if (collections.some((c) => c.name === args.collectionName)) {
          console.log(`Collection '${args.collectionName}' already exists`)
          return Future.resolve<ProjectionStoreError, void>(undefined)
        }
        return Future.attemptP(() => db.createCollection(args.collectionName))
          .mapRej(driverError)
          .map(() => undefined)
      })

  const createIndexes = (): Future<ProjectionStoreError, void> => {
    const collection = db.collection<JsonDoc>(args.collectionName)
    return Future.attemptP(() => args.createIndexes(collection)).mapRej(driverError)
  }

  return ensureCollectionExists()
    .chain(createIndexes)
    .map(() => {
      console.log(`Indexes for '${args.collectionName}' created`)
      return new Repository(args)
    })
}

class MongoProjectionStore {
  private transaction: MongoTransaction
  constructor(transaction: MongoTransaction) {
    this.transaction = transaction
  }

  private decodeRows<T>(schema: Schema<T>, found: JsonDoc[], collection: string): Future<ProjectionStoreError, T[]> {
    const result = JsonSchema.decode(JsonSchema.array(schema), found)
    return result.either(
      (reason): Future<ProjectionStoreError, T[]> => Future.reject({ type: "decode", collection, reason }),
      (value) => Future.resolve(value)
    )
  }

  find<T>(
    repository: Repository<T>,
    filter: Filter<JsonDoc>,
    options?: FindOptions
  ): Future<ProjectionStoreError, T[]> {
    return Future.attemptP(() => this.transaction.find(repository.values.collectionName, filter, options))
      .mapRej(driverError)
      .chain((found) => this.decodeRows(repository.values.schema, found as JsonDoc[], repository.values.collectionName))
  }

  findOne<T>(repository: Repository<T>, filter: Filter<JsonDoc>): Future<ProjectionStoreError, Maybe<T>> {
    return this.find(repository, filter).map((results) => fromOptional(results[0]))
  }

  private encode<T>(repository: Repository<T>, document: T): { _id: string; doc: JsonDoc } {
    const _id = repository.values.toId(document)
    return { _id, doc: JsonSchema.encode(schemaIdAndValue(repository.values.schema), { _id, document }) as JsonDoc }
  }

  /** Insert one document. Rejects on an `_id` clash. */
  insert<T>(repository: Repository<T>, document: T, options?: InsertOneOptions): Future<ProjectionStoreError, void> {
    return Future.attemptP(() =>
      this.transaction.insertOne(repository.values.collectionName, this.encode(repository, document).doc, options)
    ).mapRej(driverError)
  }

  /** Upsert one value. Overwrites on `_id` clashes. */
  upsert<T>(
    repository: Repository<T>,
    document: T,
    options: InsertOneOptions = {}
  ): Future<ProjectionStoreError, void> {
    const { _id, doc } = this.encode(repository, document)
    return Future.attemptP(() =>
      this.transaction.replaceOne(
        repository.values.collectionName,
        { _id },
        doc,
        Object.assign({ upsert: true }, options)
      )
    )
      .mapRej(driverError)
      .map(() => undefined)
  }

  count<T>(repository: Repository<T>, filter: Filter<JsonDoc>): Future<ProjectionStoreError, number> {
    return Future.attemptP(() => this.transaction.countDocuments(repository.values.collectionName, filter)).mapRej(
      driverError
    )
  }

  aggregate<T extends Document, R extends Document>(
    repository: Repository<T>,
    pipeline: Document[],
    resultSchema: JsonSchema.Schema<R>
  ): Future<ProjectionStoreError, R[]> {
    return Future.attemptP(() => this.transaction.aggregate<T>(repository.values.collectionName, pipeline))
      .mapRej(driverError)
      .chain((results) => this.decodeRows(resultSchema, results as JsonDoc[], repository.values.collectionName))
  }
}
