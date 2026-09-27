# Check matches

Status: proposed · Updated: 2026-09-21 · Implementation: not implemented

[Delivery roadmap](../roadmap.md) · [Evaluation](../../domain/evaluation.md) · [Discovery](../../domain/discovery.md) · [Candidate](../../domain/candidate.md)

## Outcome

The backend evaluates persisted jobs against the user's confirmed profile using TypeSafe AI (Jev) as the platform-funded default and the user's selected AI as fallback. In the existing dossiers UI, the user sees current matches ranked by fit and recency, understands the evidence, and can open the posting.

## Current state

The app [displays dossiers](../../../packages/frontend/src/module/scout/components/dossier.tsx); deeper matching runs through [job-match](../../../skill/job-match/SKILL.md). The complete hosted match-review journey is not implemented.

## V1 boundaries and dependencies

Use [Evaluation's](../../domain/evaluation.md) versioned assessments and evidence from [Candidate](../../domain/candidate.md) and [Discovery](../../domain/discovery.md). Keep discovery coverage, fit, and confidence distinct. Continue from the [first scout](04-first-scout.md) into the existing dossiers table, cards, filters, details, export, and Open posting action. Application-prompt handoff follows V1.

## Backend matching

Replicate the match-review stages of `/job-match --typesafe --all` in backend workers, following the existing [flow](../../../skill/job-match/references/flows/flow-match.md) and [MatchingPolicy](../../../skill/job-match/references/contracts/contract-match.md). Resume guidance is outside this step.

- Consider all eligible persisted dossiers in the user's workspace, not only new dossiers. Preserve the command's exclusions for dropped dossiers and postings recorded as dead. Use stored posting snapshots without fetching sources again.
- Pin each assessment to the confirmed profile revision, posting snapshot, matching policy, and engine/scorer versions. Reuse a current accepted assessment for identical inputs; reassessment creates a new request.
- Apply the existing hard filters and extraction rules before classification. Retain blocked dossiers with their reasons; do not assign them a fit score.
- Use TypeSafe AI's Jev classifier to judge profile alignment with the position and its requirements. Reuse the existing [adapter](../../../skill/job-match/scripts/typesafe_match.py) and its confidence-floor behavior. Call it from the backend with a platform-held key.
- Keep final scoring deterministic through the existing [Python scorer](../../../skill/job-match/scripts/score.py). Preserve factor weights, decision bands, source-backed evidence, and unknown values. Jev does not generate the final 0–100 score.
- Preserve semantic validation for scores of at least 75, confidence below 0.7, or uncertain classification factors. Rescore corrected results before accepting and ranking them.
- When TypeSafe is unavailable, use the user's selected AI route and record and display the engine used. Never switch automatically between that user's providers, accounts, or billing routes. If the selected route is unavailable, keep the assessment pending for reconnection or an explicit manual route switch. This is an intentional difference from the explicit CLI flag's fail-on-provider-error behavior.

Consume the durable requests from step 04 independently of scout completion. Persist assessment progress and results so users can reopen the page while matching continues. Retry failed matching without rerunning discovery or duplicating accepted results. Provider or validation failures must not discard postings or completed assessments.

## Dossiers page

Use persisted backend assessments for the table, cards, and detail view. Opening the page reads results and progress; it does not rerun classification.

Default ordering is current accepted match score descending, then posting publication date descending. When publication date is unknown, use first-discovered time and label it accurately. Use the stable dossier ID as the final tie-breaker. Apply this order before pagination.

Place dossiers without a current accepted score after ranked matches, ordered by the same recency rule. Keep pending, failed, blocked, unscored, and outdated states visible and distinguishable. An outdated score may remain visible as historical context but must not rank as a current match.

Show the 0–100 fit score, decision band, evidence coverage, and posting date or discovery date. Keep the scout's 0–10 required-skill coverage separately labeled. Details expose factor breakdowns, supporting evidence, strengths, gaps, blockers, meaningful unknowns, and the profile/posting revisions assessed.

Offer retry for failed assessments and reassessment for outdated ones. A confirmed profile change triggers reassessment of affected dossiers; the new request uses the new immutable profile revision and never rewrites the previous assessment. A provider failure leaves new work pending and prior results/history visible.

## Acceptance criteria

- All eligible persisted dossiers can be evaluated, including those beyond the first page and those with a status other than new.
- TypeSafe judgments feed the existing deterministic scorer and required validation stages.
- Hard-filtered dossiers retain their reasons without receiving a fit score.
- Current matches sort by score first and recency second, consistently across pagination.
- Results show supporting evidence and meaningful unknowns.
- Missing scores are not displayed as zero.
- Pending, failed, and outdated evaluations are distinguishable.
- Low-confidence classifier answers remain unknown; failed validation cannot produce an accepted ranked result.
- TypeSafe is the platform-funded default; when unavailable, fallback uses only the user's selected AI route and identifies the engine. There is no automatic user-account or billing-route switch. Failed or unavailable fallback work can be retried independently of scout.
- Reopening the page restores persisted results and progress without initiating classification.
- The user can open a posting from the dossier interface; doing so does not start matching or an application flow.
- A confirmed profile change schedules reassessment against the new profile revision while preserving prior assessments and dossier history.
- Assessments and dossier queries remain isolated by workspace.
- A match score never authorizes submission.

## Decisions for this step

Use TypeSafe AI (Jev) as the platform-funded default classifier, preserve deterministic scoring and semantic validation, and use the user's selected AI as fallback. Deliver match review without resume guidance or application-prompt handoff. Rank current assessments by score, then recency; keep incomplete and outdated results visible after ranked matches. Confirmed profile changes trigger new assessments without rewriting accepted history.

Before backend implementation, resolve the precise condition that marks TypeSafe unavailable, the fallback output contract and display, and which confirmed profile changes invalidate which assessments through [Evaluation's open questions](../../domain/evaluation.md#open-design-questions). The selected fallback source and automatic reassessment on confirmed profile changes are already V1 requirements.
