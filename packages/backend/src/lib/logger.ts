export { log }

/** Minimal console-backed logger; swap for a real backend without touching call sites. */
const log = {
  info(message: string, meta?: unknown) {
    console.info(message, meta ?? "")
  },
  error(message: string, error?: unknown) {
    console.error(message, error ?? "")
  },
  warn(message: string, meta?: unknown) {
    console.warn(message, meta ?? "")
  },
}
