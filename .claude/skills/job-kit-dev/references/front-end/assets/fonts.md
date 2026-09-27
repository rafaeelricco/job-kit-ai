# Fonts

Three families, each with one job, self-hosted via Fontsource and imported at the top of `packages/frontend/src/index.css`:

| Family                 | Package                              | Stack token   | Job                          |
| ---------------------- | ------------------------------------ | ------------- | ---------------------------- |
| Inter Variable         | `@fontsource-variable/inter`         | `--font-sans` | All UI text                  |
| Space Mono 400/700     | `@fontsource/space-mono`             | `--font-mono` | Every machine-readable value |
| Space Grotesk Variable | `@fontsource-variable/space-grotesk` | `--font-logo` | The wordmark, one site       |

No Google Fonts `<link>`, no CDN. Stacks are defined in `packages/frontend/src/index.css` `@theme inline`.
