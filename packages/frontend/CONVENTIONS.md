---
description: TypeScript conventions — strings frozen by scout, type-driven modeling, functional primitives, boundary-safe domain design, and numeric presentation in tables.
globs: "*.ts, *.tsx"
alwaysApply: false
---

Favour static types, explicit data flow, immutability, pure functions, composition, exhaustive matching, monadic error handling, strict generics, and branded values over raw primitives; make illegal states unrepresentable and normalize transport/DTO shapes into domain types at boundaries.

## Terminology

### Strings frozen outside the app

The app reads dossiers that the Python `scout` skill writes — markdown under `scout/jobs/` with
YAML frontmatter, fixed section headings, and an ownership marker. Those strings are a contract
with a writer the app does not control. Leave them verbatim and do not "fix" them:

- Frontmatter keys — `FRONTMATTER_KEYS` in `src/module/scout/parse-dossier.ts` (`company`, `title`,
  `url`, `status`, `first_seen`, `last_seen`, `score`, `bucket`, `channel`). Snake case stays snake
  case even though app identifiers are camel case.
- Section headings scout emits — `REQUIRED_SECTIONS` (`## Verdict`, `## Posting facts`) and the
  optional ones the parser reads alongside them.
- The ownership marker `<!-- scout never writes below this line -->` (`OWNERSHIP_MARKER`), which splits
  the file into scout's half and the user's half.
- Line grammars scout writes — `LABELED_PROVENANCE`, `VERDICT_LINE`, `LOG_LINE`. Their separators
  (`·`, `—`) are part of the format.

When new code must name one of those strings, keep the literal exact and keep the surrounding prose
and identifiers in the app's own style:

```ts
// ✗ never — "fixes" the key and stops matching the file
const firstSeen = read("firstSeen")

// ✓ the literal stays exact; the identifier follows app style
const firstSeen = read("first_seen")
```

The same applies to display labels the user has already learned: the dossier column labels in
`src/module/scout/helpers/columns.ts` (`LABELS`) are the one place a label is spelled, and every
other surface reads from there.

## Type Design

- Use a **reusable `Id<Tag>` class** for entity IDs, tagged with a string literal. Don't use `string & { __brand }` intersections — they allow name collisions, leak `__brand` into intellisense, and accept raw strings without constructors. Don't tag with the entity class itself (`Id<Foo>`): two classes with the same shape are structurally identical, so `Id<Foo>` would still assign to `Id<Bar>`. A literal tag is nominal; `declare` keeps the phantom field out of the emitted class; `readonly value` keeps an identity from changing after construction. Declare fields explicitly and assign them in the constructor — `tsconfig.json` sets `erasableSyntaxOnly`, so parameter properties (`constructor(readonly value: string)`) are a compile error here.

  ```ts
  // reusable ID class
  class Id<Tag extends string> {
    declare private readonly _tag: Tag // phantom, never assigned
    readonly value: string
    constructor(value: string) {
      this.value = value
    }
    // ...other useful methods
  }

  // Id<Tag> in use
  class Foo {
    readonly id: Id<"Foo">
    constructor(id: Id<"Foo">) {
      this.id = id
    }
  }
  class Bar {
    readonly id: Id<"Bar">
    constructor(id: Id<"Bar">) {
      this.id = id
    }
  }
  const barId: Id<"Bar"> = new Id<"Foo">("f") // ✗ error: "Foo" is not assignable to "Bar"
  ```

- Use **discriminated unions** to make invalid states unrepresentable. Don't use bags of optional properties when combinations create impossible states.
  ```ts
  type State = { status: "loading" } | { status: "error"; error: Error } | { status: "success"; data: { id: string } }
  ```
- **Group correlated nullable fields into a single nullable object**, so "all present or all absent" is enforced by the type rather than by convention. Two parallel `X | null` fields that must travel together admit nonsense combinations (one set, the other null); one nullable object doesn't. Applies to aggregate fields, event/projection schemas, and DTOs alike.
  ```ts
  // ✗ id without a name (or vice versa) is representable
  invoiceGroupId: string | null; invoiceGroupName: string | null;
  // ✓ both or neither
  invoiceGroup: { id: string; name: string } | null;
  // schema form: s.optionalDefault(null, s.nullable(s.object({ id: s.string, name: s.string })))
  ```
