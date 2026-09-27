import tseslint from "typescript-eslint"
import sonarjs from "eslint-plugin-sonarjs"

export default tseslint.config(
  {
    ignores: ["dist/**", "reports/**", ".stryker-tmp/**", "node_modules/**", "**/*.d.ts"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 10],
    },
  }
)
