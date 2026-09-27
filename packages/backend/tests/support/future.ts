import { Future } from "@lib/future"
import { type Response } from "@be/lib/router"

export async function result<T>(future: Future<Response, T>): Promise<T> {
  return future.promise((error) => new Error(JSON.stringify(error)))
}

export async function rejection<E, T>(future: Future<E, T>): Promise<E> {
  return new Promise((resolve, reject) => {
    future.fork(resolve, () => reject(new Error("Expected rejection")))
  })
}
