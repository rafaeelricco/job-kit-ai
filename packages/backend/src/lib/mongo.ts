export { Mongo, MongoTransaction }

import {
  ClientSession,
  type Filter,
  type FindOptions,
  type Document,
  type ReplaceOptions,
  type InsertOneOptions,
  type CountOptions,
  Db,
  ReadConcern,
  WriteConcern,
  ReadPreference,
  type TransactionOptions,
  type OptionalUnlessRequiredId,
  type WithId,
  type MongoClientOptions,
  MongoClient,
  type AggregateOptions,
} from "mongodb"
import { Future } from "@lib/future"

/** One MongoDB session/transaction. Every read/write method throws once `closed` (after commit or abort). */
class MongoTransaction {
  private closedState: boolean = false
  readonly session: ClientSession
  readonly database: Db

  constructor(session: ClientSession, database: Db) {
    this.session = session
    this.database = database
  }

  get closed(): boolean {
    return this.closedState
  }

  async commit() {
    if (this.closed) {
      throw new Error("Committing a closed transaction")
    }

    try {
      await this.session.commitTransaction()
      this.closedState = true
    } catch (error) {
      this.closedState = true
      throw new Error(`Failed to commit transaction: ${error}`)
    }
  }

  /** Roll back the transaction. Logs (rather than throws) if the underlying abort call fails, so cleanup still completes. */
  async abort() {
    if (this.closed) {
      throw new Error("Aborting a closed transaction")
    }

    try {
      await this.session.abortTransaction()
    } catch (error) {
      console.error("Failed to abort MongoDB transaction", error instanceof Error ? error : new Error(String(error)))
    }
    this.closedState = true
  }

  async find<T extends Document>(
    collectionName: string,
    filter: Filter<T>,
    options?: FindOptions
  ): Promise<WithId<T>[]> {
    this.checkOpen()
    return this.database
      .collection<T>(collectionName)
      .find(filter, { ...options, session: this.session })
      .toArray()
  }

  async replaceOne<T extends Document>(
    collectionName: string,
    filter: Filter<T>,
    replacement: T,
    options?: ReplaceOptions
  ): Promise<Document> {
    this.checkOpen()
    return this.database.collection<T>(collectionName).replaceOne(filter, replacement, {
      ...options,
      session: this.session,
    })
  }

  async insertOne<T extends Document>(
    collectionName: string,
    document: T & OptionalUnlessRequiredId<T>,
    options?: InsertOneOptions
  ): Promise<void> {
    this.checkOpen()
    await this.database.collection<T>(collectionName).insertOne(document, { ...options, session: this.session })
  }

  async countDocuments<T extends Document>(
    collectionName: string,
    filter: Filter<T>,
    options?: CountOptions
  ): Promise<number> {
    this.checkOpen()
    return this.database.collection<T>(collectionName).countDocuments(filter, { ...options, session: this.session })
  }

  async aggregate<T extends Document>(
    collectionName: string,
    pipeline: Document[],
    options?: AggregateOptions
  ): Promise<Document[]> {
    this.checkOpen()
    return this.database
      .collection<T>(collectionName)
      .aggregate(pipeline, { ...options, session: this.session })
      .toArray()
  }

  private checkOpen() {
    if (this.closed) {
      throw new Error("Session must be active to read or write to MongoDB!")
    }
  }
}

const transactionOptions: TransactionOptions = {
  readConcern: new ReadConcern("snapshot"),
  writeConcern: new WriteConcern("majority"),
  readPreference: ReadPreference.primary,
}

type MongoConfig = {
  user: string
  password: string
  host: string
  port: number
  database: string
  settings: MongoClientOptions
}

class Mongo {
  client: MongoClient
  values: MongoConfig

  constructor(values: MongoConfig) {
    this.values = values
    const connectionString =
      `mongodb://${encodeURIComponent(values.user)}:${encodeURIComponent(values.password)}@${values.host}` +
      `:${values.port.toString()}/${values.database}` +
      "?serverSelectionTimeoutMS=10000&connectTimeoutMS=10000&authSource=admin"
    this.client = new MongoClient(connectionString, values.settings)
  }

  async disconnect(): Promise<void> {
    await this.client.close()
  }

  /** Promise-based `withTransaction`: same guarantees, thrown/rejected errors surface as a rejected promise. */
  async withTransactionP<T>(f: (t: MongoTransaction) => Promise<T>): Promise<T> {
    return this.withTransaction(
      (err) => err,
      (t) => Future.attemptP(() => f(t))
    ).promise((err) => err)
  }

  /**
   * Execute an action with a transaction that will be automatically
   * committed at the end. `f` receives the transaction; commit/abort and
   * session cleanup are handled for you based on whether it resolves or
   * rejects.
   *
   * ```ts
   * mongo.withTransaction(onError, (t) => ...)
   * ```
   */
  withTransaction<E, T>(onError: (e: Error) => E, f: (t: MongoTransaction) => Future<E, T>): Future<E, T> {
    const session = this.client.startSession()
    session.startTransaction(transactionOptions)
    const database = this.client.db(this.values.database)
    const transaction = new MongoTransaction(session, database)

    return f(transaction)
      .bichain<E, T>(
        (err) =>
          transaction.closed
            ? Future.reject(err)
            : Future.attemptP(() => transaction.abort())
                .mapRej(onError)
                .chain((_) => Future.reject(err)),
        (res) =>
          transaction.closed
            ? Future.resolve(res)
            : Future.attemptP(() => transaction.commit())
                .mapRej(onError)
                .map(() => res)
      )
      .finally(Future.attemptP(() => session.endSession()).mapRej(onError))
  }
}
