export { type Timezone, DateOnly, TimeOfDay, POSIX, Duration }

import * as s from "@lib/json/schema"

import { fail, always } from "@lib/json/decoder"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { DateTime } from "luxon"

type Timezone = string

/**
 * Date + time stored as milliseconds passed since 00:00:00 UTC on January 1, 1970.
 *
 * ```ts
 * const t = POSIX.fromSQLTimestamp("2026-03-17 10:30:00+00");
 * t?.toSQLTimestamp(); // "2026-03-17 10:30:00.000+00"
 * ```
 */
class POSIX {
  static fromDate(d: Date): POSIX {
    return new POSIX(d.valueOf())
  }

  static fromDuration(d: Duration): POSIX {
    return new POSIX(d.asMilliseconds())
  }

  static now(): POSIX {
    return new POSIX(Date.now())
  }

  /** Takes number of milliseconds since epoch. */
  public readonly value: number
  constructor(value: number) {
    this.value = value
  }

  /** Time since Unix epoch (00:00:00 UTC on January 1, 1970). */
  sinceEpoch(): Duration {
    return Duration.milliseconds(this.value)
  }

  toDate(): Date {
    return new Date(this.value)
  }

  isAfter(other: POSIX) {
    return this.value > other.value
  }

  greaterThan(other: POSIX) {
    return this.value > other.value
  }

  compare(other: POSIX): number {
    return (
      this.value > other.value ? 1
      : this.value < other.value ? -1
      : 0
    )
  }

  addDuration(d: Duration) {
    return new POSIX(this.value + d.asMilliseconds())
  }

  subtractDuration(d: Duration) {
    return new POSIX(this.value - d.asMilliseconds())
  }

  difference(other: POSIX): Duration {
    return Duration.milliseconds(this.value - other.value)
  }

  /** `Nothing` when the zone is unknown or the civil date/time does not exist. */
  static fromLocalDateAndTime(date: DateOnly, time: TimeOfDay, timezone: Timezone): Maybe<POSIX> {
    const s = `${date.pretty()}T${time.pretty()}`
    const luxonDate = DateTime.fromISO(s, { zone: timezone })
    // Luxon shifts a time inside a DST gap forward and stays valid, so compare
    // the civil components against the same string parsed in gap-free UTC.
    const civil = "yyyy-MM-dd HH:mm:ss.SSS"
    const requested = DateTime.fromISO(s, { zone: "UTC" })
    return luxonDate.isValid && luxonDate.toFormat(civil) === requested.toFormat(civil) ?
        Just(new POSIX(luxonDate.toMillis()))
      : Nothing()
  }

  toUTCDateAndTime(): { date: DateOnly; time: TimeOfDay } {
    const dt = DateTime.fromMillis(this.value, { zone: "UTC" })
    const date = new DateOnly(dt.year, dt.month, dt.day)
    const time = TimeOfDay.fromParts({
      hours: dt.hour,
      minutes: dt.minute,
      seconds: dt.second + dt.millisecond / 1000,
    })
    return { date, time }
  }

  toLocalDateAndTime(timezone: Timezone): { date: DateOnly; time: TimeOfDay } {
    const dt = DateTime.fromMillis(this.value, { zone: "UTC" }).setZone(timezone)
    const date = new DateOnly(dt.year, dt.month, dt.day)
    const time = TimeOfDay.fromParts({
      hours: dt.hour,
      minutes: dt.minute,
      seconds: dt.second + dt.millisecond / 1000,
    })
    return { date, time }
  }

  /** Parse PostgreSQL TIMESTAMPTZ string (e.g., "2026-03-17 10:30:00+00"). */
  static fromSQLTimestamp(str: string): POSIX | null {
    const date = DateTime.fromSQL(str, { zone: "UTC" })
    return date.isValid ? new POSIX(date.toMillis()) : null
  }

  /** Convert to PostgreSQL TIMESTAMPTZ string; `null` when the value is not a finite instant. */
  toSQLTimestamp(): string | null {
    return DateTime.fromMillis(this.value, { zone: "UTC" }).toSQL()
  }

  static schema: s.Schema<POSIX> = s.number.dimap(
    (n) => new POSIX(n),
    (p) => p.value
  )
}

const padded = (v: number) => v.toString().padStart(2, "0")

class DateOnly {
  readonly year: number
  readonly month: number // 1-12
  readonly day: number // 1-30ish

  constructor(year: number, month: number, day: number) {
    this.year = year
    this.month = month
    this.day = day
  }

