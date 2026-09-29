export {
  type DevicePoll,
  DEFAULT_INTERVAL,
  requestXaiDeviceCode,
  pollXaiDeviceToken,
  ensureFreshXaiTokens,
  fetchXaiUser,
}

import * as d from "@lib/json/decoder"

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing, fromOptional } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { type Secret, CredentialRevoked } from "@be/domain/ai/adapter"

type OAuthSecret = Extract<Secret, { kind: "oauth" }>

const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token"
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code"
const XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo"
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"

const TOKEN_REFRESH_BUFFER = Duration.minutes(5)
const DEFAULT_INTERVAL = Duration.seconds(5)
const AUTH_TIMEOUT_MS = 5_000

type XaiDeviceCode = {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: Duration
  expiresAt: POSIX
}
type DevicePoll =
  | { status: "complete"; tokens: OAuthSecret }
  | { status: "pending" }
  | { status: "slow_down"; interval: Maybe<Duration> }
  | { status: "denied" }
  | { status: "expired" }
type XaiUser = { sub: string; email: Maybe<string> }

const deviceCodeDecoder = d.object({
  device_code: d.string,
  user_code: d.string,
  verification_uri: d.string,
  interval: d.optional(d.number),
  expires_in: d.number,
})
const tokenDecoder = d.object({ access_token: d.string, refresh_token: d.optional(d.string), expires_in: d.number })
const errorDecoder = d.object({ error: d.string, interval: d.optional(d.number) })
const userDecoder = d.object({ sub: d.string, email: d.optional(d.string) })

type JsonResponse = { status: number; ok: boolean; body: unknown }

async function readJson(response: Response): Promise<JsonResponse> {
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) }
}

async function postForm(url: string, form: Record<string, string>): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  })
  return readJson(response)
}

const nonEmpty = (value: string | undefined): Maybe<string> =>
  fromOptional(value).chain((s) => (s === "" ? Nothing<string>() : Just(s)))

const positiveSeconds = (value: number | undefined): Maybe<Duration> =>
  fromOptional(value).chain((n) => (Number.isFinite(n) && n > 0 ? Just(Duration.seconds(n)) : Nothing<Duration>()))

const httpsUri = (raw: string): Maybe<string> => {
  if (!URL.canParse(raw)) return Nothing()
  const url = new URL(raw)
  return url.protocol === "https:" ? Just(url.href) : Nothing()
}

function toDeviceCode(body: unknown): Future<Error, XaiDeviceCode> {
  const invalid = new Error("xAI device authorization response was invalid")
  return d
    .decode(body, deviceCodeDecoder)
    .either(
      () => Nothing<XaiDeviceCode>(),
      (raw) =>
        positiveSeconds(raw.expires_in).chain((expiresIn) =>
          nonEmpty(raw.device_code).chain((deviceCode) =>
            nonEmpty(raw.user_code).chain((userCode) =>
              httpsUri(raw.verification_uri).map((verificationUri): XaiDeviceCode => ({
                deviceCode,
                userCode,
                verificationUri,
                interval: positiveSeconds(raw.interval).withDefault(DEFAULT_INTERVAL),
                expiresAt: POSIX.now().addDuration(expiresIn),
              }))
            )
          )
        )
    )
    .unwrap(
      () => Future.reject<Error, XaiDeviceCode>(invalid),
      (device) => Future.resolve<Error, XaiDeviceCode>(device)
    )
}

function requestXaiDeviceCode(): Future<Error, XaiDeviceCode> {
  return Future.attemptP(() =>
    postForm(XAI_DEVICE_CODE_URL, {
      client_id: XAI_CLIENT_ID,
      scope: "openid profile email offline_access grok-cli:access api:access",
      referrer: "grok-build",
    })
  ).chain((response) =>
    response.ok
      ? toDeviceCode(response.body)
      : Future.reject<Error, XaiDeviceCode>(new Error(`xAI device authorization failed (${response.status})`))
  )
}

function toTokens(body: unknown, kept: Maybe<string>): Maybe<OAuthSecret> {
  return d.decode(body, tokenDecoder).either(
    () => Nothing<OAuthSecret>(),
    (grant) =>
      nonEmpty(grant.access_token).chain((accessToken) =>
        nonEmpty(grant.refresh_token)
          .alt(kept)
          .map((refreshToken): OAuthSecret => ({
            kind: "oauth",
            accessToken,
            refreshToken,
            expiresAt: POSIX.now().addDuration(Duration.seconds(grant.expires_in)),
          }))
      )
  )
}

function devicePollFromError(status: number, body: unknown): Future<Error, DevicePoll> {
  return d.decode(body, errorDecoder).either(
    () => Future.reject<Error, DevicePoll>(new Error(`xAI device token polling failed (${status})`)),
    ({ error, interval }) => {
      switch (error) {
        case "authorization_pending":
          return Future.resolve<Error, DevicePoll>({ status: "pending" })
        case "slow_down":
          return Future.resolve<Error, DevicePoll>({ status: "slow_down", interval: positiveSeconds(interval) })
        case "access_denied":
        case "authorization_denied":
          return Future.resolve<Error, DevicePoll>({ status: "denied" })
        case "expired_token":
          return Future.resolve<Error, DevicePoll>({ status: "expired" })
        default:
          return Future.reject<Error, DevicePoll>(new Error(`xAI device token polling failed (${status})`))
      }
    }
  )
}

function pollXaiDeviceToken(deviceCode: string): Future<Error, DevicePoll> {
  return Future.attemptP(() =>
    postForm(XAI_TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_CLIENT_ID,
      device_code: deviceCode,
    })
  ).chain((response) =>
    response.ok
      ? toTokens(response.body, Nothing()).unwrap(
          () => Future.reject<Error, DevicePoll>(new Error("xAI device token response was invalid")),
          (tokens) => Future.resolve<Error, DevicePoll>({ status: "complete", tokens })
        )
      : devicePollFromError(response.status, response.body)
  )
}

function refreshFailed(response: JsonResponse): Future<Error, OAuthSecret> {
  const revoked = d.decode(response.body, errorDecoder).either(
    () => false,
    ({ error }) => error === "invalid_grant"
  )
  return Future.reject(
    revoked
      ? new CredentialRevoked("xAI tokens have been revoked")
      : new Error(`xAI token refresh failed (${response.status})`)
  )
}

function ensureFreshXaiTokens(tokens: OAuthSecret): Future<Error, OAuthSecret> {
  if (tokens.expiresAt.isAfter(POSIX.now().addDuration(TOKEN_REFRESH_BUFFER))) return Future.resolve(tokens)
  return Future.attemptP(() =>
    postForm(XAI_TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: tokens.refreshToken,
    })
  ).chain((response) =>
    response.ok
      ? toTokens(response.body, Just(tokens.refreshToken)).unwrap(
          () => Future.reject<Error, OAuthSecret>(new Error("xAI token refresh response was invalid")),
          (fresh) => Future.resolve<Error, OAuthSecret>(fresh)
        )
      : refreshFailed(response)
  )
}

function fetchXaiUser(accessToken: string): Future<Error, XaiUser> {
  return Future.attemptP(async () =>
    readJson(
      await fetch(XAI_USERINFO_URL, {
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      })
    )
  ).chain((response) =>
    response.ok
      ? d.decode(response.body, userDecoder).either(
          () => Future.reject<Error, XaiUser>(new Error("xAI userinfo response was invalid")),
          (user) => Future.resolve<Error, XaiUser>({ sub: user.sub, email: fromOptional(user.email) })
        )
      : Future.reject<Error, XaiUser>(new Error(`xAI userinfo failed (${response.status})`))
  )
}
