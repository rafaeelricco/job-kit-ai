export {
  initialSession,
  subscribeToSessionUpdates,
  reloadSession,
  requestCode,
  verifyCode,
  googleSignInHref,
  signOut,
  type Session,
}

import * as s from "@lib/json/schema"

import { toast } from "sonner"
import { Future } from "@lib/future"
import { Just, Nothing, fromNullable, type Maybe } from "@lib/maybe"
import { api, GOOGLE_START_PATH } from "@api/endpoints"
import { call, type FetchError } from "@api/request"
import { clearHandle } from "@module/access/handle"
import { type Actor, type UserActor, schema_actor } from "@be/app/actor"

/**
 * The session as the UI sees it. `Checking`: nobody cached, `whoAmI` in flight.
 * `SignedOut.error`: the `whoAmI` that failed, if any. A cached user is
 * `SignedIn` at once while `whoAmI` revalidates; the cached copy grants nothing.
 */
type Session =
  { type: "Checking" } | { type: "SignedOut"; error: Maybe<FetchError> } | { type: "SignedIn"; user: UserActor }

const SESSION_KEY = "session"

/** The stored entry's schema. A corrupt or outdated entry decodes to a `Failure`, where `JSON.parse` would throw. */
const schema_stored = s.stringified(schema_actor)

type Listener = (muser: Maybe<UserActor>) => void

/** This tab's subscribers. `setSession` calls them directly. */
const listeners = new Set<Listener>()

/**
 * Counts identity changes newer than the server's last answer: a sign-in or
 * sign-out in this tab or another one. A `whoAmI` that started under an older
 * generation describes a session that no longer exists, so `reloadSession`
 * drops its answer instead of writing it over the newer one.
 */
let generation = 0

/** Store or clear `muser`, then notify this tab's listeners. */
function setSession(muser: Maybe<UserActor>): void {
  forgetProfileFolder(muser)
  writeStored(muser)
  listeners.forEach((listener) => listener(muser))
}

/** Record a sign-in or sign-out. It supersedes any `whoAmI` still in flight. */
function commitSession(muser: Maybe<UserActor>): void {
  generation += 1
  setSession(muser)
}

/**
 * Forget the chosen profile folder once nobody is signed in. The folder
 * belongs to whoever chose it, so the next account in this browser must not be
 * able to open the previous account's files.
 */
function forgetProfileFolder(muser: Maybe<UserActor>): void {
  if (muser instanceof Nothing) void clearHandle()
}

/** The first frame's session: the cached user, else `Checking` until `whoAmI` answers. */
function initialSession(): Session {
  const cached = readStored().chain(decodeStored)
  return (
    cached instanceof Just ? { type: "SignedIn", user: cached.value }
    : cached instanceof Nothing ? { type: "Checking" }
    : (cached satisfies never)
  )
}

/** A cache write as the UI sees it: the stored user, or signed out with no error. */
function fromCache(muser: Maybe<UserActor>): Session {
  return (
    muser instanceof Just ? { type: "SignedIn", user: muser.value }
    : muser instanceof Nothing ? { type: "SignedOut", error: Nothing() }
    : (muser satisfies never)
  )
}

/** Decode a stored entry. A decode failure, or a stale `Anonymous` entry, reads as "nothing cached". */
function decodeStored(raw: string): Maybe<UserActor> {
  return s.decode(schema_stored, raw).either<Maybe<UserActor>>(
    () => Nothing(),
    (actor) => (actor.type === "User" ? Just(actor) : Nothing())
  )
}

/**
 * Read the raw entry. `localStorage` is a platform boundary, so disabled or
 * full storage means "nothing cached", as in `filter-store.ts`.
 */
function readStored(): Maybe<string> {
  try {
    return fromNullable(window.localStorage.getItem(SESSION_KEY))
  } catch {
    return Nothing()
  }
}

/**
 * Write or remove the entry. A storage failure is ignored: the cache is a
 * convenience, and `setSession` still notifies listeners for this visit.
 */
