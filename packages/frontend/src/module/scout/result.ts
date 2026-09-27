export { assertNever, err, isErr, isOk, ok, partition, type Result }

type Result<T, E> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "err"; readonly error: E }

const ok = <T>(value: T): Result<T, never> => ({ kind: "ok", value })
const err = <E>(error: E): Result<never, E> => ({ kind: "err", error })

const isOk = <T, E>(result: Result<T, E>): result is { kind: "ok"; value: T } => result.kind === "ok"

// A negated `isOk` does not narrow, so the err side needs its own predicate.
const isErr = <T, E>(result: Result<T, E>): result is { kind: "err"; error: E } => result.kind === "err"

function partition<T, E>(
  results: readonly Result<T, E>[]
): { readonly values: readonly T[]; readonly errors: readonly E[] } {
  return {
    values: results.filter(isOk).map((result) => result.value),
    errors: results.filter(isErr).map((result) => result.error),
  }
}

// Compile-time exhaustiveness. Reaching it at runtime means a union grew.
function assertNever(value: never): never {
  throw new Error(`Unreachable: ${JSON.stringify(value)}`)
}
