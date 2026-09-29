# Identity and controlled data

Status: proposed · Updated: 2026-09-21 · Implementation: not implemented

## Authority and identity

Each authenticated user receives one private [workspace](../domain/workspace.md), containing that user's [Candidate](../domain/candidate.md), provider connections, dossiers, and settings. In-house server auth owns Google OAuth and passwordless email code identities and sessions. Any verified email may sign in and provision a workspace. The existing SMTP account delivers email codes. Verified email is authoritative: an unverified email never joins an existing user.

Resolve the internal user and workspace from authenticated server context. Neither request-supplied workspace IDs nor model output establish ownership. Provision workspaces idempotently and scope records, object references, operations, and queries by workspace. Every API and worker command must recheck authorization at the server boundary. Database roles and service credentials remain private to services; the browser never receives database credentials.

## Separate connection lifecycles

Platform sign-in, user AI provider authorization, browser-site identity, and future mail authorization are separate connections. Signing out does not silently revoke an AI connection; disconnecting a provider blocks future use and begins recoverable credential cleanup. Gmail and recurring automation are post-V1. Website credentials and personal browser sessions are outside V1 public discovery.

Provider adapters own credential exchange, refresh, revocation, and encryption. Persist provider secrets encrypted with a server-held encryption key and key version; keep encryption keys outside the database and private file volumes. Restrict decryption to the adapter that needs the credential, redact secrets from logs and traces, and never put raw credentials in events, queue payloads, browser storage, or client responses. Anthropic/xAI hosted compatibility and permissions remain unproven gates in [provider research](../research/provider-connections.md); configuration support does not claim successful authorization.

## Content and deletion

Keep contact details, source CVs, generated documents, full prompts, mail bodies, and browser artifacts in separately controlled rows or private persistent volumes. These volumes are not part of the public nginx document root. Serve each object only after API authorization and workspace ownership checks. Encrypt sensitive provider credentials through the adapter layer; volume and backup encryption must follow the selected VPS deployment policy. Events hold the minimum decision metadata and references needed for reconstruction. References and hashes can still be sensitive.

Deletion removes controlled content and dependent projections, provider credentials, and queued payloads where supported. It also covers traces and backups according to a defined retention policy. Event replay after content deletion preserves lifecycle state and marks deleted evidence unavailable; it never recreates source content. A new evidence-dependent decision cannot invent deleted evidence. See [persistence](persistence.md) and [workspace rules](../domain/workspace.md#open-design-questions).

## Execution boundaries

Workers receive only bounded inputs needed for an operation. Public discovery receives search criteria and source revisions, not the full private CV or candidate history. User AI requests include only the profile or posting fields required for that task, over the selected provider's supported authorization path. Schema validation does not prove factual support or user authority; consequential profile facts remain proposed until confirmed.

The web app cannot access private volumes directly. Browser workers use dedicated fresh profiles and public pages only. A login wall or challenge is a blocked result, not permission to use personal cookies, log in, apply, or send messages. Model-provider failure leaves work waiting for explicit reconnect or manual switch; the platform never silently changes user accounts or billing routes.

## Observability

Use redacted logs, bounded retention, and OpenTelemetry traces and metrics. Show operation progress, queue age, and persisted-result status. Record retries and provider failure categories without logging secrets, raw CV content, full prompts, or mail bodies. Any cost reporting distinguishes user-funded AI calls from platform-funded matching.