function writeStored(muser: Maybe<UserActor>): void {
  try {
    switch (true) {
      case muser instanceof Just:
        // `userId` is an `Id` instance, which JSON.stringify alone would not round-trip.
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(s.encode(schema_actor, muser.value)))
        break
      case muser instanceof Nothing:
        window.localStorage.removeItem(SESSION_KEY)
        break
      default:
        muser satisfies never
    }
  } catch {
    // Ignored on purpose; see above.
  }
}

/**
 * Call `listener` with the new `Session` on every change, and return a function that
 * unsubscribes it.
 *
 * Changes made in this tab arrive through `setSession`. Changes made in
 * another tab arrive through the `storage` event, which the browser fires in
 * every tab except the one that wrote.
 */
function subscribeToSessionUpdates(listener: (session: Session) => void): () => void {
  const notify: Listener = (muser) => listener(fromCache(muser))
  const onStorage = (event: StorageEvent): void => {
    // `key === null` means `localStorage.clear()`, which also drops the session.
    if (event.storageArea !== window.localStorage) return
    if (event.key !== null && event.key !== SESSION_KEY) return

    // The other tab signed in or out, so any `whoAmI` in flight here is now stale.
    generation += 1

    const muser = fromNullable(event.newValue).chain(decodeStored)
    forgetProfileFolder(muser)
    notify(muser)
  }
  listeners.add(notify)
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(notify)
    window.removeEventListener("storage", onStorage)
  }
}

/**
 * Ask the server who we are and cache the answer. Only a resolved `Anonymous`
 * clears the cache. A rejection (network, 5xx, or decode) leaves it alone.
 *
 * An answer that arrives after a sign-in or sign-out is returned but not
 * cached, because it describes the old session.
 */
function reloadSession(): Future<FetchError, Actor> {
  // Read `generation` when the Future runs, not when it is built: a Future does nothing until forked.
  return Future.resolve<FetchError, null>(null).chain(() => {
    const startedAt = generation
    return call(api.whoAmI, {}).map(({ actor }) => {
      if (startedAt === generation) setSession(actor.type === "User" ? Just(actor) : Nothing())
      return actor
    })
  })
}

/**
 * Ask the server to email a sign-in code to `email`. The reply is the same
 * for every well-formed address, whether or not it is on the list; the server
 * decides who gets mail.
 */
function requestCode(email: string): Future<FetchError, void> {
  return call(api.requestCode, { email }).map(() => undefined)
}

/**
 * Exchange `email` and `code` for a session, and store it. The reply carries
 * the user id, so no second `whoAmI` is needed, and none can race this one.
 */
function verifyCode(email: string, code: string): Future<FetchError, UserActor> {
  return call(api.verifyCode, { email, code }).map(({ userId }) => {
    const user: UserActor = { type: "User", userId }
    commitSession(Just(user))
    return user
  })
}

/**
 * The URL that starts Google sign-in and comes back to `returnTo`. Navigate
 * to it instead of fetching it, because Google's consent screen needs the
 * whole window. The server re-checks `returnTo`.
 *
 * ```ts
 * googleSignInHref("/dossiers") // "/api/v1/auth/google/start?returnTo=%2Fdossiers"
 * ```
 */
function googleSignInHref(returnTo: string): string {
  return `${GOOGLE_START_PATH}?${new URLSearchParams({ returnTo })}`
}

/**
 * Sign out optimistically: the UI goes anonymous at once, and the request ends
 * the server session in the background.
 *
 * If the request fails, the server session may still be live, so ask the
 * server who we are. A surviving session comes back with a toast, instead of
 * hiding behind a signed-out screen until the next reload.
 */
function signOut(): void {
  commitSession(Nothing())
  const signedOutAt = generation
  call(api.signOut, {}).fork(
    () => {
      // A sign-in since then was deliberate, and `reloadSession` now reports that session, so stay quiet.
      const stillSignedOut = (): boolean => generation === signedOutAt
      reloadSession().fork(
        () => {
          if (stillSignedOut()) toast.error("Could not reach the server to sign out. Try again.")
        },
        (actor) => {
          if (actor.type === "User" && stillSignedOut()) toast.error("Sign-out failed; you are still signed in.")
        }
      )
    },
    () => {}
  )
}
