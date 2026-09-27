# Onboarding

Status: proposed · Updated: 2026-09-23 · Implementation: not implemented

[Delivery roadmap](../roadmap.md) · [Workspace](../../domain/workspace.md) · [Candidate](../../domain/candidate.md) · [Design canvas](https://claude.ai/artifact/C253CuB3qV6Ekuv2ZYWCSe) (private; pages "Option A" and "Settings · AI")

## Outcome

A signed-in pilot user understands what Job Kit does, connects one of the supported own-AI routes, and can begin profile creation without installing or enrolling a companion.

## Current state

The app has [folder-access consent](../../../packages/frontend/src/module/access/access-gate.tsx), not guided account onboarding or hosted provider connections. The [settings dialog](../../../packages/frontend/src/module/profile/components/settings-dialog.tsx) has profile and search panels only; it has no AI panel, and every panel renders behind the profile gate.

## V1 boundaries and dependencies

Own setup progress and navigation after [login](01-login.md). Profile content and confirmation belong to [AI profile setup](03-ai-profile.md), following [Candidate](../../domain/candidate.md) rules. [Workspace](../../domain/workspace.md) owns provider connections.

Job Kit login and AI-provider authorization are separate operations. V1 is web-only and runs platform services on the owner's VPS. A provider connection is required before profile creation. Hosted encrypted credential adapters serve profile generation and browser-agent work. Connection state, capabilities, and credential references may be stored; raw provider credentials must not enter progress records, logs, analytics, or model inputs. Follow [provider-connection research](../../research/provider-connections.md), [execution architecture](../../architecture/execution.md), and the accepted [self-hosted platform decision](../../decisions/0008-self-hosted-platform.md).

The provider target is OpenAI, Anthropic and xAI (Gemini was dropped on 2026-09-27) with these methods from the reviewed `commit-tools` implementation at commit `07321aa31a734bbe6e52fa0776666d1df81eaee9`:

- **OpenAI:** device login or API key.
- **Anthropic:** pasted setup token or API key. A user may generate an optional setup token in an external terminal; Job Kit does not install a companion or local executor.
- **xAI:** device login or API key.

These are target methods, not claims of successful hosted compatibility or authorization. The local CLI's implementation does not establish a supported multi-tenant hosted integration. Each provider and method must pass its technical and product-authorization proof gates before it can be advertised as ready. Preserve the documented caveats in [provider research](../../research/provider-connections.md); do not silently drop a provider or substitute another account or billing route.

## UX research and references

Researched 2026-09-21. The recommendations adapt published UX guidance and inspected source code; they have not been validated with Job Kit users.

- **Explain only what helps users begin.** Nielsen Norman Group recommends brief onboarding, necessary customization, and contextual instruction instead of lengthy feature tours. For Job Kit, use one visual workflow overview and explain each setup request where it occurs. Its research focuses on mobile onboarding; applying it here is a design hypothesis to test. [Onboarding components and techniques](https://www.nngroup.com/articles/mobile-app-onboarding/)
- **Connection feedback:** Hermes desktop and web flows show useful patterns such as visible authorization progress, selectable device codes, expiry, cancellation, retry, and model confirmation. Reuse those interaction patterns where a provider route supports them; Job Kit does not adopt Hermes's desktop companion or assume that all providers share one OAuth flow. [Desktop onboarding flow](https://github.com/NousResearch/hermes-agent/blob/274bc7b8f613c299b4f59160bacf8a19010f7003/apps/desktop/src/components/onboarding/flow.tsx), [OAuth modal](https://github.com/NousResearch/hermes-agent/blob/274bc7b8f613c299b4f59160bacf8a19010f7003/web/src/components/OAuthLoginModal.tsx)
- **Provider-specific methods:** the inspected `commit-tools` authentication source distinguishes OpenAI and xAI device authorization, Google's OAuth path, Anthropic setup-token use, and API-key paths. This is an implementation reference only; it does not establish that those flows are approved for a hosted consumer product. [Authentication source](https://github.com/rafaeelricco/commit-tools/tree/07321aa31a734bbe6e52fa0776666d1df81eaee9/src/infra/auth)

## Proposed journey

### 1. Show what Job Kit does

Present one overview with a clearly labeled sample:

**Your profile and preferences → relevant opportunities with match explanations → open a posting from your dossiers.**

Use representative product visuals: a profile summary and a dossier with supporting evidence. Include short text equivalents. Do not require a carousel, video, or animation to understand the workflow.

Explain that AI proposes profile information for the user to confirm. State the V1 boundary: users can inspect matches and open postings; application-prompt handoff, preparation, and submission come later.

The primary action is **Connect my AI**. Let users continue immediately and revisit the overview later.

### 2. Connect AI

Show progress through **Overview → Connect AI → Create profile** as a full-screen guided wizard with no app chrome until setup is done. This layout was selected on 2026-09-23 over an in-app checklist and a split screen, which remain on the design canvas as archived options.

The Connect AI screen offers one card per provider. Each card names the provider, the sign-in it uses, and its billing basis in one quiet line (for example, "Uses your ChatGPT plan"). It also states once what data the provider receives. API-key entry is a secondary text link below the cards, not a peer option. Keep model and effort customization out of this screen; the recommended default applies until the user changes it in settings.

Choosing a provider opens its authorization page in a new tab where one exists, and Job Kit shows a dialog for that route:

- **OpenAI and xAI:** the dialog shows the device code as selectable text with **Copy**, the time left, a visible waiting state, and a link to reopen the provider tab if it was blocked.
- **Anthropic:** no tab opens. The dialog shows the `claude setup-token` command with **Copy** and a secure field to paste the token. It does not require a Job Kit installation.
- **API key:** the dialog asks for the provider and a secure key field, and states that the key bills the provider's API account rather than a chat plan.

Every dialog can be cancelled. It ends in one of two states: connected, or a failure with a specific next action (see step 3).

Keep authorization separate from readiness. After authorization, verify the hosted adapter can make the intended request, validate the response, and report available capabilities. An opened browser, completed redirect, accepted key, or token exchange alone does not establish a working connection. The connected state shows the provider, method, account when available, model, connection state, and billing route without exposing the secret.

**Create my profile** continues to step 03 only when the selected route is both technically verified and cleared for the intended product use. If a route has not passed both proof gates, show that it is not ready and offer another explicitly selected route. Never auto-switch accounts or billing. The full provider target remains a V1 proof requirement.

### 3. Recover and resume

Allow users to pause and return without completing setup. Save completed milestones and the selected route, but never persist raw credentials in setup progress. Recheck provider state on return.

Give a specific next action for denied authorization, expired codes, network failure, revoked credentials, invalid keys, and exhausted quota. Offer retry, reconnect, or an explicit switch to another supported route without restarting the entire journey. A switch is a user decision and must identify any change in account or billing.

Cancel an abandoned authorization attempt and ignore late UI results from superseded attempts. Expired attempts receive fresh authorization rather than reusing old codes. Gmail, recurring automation, and application-site permissions belong to later delivery steps.

### 4. Manage the connection in settings

Add an **AI** panel to the existing settings dialog, second in the rail after Profile. It must render outside the profile gate, because a user can have a connection before a confirmed profile exists.

- **Status:** show the provider, sign-in method, masked account, billing route, and live connection state with when it was last checked. **Test connection** reruns the readiness check.
- **Model and effort:** list only models the connection's verified capabilities allow. Keep a model the account offers but Job Kit cannot use visible and disabled, with the reason. Label the recommended default. Effort offers the levels the selected model supports. Both save through the panel's **Save** and **Reset**, like the other settings panels, and apply to work started after the save.
- **Reconnect:** when the connection is revoked, expired, or out of quota, the panel shows the reason and a primary **Reconnect** that reuses the route's onboarding dialog.
- **Switch provider:** pick another provider, complete its onboarding dialog, and pass its readiness check while the current connection stays in use. A confirmation then shows the billing change and the new model and effort defaults. Only after confirmation does new work use the new provider. Running work finishes on the connection it was pinned to. The previous credentials stay usable only by those pinned attempts and are deleted once every one of them reaches a terminal state. Cancelling at any point leaves the current connection unchanged. V1 keeps one active connection per workspace.
- **Disconnect:** after confirmation, delete the credentials. Profile drafting and new matching wait until another AI connects. Confirmed profile facts and dossiers remain available, and the panel shows a **Connect an AI** empty state.

## Acceptance criteria

- A new user can explain what Job Kit produces, why an AI connection is needed, and what V1 does with a match.
- One visual overview communicates the V1 journey using labeled sample content.
- Onboarding lists OpenAI, Anthropic, and xAI with the target connection methods specified above; the target set is not silently reduced.
- Each advertised-ready provider method passes both hosted technical verification and the applicable product-authorization check. Unproven methods cannot be represented as ready.
- A user can complete a proven provider route through guided UI, including device handoff or secure key/token entry as applicable.
- No companion installation, device enrollment, local executor, or companion wait is part of onboarding.
- Denial, expiry, cancellation, failed browser opening or clipboard access, credential rejection, and quota exhaustion have visible recovery actions.
- Interrupted setup preserves completed milestones without exposing credentials and rechecks connection readiness before continuing.
- Returning users with completed setup reach the product; a later connection failure prompts reconnection without replaying the introduction.
- The settings AI panel shows the active connection's provider, method, billing route, and state. From it a user can test, reconnect, switch provider with an explicit billing confirmation, disconnect, and change model and effort among verified-compatible options.
- A provider switch never takes effect before the new connection passes readiness and the user confirms it. Work already running keeps its pinned connection.
- Keyboard and screen-reader users can complete setup. Status is conveyed in text, copy actions announce their result, and reduced motion preserves all information.
- Credentials are encrypted in hosted storage and do not appear in logs, analytics, or setup progress. If a route cannot meet this requirement, it remains blocked.

## Decisions for this step

The three provider targets, listed methods, hosted encrypted credential adapters, and own-AI prerequisite are selected. API keys are the first live routes; the subscription sign-ins stay unproven because the commit-tools flows impersonate each provider's own CLI. The guided-wizard layout, per-provider dialogs, secondary API-key entry, and single active connection with verify-then-confirm switching were selected on 2026-09-23. Technical support and provider authorization are still separate proof gates. Step 02 ends when a selected route is verified and profile creation can begin; profile confirmation remains owned by step 03.

Use [provider-connection research](../../research/provider-connections.md) to resolve compatibility and authorization evidence. Keep unresolved provider proofs and any required measured limits as bounded blocker tickets in the [delivery backlog](../linear-backlog.md); do not turn a research recommendation into a product guarantee.

## Validation before implementation

Prototype the overview, at least one supported device route, API-key entry, the Anthropic external setup-token paste path if that route is authorized, and the settings AI panel's switch and model flows. Test whether first-time job seekers understand the product and can connect without assistance.

Exercise successful and denied authorization, blocked browser opening, failed clipboard access, expiry, cancellation followed by retry, refresh during setup, invalid or revoked credentials, quota exhaustion, and an already connected returning user. Verify route/account/billing labels, encrypted credential handling, credential-free logs, keyboard navigation, focus after browser return, screen-reader announcements, and reduced motion. A UI success state is not proof that hosted compatibility or provider authorization has passed.
