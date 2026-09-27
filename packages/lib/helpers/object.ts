export { filterKeys, filterMap, mapValues, isRecord }

/** Narrow an unknown value to a plain string-keyed record (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function filterKeys<O extends object, K extends keyof O>(
  obj: O,
  pred: <KK extends K>(key: KK, value: O[KK]) => boolean
): Partial<O> {
  const result: Partial<O> = {}
  const keys = Object.keys(obj) as K[]
  for (const key of keys) {
    if (pred(key, obj[key])) {
      result[key] = obj[key]
    }
  }
  return result
}

/** Filter keys and transform values at the same time. */
function filterMap<O extends object, R>(
  obj: O,
  fn: <K extends keyof O>(key: K, value: O[K]) => R | undefined
): Partial<{ [K in keyof O]: R }> {
  const result = {} as Partial<{ [K in keyof O]: R }>
  const keys = Object.keys(obj) as Array<keyof O>
  for (const key of keys) {
    const mapped = fn(key, obj[key])
    if (mapped !== undefined) {
      result[key] = mapped
    }
  }
  return result
}

function mapValues<T extends object, R>(
  obj: T,
  fn: <K extends keyof T>(key: K, value: T[K]) => R
): { [K in keyof T]: R } {
  const out = {} as { [K in keyof T]: R }
  const keys = Object.keys(obj) as Array<keyof T>
  for (const k of keys) {
    out[k] = fn(k, obj[k])
  }
  return out
}
