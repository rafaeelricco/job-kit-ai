export { List }

import { type Maybe, Just, Nothing } from "@lib/maybe"

type Content<T> = { head: T; tail: List<T> } | { empty: null }

/**
 * An immutable singly-linked list with cheap prepending (`cons`) and
 * iteration. Each node holds a `head` and a reference to the next list.
 *
 * ```ts
 * const xs = List.from([1, 2, 3]);
 * List.cons(0, xs).toArray(); // [0, 1, 2, 3]
 * ```
 */
class List<T> {
  readonly value: Content<T>

  static empty<T>(): List<T> {
    return new List({ empty: null })
  }

  static cons<T>(head: T, tail: List<T>): List<T> {
    return new List({ head, tail })
  }

  static singleton<T>(v: T): List<T> {
    return List.cons(v, List.empty())
  }

  static concat<T>(x: List<T>, y: List<T>): List<T> {
    let r = y
    for (const el of x.reverse()) {
      r = List.cons(el, r)
    }
    return r
  }

  static from<T>(array: Array<T>): List<T> {
    let result: List<T> = List.empty()
    for (let i = array.length - 1; i >= 0; i--) {
      result = List.cons(array[i] as T, result)
    }
    return result
  }
  private constructor(v: Content<T>) {
    this.value = v
  }

  isEmpty(): boolean {
    switch (true) {
      case "empty" in this.value:
        return true
      case "head" in this.value:
        return false
      default:
        return this.value satisfies never
    }
  }

  head(): Maybe<T> {
    switch (true) {
      case "empty" in this.value:
        return Nothing()
      case "head" in this.value:
        return Just(this.value.head)
      default:
        return this.value satisfies never
    }
  }

  tail(): List<T> {
    switch (true) {
      case "empty" in this.value:
        return List.empty()
      case "head" in this.value:
        return this.value.tail
      default:
        return this.value satisfies never
    }
  }

  length(): number {
    let len = 0
    for (const _ of this) {
      len++
    }
    return len
  }

  map<W>(f: (v: T) => W): List<W> {
    let r: List<W> = List.empty()
    for (const item of this.reverse()) {
      r = List.cons(f(item), r)
    }
    return r
  }

  reduce<U>(init: U, f: (acc: U, elem: T) => U): U {
    let acc = init
    for (const item of this) {
      acc = f(acc, item)
    }
    return acc
  }

  find(predicate: (elem: T) => boolean): Maybe<T> {
    for (const item of this) {
      if (predicate(item)) return Just(item)
    }
    return Nothing()
  }

  contains(elem: T): boolean {
    return this.find((x) => x === elem).isJust()
  }

  filter(predicate: (v: T) => boolean): List<T> {
    let result: List<T> = List.empty()
    for (const item of this.reverse()) {
      if (predicate(item)) {
        result = List.cons(item, result)
      }
    }
    return result
  }

  reverse(): List<T> {
    let r: List<T> = List.empty()
    for (const item of this) {
      r = List.cons(item, r)
    }
    return r
  }

  append(item: T): List<T> {
    return List.concat(this, List.singleton(item))
  }

  toArray(): Array<T> {
    const result: Array<T> = []
    for (const item of this) {
      result.push(item)
    }
    return result
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let node = this.value; "head" in node; node = node.tail.value) {
      yield node.head
    }
  }
}
