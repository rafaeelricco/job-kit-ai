import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { thresholds } from "./sources.mjs"

type Status = "passed" | "failed" | "unavailable"
type Counts = { passed: number; failed: number; skipped: number; total: number; durationMs: number | null }
type TestReport = { status: Status; counts: Counts }
type Metric = { covered: number; total: number; percent: number | null; gatePercent: number | null }
type CoverageReport = { status: "available" | "unavailable"; metrics: Partial<Record<keyof typeof thresholds, Metric>> }
type MutationOutcomes = {
  killed: number
  survived: number
  timeout: number
  noCoverage: number
  runtimeError: number
  compileError: number
  ignored: number
  pending: number
  other: number
}
type MutationReport = {
  status: "available" | "unavailable"
  score: number | null
  outcomes: MutationOutcomes
}

export type QualityReportInputs = {
  tests?: unknown
  integration?: unknown
  criticalCoverage?: unknown
  allCoverage?: unknown
  mutation?: unknown
}

export type QualitySummary = {
  status: Status
  suites: { unit: TestReport; integration: TestReport }
  coverage: { critical: CoverageReport; all: CoverageReport }
  mutation: MutationReport
  missing: string[]
}

const emptyCounts = (): Counts => ({ passed: 0, failed: 0, skipped: 0, total: 0, durationMs: null })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

function summarizeVitest(data: unknown): TestReport | undefined {
  if (!isRecord(data)) return undefined
  const passed = finite(data["numPassedTests"])
  const failed = finite(data["numFailedTests"]) ?? 0
  const pending = finite(data["numPendingTests"] ?? data["numSkippedTests"])
  const todo = finite(data["numTodoTests"])
  const skipped = (pending ?? 0) + (todo ?? 0)
  const failedSuites = finite(data["numFailedTestSuites"]) ?? 0
  if (passed === undefined && failed === 0 && skipped === 0 && failedSuites === 0 && data["success"] !== false)
    return undefined
  const passedCount = passed ?? 0
  const failedCount = failed ?? 0
  const skippedCount = skipped ?? 0
  const start = finite(data["startTime"])
  const resultEndTimes = Array.isArray(data["testResults"])
    ? data["testResults"].flatMap((result) =>
        isRecord(result) && finite(result["endTime"]) !== undefined ? [finite(result["endTime"]) as number] : []
      )
    : []
  const end = finite(data["endTime"]) ?? (resultEndTimes.length ? Math.max(...resultEndTimes) : undefined)
  const counts: Counts = {
    passed: passedCount,
    failed: failedCount,
    skipped: skippedCount,
    total: passedCount + failedCount + skippedCount,
    durationMs: start === undefined || end === undefined ? null : Math.max(0, end - start),
  }
  return counts.failed > 0 || failedSuites > 0 || data["success"] === false
    ? { status: "failed", counts }
    : counts.total === 0
      ? { status: "unavailable", counts }
      : { status: "passed", counts }
}

function summarizeTests(data: unknown): TestReport {
  const report = summarizeVitest(data)
  return report ?? { status: "unavailable", counts: emptyCounts() }
}

function summarizeCoverage(data: unknown, applyGates: boolean): CoverageReport {
  if (!isRecord(data) || !isRecord(data["total"])) return { status: "unavailable", metrics: {} }
  const metrics: CoverageReport["metrics"] = {}
  for (const name of ["lines", "statements", "functions", "branches"] as const) {
    const raw = data["total"][name]
    if (!isRecord(raw) || typeof raw["covered"] !== "number" || typeof raw["total"] !== "number") continue
    metrics[name] = {
      covered: raw["covered"],
      total: raw["total"],
      percent: finite(raw["pct"]) ?? (raw["total"] === 0 ? null : (raw["covered"] / raw["total"]) * 100),
      gatePercent: applyGates ? thresholds[name] : null,
    }
  }
  return Object.keys(metrics).length === 4 ? { status: "available", metrics } : { status: "unavailable", metrics }
}

function findMutants(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) return value.forEach((item) => findMutants(item, output))
  if (!isRecord(value)) return
  if (typeof value["status"] === "string" && "mutatorName" in value) return void output.push(value)
  Object.values(value).forEach((child) => findMutants(child, output))
}

function summarizeMutation(data: unknown): MutationReport {
  const outcomes: MutationOutcomes = {
    killed: 0,
    survived: 0,
    timeout: 0,
    noCoverage: 0,
    runtimeError: 0,
    compileError: 0,
    ignored: 0,
    pending: 0,
    other: 0,
  }
  if (!isRecord(data)) return { status: "unavailable", score: null, outcomes }
  const mutants: Record<string, unknown>[] = []
  findMutants(data["files"] ?? {}, mutants)
  if (mutants.length === 0) return { status: "unavailable", score: null, outcomes }
  const outcomeForStatus: Record<string, keyof MutationOutcomes> = {
    killed: "killed",
    survived: "survived",
    timeout: "timeout",
    nocoverage: "noCoverage",
    runtimeerror: "runtimeError",
    compileerror: "compileError",
    ignored: "ignored",
    excluded: "ignored",
    pending: "pending",
  }
  for (const mutant of mutants) {
    const status = String(mutant["status"])
      .replace(/[^a-z]/gi, "")
      .toLowerCase()
    const key = outcomeForStatus[status] ?? "other"
    outcomes[key] += 1
  }
  const denominator = outcomes["killed"] + outcomes["timeout"] + outcomes["survived"] + outcomes["noCoverage"]
  if (denominator === 0) return { status: "unavailable", score: null, outcomes }
  return { status: "available", score: ((outcomes["killed"] + outcomes["timeout"]) / denominator) * 100, outcomes }
}

