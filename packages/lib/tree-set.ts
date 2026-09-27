export { TreeSet, ImmutableTreeSet }

import { TreeMap, ImmutableTreeMap, TreeMapCore } from "@lib/tree-map"

interface Comparable<T> {
  compare(other: T): number
}

/**
 * Shared base for {@link TreeSet} and {@link ImmutableTreeSet}.
 *
 * Holds a {@link TreeMapCore} keyed on the set's elements (with `null`
 * values), all read methods, and every set-algebra method. Subclasses
 * supply their mutation methods and a `wrap` factory that lifts a fresh
 * underlying map back into their own kind.
 */
abstract class TreeSetCore<K> {
  // @ts-expect-error Unused field to prevent instantiation by casting.
  private readonly _: null = null
  protected tree: TreeMapCore<K, null>

  protected constructor(tree: TreeMapCore<K, null>) {
    this.tree = tree
  }

  /** Construct a new instance of the same subclass around a fresh map. */
  protected abstract wrap(tree: TreeMapCore<K, null>): TreeSetCore<K>

  has(k: K): boolean {
    return this.tree.has(k)
  }

  values(): Array<K> {
    return Array.from(this.tree.keys())
  }

  size(): number {
    return this.tree.size()
  }

  union(other: TreeSetCore<K>): this {
    return this.wrap(this.tree.unionWith(other.tree, (l, _) => l)) as this
  }

  difference(other: TreeSetCore<K>): this {
    return this.wrap(this.tree.difference(other.tree)) as this
  }

  intersection(other: TreeSetCore<K>): this {
    return this.wrap(this.tree.intersectionWith(other.tree, (v, _) => v) as TreeMapCore<K, null>) as this
  }
}

/**
 * A mutable Set type that requires a comparison function.
 *
 * This is a wrapper around {@link TreeMap} keyed on the elements.
 *
 * ```ts
 * const s = TreeSet.new<string>((a, b) => a.localeCompare(b));
 * s.insert("a");
 * s.has("a"); // true
 * ```
 */
class TreeSet<K> extends TreeSetCore<K> {
  declare protected tree: TreeMap<K, null>

  static new<K>(compare: (l: K, r: K) => number): TreeSet<K> {
    return new TreeSet(TreeMap.new<K, null>(compare))
  }

  static new_<K extends Comparable<K>>(): TreeSet<K> {
    const compare = (x: K, y: K) => x.compare(y)
    return new TreeSet(TreeMap.new<K, null>(compare))
  }

  /** Return a clone of the set. */
  static from<K>(set: TreeSet<K>): TreeSet<K> {
    return new TreeSet(set.tree.clone())
  }

  static from_<K extends Comparable<K>>(xs: Array<K>): TreeSet<K> {
    return TreeSet.new_<K>().insertValues(xs)
  }

  private constructor(tree: TreeMap<K, null>) {
    super(tree)
  }

  protected wrap(tree: TreeMapCore<K, null>): TreeSet<K> {
    return new TreeSet(tree as TreeMap<K, null>)
  }

  insert(k: K): this {
    this.tree.set(k, null)
    return this
  }

  remove(k: K): this {
    this.tree.remove(k)
    return this
  }

  insertValues(it: Array<K>): this {
    for (const k of it) this.tree.set(k, null)
    return this
  }
}

/**
 * An immutable Set type that requires a comparison function.
 *
 * Every update returns a new ImmutableTreeSet; the receiver is untouched.
 * Each update clones the underlying BTree before mutating the copy.
 *
 * ```ts
 * const s0 = ImmutableTreeSet.new<string>((a, b) => a.localeCompare(b));
 * const s1 = s0.insert("a");
 * s0.has("a"); // false
 * s1.has("a"); // true
 * ```
 */
class ImmutableTreeSet<K> extends TreeSetCore<K> {
  declare protected tree: ImmutableTreeMap<K, null>

  static new<K>(compare: (l: K, r: K) => number): ImmutableTreeSet<K> {
    return new ImmutableTreeSet(ImmutableTreeMap.new<K, null>(compare))
  }

  static new_<K extends Comparable<K>>(): ImmutableTreeSet<K> {
    const compare = (x: K, y: K) => x.compare(y)
    return new ImmutableTreeSet(ImmutableTreeMap.new<K, null>(compare))
  }

  static from<K>(compare: (l: K, r: K) => number, xs: Array<K>): ImmutableTreeSet<K> {
    return new ImmutableTreeSet(
      ImmutableTreeMap.from(
        compare,
        xs.map((k) => [k, null])
      )
    )
  }

  static from_<K extends Comparable<K>>(xs: Array<K>): ImmutableTreeSet<K> {
    const compare = (x: K, y: K) => x.compare(y)
    return new ImmutableTreeSet(
      ImmutableTreeMap.from(
        compare,
        xs.map((k) => [k, null])
      )
    )
  }

  private constructor(tree: ImmutableTreeMap<K, null>) {
    super(tree)
  }

  protected wrap(tree: TreeMapCore<K, null>): ImmutableTreeSet<K> {
    return new ImmutableTreeSet(tree as ImmutableTreeMap<K, null>)
  }

  insert(k: K): ImmutableTreeSet<K> {
    return new ImmutableTreeSet(this.tree.set(k, null))
  }

  remove(k: K): ImmutableTreeSet<K> {
    return new ImmutableTreeSet(this.tree.remove(k))
  }

  insertValues(xs: Array<K>): ImmutableTreeSet<K> {
    return new ImmutableTreeSet(this.tree.setEntries(xs.map((k) => [k, null] as [K, null])[Symbol.iterator]()))
  }
}