- Use **exhaustive `switch`** with a `never` default on discriminated unions. It forces handling new variants at compile time.

  ```ts
  default: {
    const _exhaustiveCheck: never = config;
    throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  ```

- Don't use **empty objects** (e.g. `ConversationId.empty()`) to represent absence. Use `Maybe<T>` with `Nothing()` instead.
- Use **`as const` tuples** instead of `enum`. Derive the type with `type X = (typeof X)[number]`.
  ```ts
  const PACK_STATUSES = ["Draft", "Approved", "Shipped"] as const
  type PackStatus = (typeof PACK_STATUSES)[number]
  ```
- **Declare return types** on top-level module functions. Exception: JSX components returning JSX.
- **Don't use `any`**. Use strict generics to preserve type information:
  ```ts
  function parse<T>(data: { result: T }): T {
    return data.result
  }
  ```
- **Default the message on custom `Error` subclasses** that have a single canonical message, so call sites don't repeat the string. Keep `message` a parameter (defaulted) so a caller can still override with contextual detail; leave it required only when the message is always dynamic.
  ```ts
  class ActivityBillingNotFoundError extends Error {
    constructor(message = "No billing record for this activity.") {
      super(message)
      this.name = "ActivityBillingNotFoundError"
    }
  }
  throw new ActivityBillingNotFoundError() // uses the canonical message
  ```

## Domain Modeling

- Co-locate a `static schema` factory on the generic `Id<Tag>` class for native serialization/deserialization, then expose a typed `schema` per domain class. Keep the string-literal tag here too — `Id.schema<Message>()` would hand back the structural `Id<Message>` the Type Design section rules out.

  ```ts
  class Id<Tag extends string> {
    declare private readonly _tag: Tag
    readonly value: string
    constructor(value: string) {
      this.value = value
    }
    static schema<Tag extends string>(): s.Schema<Id<Tag>> {
      return s.string.dimap(
        (v) => new Id<Tag>(v),
        (id) => id.value
      )
    }
  }

  class Message {
    static idSchema = Id.schema<"Message">()
    readonly id: Id<"Message">
    constructor(id: Id<"Message">) {
      this.id = id
    }
  }
  ```

- Model rich content (LLM outputs, conversation events) with `s.discriminatedUnion` + `s.variant`. Don't use giant bags of optional properties.
  ```ts
  const AgentExecutionTrace = s.discriminatedUnion([
    s.variant({ type: "text", text: s.string }),
    s.variant({ type: "tool_call", name: s.string, input: s.json, result: s.result(s.string, s.json) }),
    s.variant({ type: "error", message: s.string, code: s.optional(s.string) }),
  ])
  ```
- Bundle related state into **union-driven state machines**. Don't use loose boolean flags (`isStreaming`, `isError`, `isLoading`) spread across stores.

  ```ts
  type Stream<E, R> =
    | { type: "not_started" }
    | { type: "streaming"; results: R[] }
    | { type: "done"; results: R[] }
    | { type: "error"; error: E }

  type VoiceConnection =
    | { type: "disconnected" }
    | { type: "connecting" }
    | { type: "transcribing"; transcription: string }
    | { type: "error"; error: FetchErrorResponse }

  type UserInput = { type: "text"; content: string } | { type: "voice"; connection: VoiceConnection }

  interface ActiveConversation {
    id: ConversationId
    messages: Array<Message>
    inputMode: UserInput
    streamingResponse: Stream<Error, string>
  }
  ```

---

## Maybe — Representing Absence

- Use `Maybe<T>` instead of `null`/`undefined` for return values, entity fields, and persisted shapes. Construct with `Just(value)` or `Nothing()`.

- Pattern match with `instanceof Just` / `instanceof Nothing` + `satisfies never` in default. Don't use `isJust()`/`isNothing()` — they don't narrow types.
  ```ts
  switch (true) {
    case maybeUser instanceof Just:
      console.log(maybeUser.value)
      break
    case maybeUser instanceof Nothing:
      console.log("No user")
      break
    default:
      maybeUser satisfies never
  }
  ```
