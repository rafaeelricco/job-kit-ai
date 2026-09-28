# Execution and orchestration

Status: proposed · Updated: 2026-09-21 · Implementation: not implemented

The VPS-hosted API owns durable work intent and domain authority. Workers run as Docker Compose services on private networks, claim bounded work, and return validated results. There is no companion, extension, desktop agent, managed workflow service, or client-device wait in the selected design. See [Decision 0008](../decisions/0008-self-hosted-platform.md).

## Durable work ownership

An API command writes its domain transition, command receipt, and durable work intent in one PostgreSQL transaction. A dispatcher publishes that intent to `pg-boss` with a stable operation identity. Queue delivery may repeat or expire; application receipts and operation records remain authoritative beyond queue retention. Retrying the dispatcher can redeliver a message, but a worker checks the durable operation state and idempotency key before performing work, so duplicate dispatch does not create a second logical operation.

The worker records bounded progress and result references through authorized server commands. Keep provider calls, public-site requests, PDF parsing, and model inference outside the transaction. A crash resumes or reconciles from durable operation state and checkpoints. Replaying business history applies recorded decisions only; it never fetches a posting, calls a model, regenerates a document, or repeats an external action.

`pg-boss` handles one-off delivery and scheduled triggers on PostgreSQL. Recurrence, overlap, missed-run, and catch-up policy belongs to application-owned schedule records and is post-V1 for Gmail and recurring automation. Keep AI, document, and browser concurrency limits separate. Expose queue age, exhausted retries, and explicit provider waits to the user.

## V1 profile AI and provider boundaries

The user must connect one supported AI provider before creating an AI profile. The target adapters cover the methods identified in [provider research](../research/provider-connections.md): OpenAI device login or API key; Anthropic pasted setup token or API key; xAI device login or API key. Optional Claude setup-token generation may happen in the user's external terminal; Job Kit does not install provider tooling. Hosted authorization and compatibility are validation gates, not assumed capabilities.

The API decrypts credentials only through the server-side adapter required for the call. It passes a task's minimal selected inputs and validates output against versioned schemas. Credentials stay out of prompts, client storage, queue payloads, and logs. An expired or unavailable connection leaves the operation waiting; the user reconnects or explicitly switches provider. The system does not silently switch to another account or billing route.

TypeSafe matching is the only selected V1 platform-funded AI service. General platform-funded AI is post-V1 and requires a separate decision. If TypeSafe is unavailable, Evaluation uses only the user's configured AI fallback and identifies the engine in the result. This selected TypeSafe-to-user-AI fallback is deliberate; the platform does not choose a different user account or provider or change the billing route without the user. If both paths are unavailable, retain work until the user reconnects or explicitly switches their selected provider. The existing Python deterministic scorer remains available as an independent, reproducible result. Store the exact profile and posting revisions, provider and model, prompt/rubric version, evidence, output reference, duration, and applicable cost with each evaluation.

## Public scout and evaluation

The first scout starts from required search basics, captures a durable run ID, and persists source observations and postings before it hands evaluation work to the independent queue. Collection receives relevant search criteria, not a full private CV or candidate history. A posting remains useful discovery evidence even when matching is blocked or fails. Retries use immutable profile and source snapshots, and evaluations record immutable inputs.

Use supported direct HTTP adapters for Greenhouse, Lever, and Ashby where routes are documented. Public browser routes use the dedicated VPS [Browser Use worker](browser-workers.md) with an isolated Chrome per attempt. A source failure never silently changes transport, and login walls or challenges return blocked coverage. Opening a posting in the web UI does not rerun a model.

The catalog, supplied-company-link support, source proof, and concurrency capacity need measured experiments. Track the first source and numeric run thresholds as bounded blockers; do not treat unmeasured values as product guarantees. Discovery and matching retries are independent. Persist source provenance, incomplete coverage, and extraction failures so an evaluation failure cannot erase discovery history.

## Documents and future domain work

V1 accepts text-based PDF CVs. If text extraction is unreadable or the file is scanned, offer a manual questionnaire; OCR is outside scope. Keep extracted facts proposed until the user confirms them, and represent gaps as unknown. Profile and dossier imports require conflict review, deduplication, and provenance, with no invented events. Confirmed profile snapshots are immutable; required search basics include roles and locations/work model. Confirmed profile changes trigger reassessment while preserving earlier results.

Applications and Communications retain proposed domain invariants for later work, such as recording authorization, exact package inputs, uncertain external effects, and durable message identity. Their execution mechanisms are undecided. Gmail and recurring automation are post-V1. Application actions, including a copy-apply-prompt workflow, integrated preparation, and submission, are not selected in the V1 execution path. Existing local skill distribution remains unchanged.
