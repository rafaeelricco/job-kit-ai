# Login

Status: accepted · Updated: 2026-09-22 · Implementation: in progress (sign-in and provisioning done; record isolation per workspace is R1C-234)

[Delivery roadmap](../roadmap.md) · [Workspace](../../domain/workspace.md) · [Identity and data](../../architecture/identity-and-data.md)

## Outcome

An approved pilot user signs in with Google or a passwordless email one-time code and reaches one private workspace.

## Current state

Sign-in uses the in-house auth from PR #143: server sessions (`sid`), emailed one-time codes, and Google OIDC (authorization code + PKCE, state, nonce). Only the Google token exchange and ID token check use a library: `google-auth-library`, wrapped in `packages/backend/src/lib/google-oidc.ts`.

## Design reference

The primary reference is the [TypeSafe login page](https://console.typesafe.ai/login), inspected on 2026-09-21. Preserve its split layout, proportions, spacing, typography treatment, control dimensions, borders, and visual hierarchy. Adapt its email controls to Job Kit's passwordless request-code and verify-code flow, and apply Job Kit branding; the reference's email-action sequence is not a requirement.

- Match the split layout: a dark decorative pixel-pattern panel on the left and a light login panel on the right.
- Preserve the reference's proportions, spacing, typography treatment, control dimensions, borders, and visual hierarchy while adapting the content for Job Kit.
- On the initial screen, use this order: logo, welcome heading, Continue with Google, “or” divider, email field, **Send code**, and legal notice.
- After **Send code**, show a one-time-code field and **Verify code**, with **Resend code** and **Change email** recovery actions. Do not show separate **Continue** and **Email me a code instead** email actions.
- Replace the TypeSafe logo and name with Job Kit branding and “Welcome to Job Kit”. Use Job Kit brand colors, a neutral email placeholder, and Job Kit legal destinations.
- Include Google and email authentication. Match responsive behavior against the reference during implementation.

## V1 boundaries and dependencies

Sign-in is open to any verified email. Use the in-house server auth for Google sign-in and passwordless email codes; there is no password login. A user is keyed by a verified email: an emailed code, or Google's `email_verified`. Unverified emails never join an account. Google and email sign-in methods are not separate candidates when they resolve to the same authenticated user. The app never links an account on an unverified email. Provision one private workspace per authenticated user, idempotently. Follow [Workspace](../../domain/workspace.md) and [identity and data](../../architecture/identity-and-data.md) for scope and access rules. Login provides the authenticated workspace for [onboarding](02-onboarding.md).

## Acceptance criteria

- The login screen preserves the reference layout at equivalent desktop and mobile viewport sizes, with Job Kit branding and the email controls required for request-code and verify-code states.
- Google sign-in is available. Email sign-in requests a one-time code, then verifies it; resend and change-email actions recover the flow.
- No TypeSafe branding, example email address, or legal destinations remain.
- In-house email codes are passwordless, expire, are single-use, and can be resent or recovered.
- Google and email identities resolve through verified email only. An unverified email cannot claim an existing user or workspace.
- New and returning users reach the correct workspace.
- Repeated and concurrent sign-in or provisioning requests do not create duplicate workspaces.
- Cancelled or expired authentication is recoverable.
- A user cannot access another user's records.

## Decisions for this step

Use the accepted self-hosted platform auth direction and configure in-house auth for Google OAuth and passwordless email codes using [auth research](../../research/platform-auth.md). Implement and verify the separate send-code and verify-code states, including resend and change-email recovery. Link accounts by verified email only.