- Use `.map(fn)` for transforms. Use `.chain(fn)` (flatMap) when `fn` returns `Maybe<T>` — avoids `Maybe<Maybe<T>>`.
- Use `.withDefault(fallback)` or `.maybe(default, fn)` for default values.
- Use `.alt(other)` to chain fallback Maybe values: `primary.alt(secondary).alt(fallback)`.
- Use `fromNullable()` for `null` and `fromOptional()` for `undefined` at system boundaries.
- Use `catMaybes(arr)` to filter out `Nothing` values, `mapMaybe(arr, fn)` to map+filter in one pass.
- Don't use `.expect()` for recoverable absence — it throws. Use `.withDefault()` or `.maybe()`.
- Don't mix `fromNullable` and `fromOptional` — they handle different nullish types.

---

## Result — Typed Error Handling

Use `Result<E, T>` for fallible operations. Return `Failure(error)` instead of throwing. Don't `throw` for recoverable domain failures — a missing record, invalid input, a rejected request — and don't make callers `try/catch` your code. `throw` is reserved for programmer errors that should never happen (the `never` default of an exhaustive `switch`, `Result.unwrap` / `Maybe.expect` on a value the code path already guarantees), and `try/catch` for the boundaries where a browser or platform API throws — `JSON.parse`, File System Access, `fetch` — converted to a `Result` at that boundary.

- Construct with `Success<E, T>(value)` or `Failure<E, T>(error)` — callable without `new`.
- Use `.either(onError, onSuccess)` for exhaustive fold.
  ```ts
  const handle = (result: Result<Error, User>): string =>
    result.either(
      (e) => e.message,
      (user) => user.name
    )
  ```
- Use `.chain(fn)` for monadic sequencing — short-circuits on first `Failure`.
  ```ts
  parseJson(input).chain(validate).chain(transform)
  ```
- Use `.map(fn)` for pure transforms on `Success`, `.mapFailure(fn)` to transform error types.
- Don't wrap `Result`-returning code in `try/catch` — it doesn't throw; fold it with `.either`. `try/catch` belongs only at the platform boundaries named above, where it produces the `Result`. Don't use `.unwrap(toMessage)` outside boundaries — it throws on `Failure`.
- `traverse` works with `List`, `traverse_` works with `Array`. Both short-circuit on first `Failure`.

---

## RemoteData — UI State Machine

Prefer `RemoteData<E, T>` to model async UI state.

- States: `NotAsked()`, `Loading()`, `Failed(error)`, `Ready(value)`.
- Pattern match with `instanceof` + `satisfies never`.
  ```ts
  switch (true) {
    case state instanceof Ready:
      render(state.value)
      break
    case state instanceof Failed:
      showError(state.error)
      break
    case state instanceof Loading:
      showSpinner()
      break
    case state instanceof NotAsked:
      break
    default:
      state satisfies never
  }
  ```
- `.map(fn)` transforms only `Ready`; preserves `Loading`/`Failed`/`NotAsked`.
- `.chain(fn)` for `RemoteData`-returning functions — avoids double wrapping.
- `NotAsked` means "haven't asked yet". For "asked but empty", use `Ready([])`.
- Don't check `isReady` without `instanceof` — boolean flags don't narrow types.

---

## Future — Lazy Async Computation

Prefer `Future<E, T>` over `Promise` for lazy, cancelable async.

- Create with `Future.create<E, T>((reject, resolve) => { ... return cancelFn })`. Return the cancel function.
  ```ts
  const future = Future.create<never, number>((reject, resolve) => {
    const timer = setTimeout(() => resolve(42), 1000)
    return () => clearTimeout(timer)
  })
  ```
- Use `Future.createUncancellable` for inherently uncancellable operations.
- Nothing executes until `.fork(onError, onSuccess)` is called. `fork` returns a cancel function — store it if cancellation is needed.
- Don't use `Future.attemptP` for cancellable operations — it loses cancellation semantics. Use it only for wrapping simple Promises: `Future.attemptP(() => someAsyncFn())`.
- Don't double-wrap Promises: `Future.attemptP(() => fn())`, not `Future.attemptP(async () => { const r = await fn(); return r; })`.
- Use `.chain(fn)` for sequential async composition.
  ```ts
  fetchUser(id)
    .chain((user) => fetchPosts(user.id).map((posts) => ({ user, posts })))
    .fork(handleError, ({ user, posts }) => render(user, posts))
  ```
