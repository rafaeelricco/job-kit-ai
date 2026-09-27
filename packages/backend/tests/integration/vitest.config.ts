import { defineConfig, mergeConfig } from "vitest/config"
import baseConfig from "../../vitest.config"

const mergedConfig = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["tests/integration/*.test.ts"],
      coverage: { enabled: false },
      fileParallelism: false,
      testTimeout: 480000,
      hookTimeout: 180000,
      reporters: ["default", "json", "junit"],
      outputFile: {
        json: "reports/integration/results.json",
        junit: "reports/integration/junit.xml",
      },
    },
  })
)

export default defineConfig({
  ...mergedConfig,
  ["test"]: {
    ...mergedConfig["test"],
    include: ["tests/integration/*.test.ts"],
    coverage: { ...mergedConfig["test"]?.["coverage"], enabled: false },
    fileParallelism: false,
    testTimeout: 480000,
    hookTimeout: 180000,
    reporters: ["default", "json", "junit"],
    outputFile: {
      json: "reports/integration/results.json",
      junit: "reports/integration/junit.xml",
    },
  },
})
