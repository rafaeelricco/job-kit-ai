export { GOOGLE_START_PATH, type GoogleSignInError }

/** Where the browser starts Google sign-in; the server mounts its GET route here. */
const GOOGLE_START_PATH = "/api/v1/auth/google/start"

/** The `?error=` values the callback lands on `/sign-in` with. The frontend's sign-in page has a message for each. */
type GoogleSignInError = "cancelled" | "failed" | "unavailable"