- Use `Future.parallel(limit, futures)` for bounded concurrency. Use `Future.concurrently({...})` for named concurrent operations.
- Use `.chainRej(fn)` to recover from errors. `.mapRej(fn)` transforms errors but stays rejected.
- Use `Future.bracket(acquire, release, use)` for guaranteed resource cleanup (locks, connections, file descriptors).
- Use `Future.race(a, b)` for timeouts.
- Convert to Promise with `await future.promise(e => new Error(String(e.message)))`.
- `attemptP` always produces `Future<Error, T>` — use `.mapRej()` to narrow the error type.

---

## Collections

### List — Singly Linked List

- Use `List<T>` for O(1) prepend and immutable functional sequences. Import from `@lib/list`:
  ```ts
  import { List } from "@lib/list"
  ```
- Don't append onto linked lists — O(n²). Build with `List.cons(item, list)` + `.reverse()` at the end, or `List.from(arr)`.
- `.head()` returns `Maybe<T>` — always handle `Nothing`.

### TreeMap / TreeSet — Ordered Collections

- Use `TreeMap`/`TreeSet` with explicit comparators for ordered collections. Reach for them instead of JS `Map`/`Set` when you want an ordering other than insertion order.
  ```ts
  const map = TreeMap.new<string, number>((x, y) =>
    x > y ? 1
    : x < y ? -1
    : 0
  )
  // Or use stringMap factory / Comparable interface
  const map = stringMap<User>()
  const map = TreeMap.new_<UserId, User>()
  ```
- **`TreeMap.new()` and `TreeSet.new()` return the mutable variants.** `.set()`, `.remove()`, `.setEntries()`, `.insert()` modify the receiver. Don't share one across state snapshots — an update mutates every snapshot holding it. For persistent, structurally shared values use `ImmutableTreeMap` / `ImmutableTreeSet`: every update returns a new collection and the receiver is untouched.
- `.get(key)` returns `Maybe<T>` — always handle `Nothing`.
- **Set operations never mutate the receiver**, on either variant — they clone and return the merged collection. `TreeMap` has `.unionWith(other, mergeFn)`, `.difference(other)` and `.intersectionWith(other, fn)`; `TreeSet` has `.union(other)`, `.difference(other)` and `.intersection(other)`. `set.union(other)` as a statement discards the result; always assign it.
- Comparator must return `-1 | 0 | 1`. Boolean won't work.
- `TreeMap` is sorted by comparator, not insertion order.
- Use `TreeSet.from(set)` to clone a mutable set before mutating it.
- Use `.has()` for O(log n) membership. Don't use `.values().includes()` — that's O(n).

---

## Parsing & Validation

### Decoders — Validating Incoming Data

- Never cast `JSON.parse(x) as T`. Validate with a decoder returning `Result<string, T>`. Don't call `JSON.parse` yourself either — it throws on malformed text before any decoder runs. `Decoder.stringified(inner)` parses the string and turns a syntax error into a `Failure`.
  ```ts
  const result = Decoder.decode(input, Decoder.stringified(userDecoder)) // Result<string, User>
  ```
- Build object decoders with `Decoder.object({ ... })`.
- Use `Decoder.optional()` for fields that may not exist (`V | undefined`).
- Use `Decoder.nullable()` for fields where value may be `null` (`V | null`).
- Use `Decoder.optionalNullable()` for fields that may be absent OR null.
- Use `Decoder.optionalMaybe()` for missing → `Maybe<V>`.
- Use `Decoder.oneOf()` + `Decoder.stringLiteral()` for discriminated JSON unions.
- Always derive types from decoders: `type User = Decoder.Infer<typeof userDecoder>`. Don't cast with `as` after decode.
- Use `.chain()` for version-dependent decoding.
- Use `Decoder.objectMap()` for `{ [key: string]: T }` shapes. Don't use `Decoder.object()` for dynamic keys.

### Encoders — Formatting Output Data

- Use `E.object<T>({...})` for structured serialization.
- Use `E.optional(encoder)` to omit fields when `undefined`.
- Transform inputs with `.rmap(fn)` (contravariant — transforms input before encoding).
  ```ts
  const dateEncoder = E.string.rmap((d: Date) => d.toISOString())
  const userIdEncoder = E.string.rmap((id: UserId) => id.value)
  ```
- Use `E.oneOf<T>(selector)` for dynamic encoder selection.
- Use `E.both(enc1, enc2)` to merge encoder outputs.
- Must call `.run(value)` to execute — `Encoder<A>` is a description, not a result.
- Don't use `E.maybe()` for optional fields — it produces `{ just: V }` structure. Use `E.optional()`.
- `E.EncoderOptional` only works within `E.object()` field definitions.

