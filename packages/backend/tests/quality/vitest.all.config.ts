import { defineConfig, mergeConfig } from "vitest/config"
import base from "../../vitest.config"

export default mergeConfig(
  base,
  defineConfig({
    test: {
      outputFile: { json: "reports/tests-all/results.json", junit: "reports/tests-all/junit.xml" },
      coverage: {
        include: ["src/**/*.ts"],
        thresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
        reportsDirectory: "reports/coverage/all",
      },
    },
  })
)
