# Server quality checks

Run these commands from `packages/backend/`. The fast suite needs Node.js 22 and pnpm
10.33.0. The Docker-backed integration suite also needs Docker running.

## Fast checks

```bash
pnpm quality
```

This runs ESLint, TypeScript type checking, the production build, critical
source coverage. It exits nonzero if a check or critical
coverage threshold fails. The critical source set is maintained in
[`quality/sources.mjs`](quality/sources.mjs): lines, statements, and functions
must each reach 80%, and branches must reach 70%.

Run one test by matching its name:

```bash
pnpm test -t "delete"
```

Run only unit or regression tests when narrowing a failure:

```bash
pnpm test:unit
pnpm test:regression
```

## Integration suite

Run integration tests inside the running API container:

```bash
pnpm run up
pnpm compose exec -T api pnpm test:integration
```

The integration suite needs the full Compose stack, including PostgreSQL,
MongoDB, Kafka, and postie.

## Container recreation regression

Run `pnpm run up`, then `pnpm run down`, then `pnpm run up` again.
Do not remove volumes. Both starts must succeed, and the integration suite
must still pass after recreation. Scheduled/manual CI performs
this recreation before running the suite.

## Nightly checks and reports

Run all-source coverage separately when you want a broad, informational view:

```bash
pnpm test:coverage:all
```

Run mutation testing when you want to measure whether the tests detect seeded
changes:

```bash
pnpm test:mutation
```

Stryker reports the high threshold at 80% and the low threshold at 70%; its
break threshold is 70%. The scheduled and manual CI runs keep mutation testing,
all-source coverage, and Docker-backed tests in separate jobs after the fast
quality job passes.

Reports are written under `reports/`:

- `tests/` has the fast suite JSON and JUnit results.
- `coverage/critical/` has the gated source coverage.
- `coverage/all/` has the informational all-source coverage.
- `mutation/` has Stryker JSON and HTML output.
- `integration/` has the integration suite JSON and JUnit results.
- `quality/summary.md` and `quality/summary.json` summarize the reports that
  exist. Missing reports are marked unavailable, never passing. When
  `GITHUB_STEP_SUMMARY` is set, the Markdown is appended to the CI summary.

The report shows passed, failed, and skipped counts, durations, covered/total
counts for each coverage metric, and Stryker mutant outcomes. To regenerate it
from the reports currently on disk:

```bash
pnpm quality:report
```

## Add a regression when fixing a bug

1. Add a named case under `tests/regression/` that reproduces the observed failure
   through its public boundary. Record the triggering conditions in the test.
2. Confirm that it fails for the reported reason before applying the fix. Use
   an isolated fixture; share reusable setup through `tests/support/`.
3. Apply the fix and run `pnpm test:regression`, then `pnpm quality`. Run the
   Docker suites when persistence or event delivery is involved.
4. Review surviving mutants for the affected behavior. Improve observable
   assertions before considering an exclusion; document any justified exclusion
   beside its configuration. Do not lower the gates to accommodate the fix.

The mutation tool and Vitest versions are
pinned together; update them with a full mutation run, not only a passing build.
