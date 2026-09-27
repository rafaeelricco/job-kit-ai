import { describe, expect, it } from "vitest"
import { buildQualitySummary, type QualityReportInputs } from "./report"

const coverage = {
  total: {
    lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
    statements: { total: 12, covered: 12, skipped: 0, pct: 100 },
    functions: { total: 4, covered: 4, skipped: 0, pct: 100 },
    branches: { total: 6, covered: 6, skipped: 0, pct: 100 },
  },
}

const mutation = {
  schemaVersion: "1.0",
  files: {
    "src/domain/note/note.ts": {
      mutants: [
        { id: "1", mutatorName: "BooleanLiteral", status: "Killed" },
        { id: "2", mutatorName: "EqualityOperator", status: "Survived" },
        { id: "3", mutatorName: "ArithmeticOperator", status: "Timeout" },
        { id: "4", mutatorName: "ArrayDeclaration", status: "Killed" },
        { id: "5", mutatorName: "BooleanLiteral", status: "Killed" },
        { id: "6", mutatorName: "BooleanLiteral", status: "Killed" },
        { id: "7", mutatorName: "BooleanLiteral", status: "Killed" },
        { id: "8", mutatorName: "BooleanLiteral", status: "Killed" },
        { id: "9", mutatorName: "BooleanLiteral", status: "Killed" },
        { id: "10", mutatorName: "BooleanLiteral", status: "Killed" },
      ],
    },
  },
}

function completeReports(): QualityReportInputs {
  return {
    tests: {
      numPassedTests: 4,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
      numFailedTestSuites: 0,
      success: true,
      startTime: 100,
      testResults: [{ endTime: 1800 }],
    },
    integration: {
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
      numFailedTestSuites: 0,
      success: true,
      startTime: 0,
      testResults: [{ endTime: 900 }],
    },
    criticalCoverage: coverage,
    allCoverage: coverage,
    mutation,
  }
}

describe("quality report summary", () => {
  it("summarizes passing test, coverage, and mutation reports", () => {
    const summary = buildQualitySummary(completeReports())

    expect(summary.status).toBe("passed")
    expect(summary.suites.unit).toMatchObject({
      status: "passed",
      counts: { passed: 4, failed: 0, skipped: 1, total: 5, durationMs: 1700 },
    })
    expect(summary.coverage.critical.metrics.lines).toMatchObject({
      covered: 10,
      total: 10,
      percent: 100,
      gatePercent: 80,
    })
    expect(summary.coverage.all.metrics.lines).toMatchObject({ gatePercent: null })
    expect(summary.mutation).toMatchObject({
      status: "available",
      score: 90,
      outcomes: { killed: 8, survived: 1, timeout: 1 },
    })
    expect(summary.missing).toEqual([])
  })

  it("preserves failed test results in the overall report", () => {
    const summary = buildQualitySummary({
      ...completeReports(),
      tests: {
        numPassedTests: 2,
        numFailedTests: 1,
        numPendingTests: 0,
        numFailedTestSuites: 1,
        success: false,
        startTime: 0,
        testResults: [{ endTime: 500 }],
      },
    })

    expect(summary.status).toBe("failed")
    expect(summary.suites.unit).toMatchObject({ status: "failed", counts: { passed: 2, failed: 1, total: 3 } })
  })

  it("fails unsuccessful Vitest runs", () => {
    const report = completeReports()
    const summary = buildQualitySummary({
      ...report,
      tests: { numPassedTests: 0, numFailedTests: 0, numFailedTestSuites: 1, success: false },
    })

    expect(summary.suites.unit).toMatchObject({ status: "failed", counts: { failed: 0, total: 0 } })
    expect(summary.status).toBe("failed")
  })

  it("fails when critical coverage misses a configured threshold", () => {
    const lowCoverage = {
      ...coverage,
      total: { ...coverage.total, lines: { total: 10, covered: 7, skipped: 0, pct: 70 } },
    }
    const summary = buildQualitySummary({ ...completeReports(), criticalCoverage: lowCoverage })

    expect(summary.status).toBe("failed")
  })

  it("marks absent reports unavailable instead of treating them as passing", () => {
    const summary = buildQualitySummary({})

    expect(summary.status).toBe("unavailable")
    expect(summary.suites.unit.status).toBe("unavailable")
    expect(summary.coverage.critical.status).toBe("unavailable")
    expect(summary.mutation.status).toBe("unavailable")
    expect(summary.missing).toContain("unit tests")
    expect(summary.missing).toContain("Stryker mutation outcomes")
  })
})

it("counts native skipped and todo tests without losing either category", () => {
  const summary = buildQualitySummary({
    tests: {
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 3,
      numTotalTests: 6,
      success: true,
    },
  })
  expect(summary.suites.unit.counts).toMatchObject({ passed: 2, failed: 0, skipped: 4, total: 6 })
})
