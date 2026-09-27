export { type UnionPick }

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never

type UnionToOvlds<U> = UnionToIntersection<U extends unknown ? (f: U) => void : never>

type PopUnion<U> = UnionToOvlds<U> extends (a: infer A) => void ? A : never

type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true

/**
 * Convert a union to a tuple of its members.
 *
 * ```ts
 * type T = UnionToTuple<"a" | "b">
 * // ["a", "b"] or ["b", "a"] — order is PopUnion peel, not source spelling
 * ```
 */
type UnionToTuple<T, A extends unknown[] = []> =
  IsUnion<T> extends true ? UnionToTuple<Exclude<T, PopUnion<T>>, [PopUnion<T>, ...A]> : [T, ...A]

/**
 * Pick an option from a union.
 *
 * ```ts
 * type First = UnionPick<"a" | "b" | "c", 0>
 * // one member of the union — index follows UnionToTuple order
 * ```
 */
type UnionPick<T, N extends keyof UnionToTuple<T>> = UnionToTuple<T>[N]
