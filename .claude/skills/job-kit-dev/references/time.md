# Time types: POSIX and Duration

Cross-cutting value-type rules for server and web. Import from `@lib/time`
(`packages/lib/time.ts`, shared by both). Use this leaf when a field, constant, variable, or schema
is an instant or a length of time.

## Prefer typed storage

Store a **timestamp** as `POSIX`, not a plain `number`. Store a **duration** as
`Duration`, not a plain `number`. Convert to milliseconds only at the boundary
that needs raw ms (`posix.value` / `duration.asMilliseconds()`). If you cannot,
comment at the storage site (`// plain ms: <reason>`).

```ts
import { POSIX, Duration } from "@lib/time"

const now = POSIX.now()
const later = now.addDuration(Duration.hours(1))
const epochMs = later.value // only at a boundary that needs raw ms

const offset = Duration.minutes(30)
const ms = offset.asMilliseconds() // only at a boundary that needs raw ms
```

Do not invent methods.

- `POSIX` holds epoch milliseconds as `readonly value: number`. There is no
  `POSIX#asMilliseconds()`.
- `Duration` is constructed via factories (`Duration.hours(1)`,
  `Duration.minutes(30)`, …) and converts with `asMilliseconds()` /
  `asSeconds()` / etc.
- Schemas: `POSIX.schema`, `Duration.schema` (ISO-8601 string wire form for
  Duration).

## Where this applies

| Layer                      | Prefer                                      | Convert at boundary                                             |
| -------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Event / aggregate fields   | `POSIX` / `Duration` in args + state        | wire already uses schemas                                       |
| `.api.ts` request/response | `POSIX.schema` / `Duration.schema`          | clients get typed values                                        |
| Projection documents       | same schemas / typed fields                 | same                                                            |
| Domain / UI helpers        | keep `POSIX` / `Duration` in memory         | e.g. a `Date` or `setTimeout` → `.value` or `.asMilliseconds()` |
| Form submit mappers        | build `POSIX` from `DateOnly` / `TimeOfDay` | see front-end `forms.md`                                        |

## Documented exceptions

Plain `number` (epoch ms or duration ms) is allowed only when:

1. A third-party or platform API requires raw ms/`Date` and the typed value is
   converted **at the call site**, not stored earlier as `number`; or
2. A legacy field cannot change yet — comment why (`// plain ms: <reason>`).

Animation/CSS ms, UI poll intervals, and non-domain timers are out of scope
unless they represent domain time.

```ts
// Bad: store epoch ms as number through the domain
const createdAt: number = Date.now()
const expiresInMs = 3_600_000

// Good: store typed; convert at the edge
const createdAt = POSIX.now()
const ttl = Duration.hours(1)
notifications.schedule({ date: new Date(createdAt.addDuration(ttl).value) })
```

Owner elsewhere: backend value-schema checklist → `back-end/conventions.md`;
form date → `POSIX` at submit → `front-end/forms.md`.
