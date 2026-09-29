/** Shared denominator for critical coverage and mutation testing. */
export const criticalSources = [
  "src/domain/{ai,auth,user,workspace}/**/*.ts",
  "src/app/auth/**/*.ts",
  "src/app/{handleCommand,handleQuery,handleProjection,idempotency,responses,engine,resolveAuth,session}.ts",
  "src/app/ai/{authorize,credential}.ts",
  "src/app/ai/store/crypto.ts",
  "src/app/ai/adapters/{api-key,xai-device,readiness}.ts",
  "src/app/ai/auth/xai.ts",
  "src/app/ai/llm/{router,retry}.ts",
  "src/lib/event-delivery.ts",
  "src/lib/event-sourcing/**/*.ts",
  "src/lib/google-oidc.ts",
  "src/lib/google.ts",
  "src/lib/postgres.ts",
]

export const thresholds = { lines: 80, statements: 80, functions: 80, branches: 70 }