  static todayUTC(): DateOnly {
    const utcTime = POSIX.now()
    return utcTime.toUTCDateAndTime().date
  }

  static todayLocal(timezone: Timezone): DateOnly {
    const utcTime = POSIX.now()
    return utcTime.toLocalDateAndTime(timezone).date
  }

  static fromDate(date: Date): DateOnly {
    return new DateOnly(date.getFullYear(), date.getMonth() + 1, date.getDate())
  }

  pretty() {
    return `${this.year}-${padded(this.month)}-${padded(this.day)}`
  }

  static schema: s.Schema<DateOnly> = s.string.chain(
    (str) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str)
      if (!match) {
        return fail("Invalid Date")
      }
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])

      // Luxon rejects out-of-range months and days that do not exist in that month.
      if (!DateTime.fromObject({ year, month, day }, { zone: "UTC" }).isValid) {
        return fail("Invalid Date")
      }

      return always(new DateOnly(year, month, day))
    },
    (date) => date.pretty()
  )

  greaterThan(other: DateOnly) {
    return this.compare(other) === 1
  }

  compare(other: DateOnly): number {
    return (
      this.year > other.year ? 1
      : this.year < other.year ? -1
      : this.month > other.month ? 1
      : this.month < other.month ? -1
      : this.day > other.day ? 1
      : this.day < other.day ? -1
      : 0
    )
  }

  addMonths(months: number): DateOnly {
    const luxonDate = DateTime.fromObject({
      year: this.year,
      month: this.month,
      day: this.day,
    })
    const newLuxonDate = luxonDate.plus({ months })

    return new DateOnly(newLuxonDate.year, newLuxonDate.month, newLuxonDate.day)
  }
}

class TimeOfDay {
  readonly seconds: number
  constructor(seconds: number) {
    this.seconds = seconds
  }

  static fromParts({ hours, minutes, seconds }: { hours: number; minutes: number; seconds: number }): TimeOfDay {
    return new TimeOfDay(hours * 60 * 60 + minutes * 60 + seconds)
  }

  /** `HH:mm:ss`, with a `.SSS` millisecond suffix only when the time carries a fraction. */
  pretty() {
    // Round to whole milliseconds first so a fraction that rounds up carries
    // into the seconds instead of printing `.1000`.
    const totalMillis = Math.round(this.seconds * 1000)
    const millis = totalMillis % 1000
    const totalSeconds = Math.floor(totalMillis / 1000)
    const hours = padded(Math.floor(totalSeconds / (60 * 60)))
    const minutes = padded(Math.floor(totalSeconds / 60) % 60)
    const seconds = padded(totalSeconds % 60)
    const fraction = millis > 0 ? `.${String(millis).padStart(3, "0")}` : ""
    return `${hours}:${minutes}:${seconds}${fraction}`
  }

  getSubSecondPrecision(): number {
    return this.seconds - Math.floor(this.seconds)
  }
}

/** A length of time. */
class Duration {
  private readonly millis: number
  private constructor(millis: number) {
    this.millis = millis
  }

  static milliseconds(n: number): Duration {
    return new Duration(n)
  }

  static seconds(n: number): Duration {
    return Duration.milliseconds(n * 1_000)
  }

  static minutes(n: number): Duration {
    return Duration.seconds(n * 60)
  }

  static hours(n: number): Duration {
    return Duration.minutes(n * 60)
  }

  static days(n: number): Duration {
    return Duration.hours(n * 24)
  }

  asMilliseconds(): number {
    return this.millis
  }

  asSeconds(): number {
    return this.millis / Duration.seconds(1).millis
  }

  asMinutes(): number {
    return this.millis / Duration.minutes(1).millis
  }

  asHours(): number {
    return this.millis / Duration.hours(1).millis
  }

  asDays(): number {
    return this.millis / Duration.days(1).millis
  }

  add(other: Duration): Duration {
    return new Duration(this.millis + other.millis)
  }

  subtract(other: Duration): Duration {
    return new Duration(this.millis - other.millis)
  }

  multiplyBy(n: number): Duration {
    return new Duration(n * this.millis)
  }

  divideBy(n: number): Duration {
    return new Duration(this.millis / n)
  }

  greaterThan(other: Duration) {
    return this.millis > other.millis
  }

  compare(other: Duration): number {
    return (
      this.millis > other.millis ? 1
      : this.millis < other.millis ? -1
      : 0
    )
  }

