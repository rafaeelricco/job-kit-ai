export { type GoogleOidc, googleOidc }
export type { TokenPayload } from "google-auth-library"

import { CodeChallengeMethod, OAuth2Client, type TokenPayload } from "google-auth-library"
import { createHash } from "node:crypto"
import { Future } from "@lib/future"
import { log } from "@be/lib/logger"

/**
 * The library's reason, cut at the first ": ": its ID token errors append the raw token or its decoded claims
 * there, and its request errors carry the code and PKCE verifier on `config`, so only this text leaves the wrapper.
 */
const reason = (error: Error): string => error.message.replace(/: [\s\S]*$/, "")

type GoogleOidc = {
  readonly configured: boolean
  /** The URL carries `verifier`'s S256 challenge; hand the same verifier to `exchange`. */
  readonly authorizationUrl: (p: { state: string; nonce: string; verifier: string }) => string
  /** Claims of an ID token whose signature, issuer, audience and expiry Google's library checked. The nonce is the caller's to check. */
  readonly exchange: (code: string, verifier: string) => Future<Error, TokenPayload>
}

function googleOidc(config: {
  clientId: string
  clientSecret: string
  redirectUri: string
  fetch?: typeof fetch
}): GoogleOidc {
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    // Node's own fetch instead of gaxios's bundled node-fetch; tests hand in a fake Google.
    transporterOptions: { fetchImplementation: config.fetch ?? fetch },
  })
  return {
    // A Web application client can't exchange a code without its secret, so an id alone is not set up.
    configured: config.clientId !== "" && config.clientSecret !== "",
    authorizationUrl: ({ state, nonce, verifier }) =>
      client.generateAuthUrl({
        scope: "openid email",
        state,
        nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: CodeChallengeMethod.S256,
        prompt: "select_account",
      }),
    exchange: (code, verifier) =>
      Future.attemptP(async () => {
        const { tokens } = await client.getToken({ code, codeVerifier: verifier })
        if (!tokens.id_token) throw new Error("Google's token response carried no id_token")

        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId })
        const payload = ticket.getPayload()

        if (!payload) throw new Error("Google's ID token carried no payload")
        return payload
      }).mapRej((error) => {
        log.error("Google sign-in failed", reason(error))
        return new Error(reason(error))
      }),
  }
}
