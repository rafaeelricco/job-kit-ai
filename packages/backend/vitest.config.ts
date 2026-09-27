import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { criticalSources, thresholds } from "./tests/quality/sources.mjs"

export default defineConfig({
  resolve: {
    alias: {
      "@be": fileURLToPath(new URL("./src", import.meta.url)),
      "@lib": fileURLToPath(new URL("../lib", import.meta.url)),
      "@tests": fileURLToPath(new URL("./tests", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/{unit,regression,quality}/**/*.test.ts"],
    allowOnly: false,
    passWithNoTests: false,
    retry: 0,
    testTimeout: 10000,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    reporters: ["default", "json", "junit"],
    outputFile: { json: "reports/tests/results.json", junit: "reports/tests/junit.xml" },
    coverage: {
      provider: "v8",
      include: criticalSources,
      thresholds,
      reportsDirectory: "reports/coverage/critical",
      reporter: ["text", "html", "lcov", "json", "json-summary"],
      reportOnFailure: true,
    },
  },
})