### Schemas — Bidirectional Mapping

- A `Schema` is a combined `Decoder` + `Encoder`. Build with `s.string.dimap(decode, encode)`.
- Keep schemas as `static schema` on domain classes (and on the generic `Id<Tag>`) — co-location keeps the schema and the type it describes in sync as the class evolves. The `Id` factory is shown under Domain Modeling; a domain class composes it:

  ```ts
  class Message {
    static schema: s.Schema<Message> = s.object({ id: Id.schema<"Message">(), text: s.string }).dimap(
      ({ id, text }) => new Message(id, text),
      (m) => ({ id: m.id, text: m.text })
    )
    readonly id: Id<"Message">
    readonly text: string
    constructor(id: Id<"Message">, text: string) {
      this.id = id
      this.text = text
    }
  }
  ```

- Use `s.discriminatedUnion` + `s.variant` for sum types.
  ```ts
  const Message = s.discriminatedUnion([
    s.variant({ type: "error", code: s.number, message: s.string }),
    s.variant({ type: "success", value: s.string }),
  ])
  type Message = s.Infer<typeof Message>
  ```
- Use `s.optional()` for missing keys. Use `s.nullable()` for present-but-null values. Don't combine into `s.optional(s.maybe(x))` — that's `SchemaOptional<Maybe<T> | undefined>`, so a missing key still surfaces as `undefined` next to `Nothing`. Use `s.optionalMaybe(x)` when a missing key should decode straight to `Maybe<T>`.

---

## Numeric Data in Tables

Numbers in a table are read by scanning down a column and comparing them. Ragged decimals and left edges defeat that: a column where `8` sits above `12.5` above `4` forces the reader to align the digits themselves, and two columns that round differently are read as a discrepancy rather than as a formatting choice. Format and align every figure the same way so the column does that work.

- **Format every count the same way.** Counts render with `toLocaleString()` and nothing else — no `toFixed`, no template literals, no local `Intl.NumberFormat`. A second formatter is a second rounding rule. The dossier score is an integer from scout and renders as-is (`{score.value}`); don't add decimals it never had.

- **Right-align numeric quantities** with `align: "right"` on the `ColumnDef` (`src/components/ui/datatable.tsx`), and pair it with `tabular-nums` on the cell so digits sit in fixed-width columns. No dossier column is a plain figure today — the score renders as a badge, so it falls under the exemption below — and the live example is the factor-points cell in `src/module/scout/components/dossier.tsx` (`text-right tabular-nums`). A new figure column takes this shape:

  ```tsx
  // illustrative — `applications` is not a column yet
  applications: new ColumnDef({ label: LABELS.applications, sortFun: byApplications, align: "right" }),
  // contents:
  applications: <span className="tabular-nums">{dossier.applications.toLocaleString()}</span>,
  ```

- **Identifiers that happen to be digits stay left-aligned** — posting ids, ZIPs, phone numbers. They are labels, not measures; nobody sums them, and right-aligning them makes a column of unrelated strings look like a total. Right-align only what could sensibly be added up: scores, counts, sizes, durations.

- **Sort on the underlying value, never the formatted string.** `sortFun` reads the typed row value (`byScore` compares `score.value`, not the rendered text), so `"10"` doesn't sort before `"9"`.

- **Distinguish "no value" from a real zero.** A factor scout scored `unknown` renders as `no signal` (the factor-points cell in `src/module/scout/components/dossier.tsx`), and an absent figure elsewhere renders as an em dash (`—`) through `factText` in `src/module/scout/types.ts`, never `0` — a posting with no salary reads differently from one that pays nothing.

- **Drop unit suffixes that the header already carries.** A count column titled "Applications" renders `12`, not `12 applications` — and a suffix whose length varies with the value (`1 application` / `12 applications`) puts the digits back out of line, defeating the alignment it sits in.

- **Composite and interactive cells are exempt.** A cell that is really a control (a status dropdown) or a stack (a score badge beside a band label) has no single right edge to align on; forcing one drags icons, badges and prose to the wrong side. Keep the figure itself `tabular-nums`, but leave the column's default alignment. The rule is for columns of plain figures.