export function buildQualitySummary(inputs: QualityReportInputs): QualitySummary {
  const suites = {
    unit: summarizeTests(inputs.tests),
    integration: summarizeTests(inputs.integration),
  }
  const coverage = {
    critical: summarizeCoverage(inputs.criticalCoverage, true),
    all: summarizeCoverage(inputs.allCoverage, false),
  }
  const mutation = summarizeMutation(inputs.mutation)
  const missing = [
    ...Object.entries(suites)
      .filter(([, report]) => report.status === "unavailable")
      .map(([name]) => `${name} tests`),
    ...(coverage.critical.status === "unavailable" ? ["critical coverage"] : []),
    ...(coverage.all.status === "unavailable" ? ["all-source coverage"] : []),
    ...(mutation.status === "unavailable" ? ["Stryker mutation outcomes"] : []),
  ]
  const criticalGateFailed = Object.values(coverage.critical.metrics).some(
    (metric) => metric.percent === null || metric.percent < (metric.gatePercent ?? 0)
  )
  const mutationGateFailed = mutation.score !== null && mutation.score < 70
  const failed =
    Object.values(suites).some((report) => report.status === "failed") || criticalGateFailed || mutationGateFailed
  return { status: failed ? "failed" : missing.length ? "unavailable" : "passed", suites, coverage, mutation, missing }
}

function percent(value: number | null): string {
  return value === null ? "unavailable" : `${value.toFixed(1)}%`
}

function renderSuites(suites: QualitySummary["suites"]): string[] {
  const lines = [
    "## Test suites",
    "",
    "| Suite | Status | Passed | Failed | Skipped | Total | Duration |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const [name, report] of Object.entries(suites)) {
    const { counts } = report
    const duration = counts.durationMs === null ? "unavailable" : `${(counts.durationMs / 1000).toFixed(2)} s`
    lines.push(
      `| ${name} | ${report.status} | ${counts.passed} | ${counts.failed} | ${counts.skipped} | ${counts.total} | ${duration} |`
    )
  }
  return lines
}

function renderCoverageScope(scope: string, report: CoverageReport): string[] {
  if (report.status === "unavailable") return [`### ${scope} scope`, "", "Unavailable.", ""]
  const lines = [
    `### ${scope} scope`,
    "",
    "| Metric | Covered / total | Coverage | Gate |",
    "| --- | ---: | ---: | ---: |",
  ]
  for (const [name, metric] of Object.entries(report.metrics)) {
    if (!metric) continue
    const gate = metric.gatePercent === null ? "—" : `${metric.gatePercent}%`
    lines.push(`| ${name} | ${metric.covered} / ${metric.total} | ${percent(metric.percent)} | ${gate} |`)
  }
  return [...lines, ""]
}

function renderCoverage(coverage: QualitySummary["coverage"]): string[] {
  const scopes = Object.entries(coverage).flatMap(([scope, report]) => renderCoverageScope(scope, report))
  return ["## Coverage", "", "Coverage is covered/total; test commands enforce the configured gates.", "", ...scopes]
}

function renderMutation(mutation: MutationReport): string[] {
  const outcomes = mutation.outcomes
  return [
    "## Mutation outcomes",
    "",
    `Status: **${mutation.status}**; score: **${percent(mutation.score)}**. Stryker thresholds: high 80%, low 70%, break 70%.`,
    "",
    "| Killed | Survived | Timeout | No coverage | Runtime error | Compile error | Ignored | Pending | Other |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${outcomes["killed"]} | ${outcomes["survived"]} | ${outcomes["timeout"]} | ${outcomes["noCoverage"]} | ${outcomes["runtimeError"]} | ${outcomes["compileError"]} | ${outcomes["ignored"]} | ${outcomes["pending"]} | ${outcomes["other"]} |`,
    "",
  ]
}

function renderMarkdown(summary: QualitySummary): string {
  const lines = [
    "# Quality report",
    "",
    `Overall status: **${summary.status}**`,
    "",
    "Missing reports are unavailable and never count as passing.",
    "",
    ...renderSuites(summary.suites),
    "",
    ...renderCoverage(summary.coverage),
    "",
    ...renderMutation(summary.mutation),
    "",
  ]
  if (summary.missing.length) lines.push(`Unavailable reports: ${summary.missing.join(", ")}.`, "")
  return lines.join("\n")
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown
  } catch {
    return undefined
  }
}

export async function readQualityInputs(reports = path.resolve("reports")): Promise<QualityReportInputs> {
  const files = {
    tests: "tests/results.json",
    integration: "integration/results.json",
    criticalCoverage: "coverage/critical/coverage-summary.json",
    allCoverage: "coverage/all/coverage-summary.json",
    mutation: "mutation/mutation.json",
  } as const
  const entries = await Promise.all(
    Object.entries(files).map(async ([key, relative]) => [key, await readJson(path.join(reports, relative))] as const)
  )
  return Object.fromEntries(entries) as QualityReportInputs
}

async function main(): Promise<void> {
  const reports = path.resolve("reports")
  const summary = buildQualitySummary(await readQualityInputs(reports))
  const markdown = renderMarkdown(summary)
  const quality = path.join(reports, "quality")
  await mkdir(quality, { recursive: true })
  await Promise.all([
    writeFile(path.join(quality, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(path.join(quality, "summary.md"), markdown),
  ])
  console.log(markdown)
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    await writeFile(process.env["GITHUB_STEP_SUMMARY"], `${markdown}\n`, { flag: "a" })
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