  /** Quantisation. Divide a duration into buckets of a fixed length. */
  bucketsOf(length: Duration): {
    count: number // how many full buckets of given length in the period.
    remainderStart: Duration // when did last bucket start
    remainder: Duration // how far are we into that bucket
  } {
    const sign = Math.sign(this.millis)
    const abs = this.absolute()

    const count = Math.floor(abs.millis / length.millis)
    const remainderStart = length.multiplyBy(count).multiplyBy(sign)
    const remainder = Duration.milliseconds(abs.millis % length.millis).multiplyBy(sign)
    return {
      count: count * sign,
      remainderStart,
      remainder,
    }
  }

  /** Returns a non-negative duration. */
  absolute() {
    return new Duration(Math.abs(this.millis))
  }

  /** Parts as absolute numbers. */
  parts(): {
    days: number
    hours: number
    minutes: number
    seconds: number
    milliseconds: number
  } {
    const d = new Duration(Math.abs(this.millis))
    return {
      days: Math.floor(d.asDays()),
      hours: Math.floor(d.asHours()) % 24,
      minutes: Math.floor(d.asMinutes()) % 60,
      seconds: Math.floor(d.asSeconds()) % 60,
      milliseconds: Math.floor(d.asMilliseconds() % 1_000),
    }
  }

  /** Formats duration as ISO-8601 string (e.g., "P1DT2H30M45.123S"). */
  toISO8601(): string {
    const { days, hours, minutes } = this.parts()
    const seconds = Math.abs(this.asSeconds()) % 60

    const formatSeconds = (s: number): string => (s % 1 === 0 ? s.toString() : s.toFixed(3).replace(/\.?0+$/, ""))

    const prefix = this.millis < 0 ? "-P" : "P"
    const dayPart = days > 0 ? `${days}D` : ""
    const hasTimePart = hours > 0 || minutes > 0 || seconds > 0 || days === 0
    const timeParts = [
      hours > 0 ? `${hours}H` : "",
      minutes > 0 ? `${minutes}M` : "",
      seconds > 0 || (days === 0 && hours === 0 && minutes === 0) ? `${formatSeconds(seconds)}S` : "",
    ].join("")

    return prefix + dayPart + (hasTimePart ? "T" + timeParts : "")
  }

  /** Parses ISO-8601 duration string (e.g., "P1DT2H30M45.123S"). */
  static fromISO8601(str: string): Maybe<Duration> {
    // Supports: P[nD]T[nH][nM][nS] with optional decimals on any component
    const regex = /^(-)?P(?:(\d+(?:\.\d+)?)D)?(T)?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/
    const match = str.match(regex)

    if (!match) {
      return Nothing()
    }

    const hasDays = !!match[2]
    const hasT = !!match[3]
    const hasHours = !!match[4]
    const hasMinutes = !!match[5]
    const hasSeconds = !!match[6]
    const hasTimeComponents = hasHours || hasMinutes || hasSeconds

    // Must have at least one component
    if (!hasDays && !hasTimeComponents) {
      return Nothing()
    }

    // If T is present, must have at least one time component
    if (hasT && !hasTimeComponents) {
      return Nothing()
    }

    // Time components require the T designator: without it, `M` means months
    // (which this parser does not support) and `H`/`S` are not valid at all.
    if (hasTimeComponents && !hasT) {
      return Nothing()
    }

    const negative = match[1] === "-"
    const days = match[2] ? parseFloat(match[2]) : 0
    const hours = match[4] ? parseFloat(match[4]) : 0
    const minutes = match[5] ? parseFloat(match[5]) : 0
    const seconds = match[6] ? parseFloat(match[6]) : 0

    // Chained factory methods (seconds → milliseconds) accumulate
    // IEEE-754 floating point errors (~10⁻¹⁵). Rounding to milliseconds is safe
    // as it's our internal precision and the error is far below this threshold.
    const total = Duration.days(days)
      .add(Duration.hours(hours))
      .add(Duration.minutes(minutes))
      .add(Duration.seconds(seconds))

    const millis = Math.round(total.asMilliseconds())
    return Just(Duration.milliseconds(negative ? -millis : millis))
  }

  /** Default: ISO-8601 string (standard, human-readable, interoperable). */
  static schema: s.Schema<Duration> = s.string.chain(
    (str) =>
      Duration.fromISO8601(str).unwrap(
        () => fail("Invalid ISO-8601 duration format"),
        (d) => always(d)
      ),
    (d) => d.toISO8601()
  )
}
