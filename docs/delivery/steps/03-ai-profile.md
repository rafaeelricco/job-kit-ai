# Set up a profile using AI

Status: proposed · Updated: 2026-09-21 · Implementation: not implemented

[Delivery roadmap](../roadmap.md) · [Candidate](../../domain/candidate.md) · [Execution architecture](../../architecture/execution.md)

## Outcome

After connecting their own AI in [onboarding](02-onboarding.md), the user starts with a text-based PDF or manual answers, completes guided intakes, and confirms a profile and search preferences usable by the first scout. They can import existing profile and dossier data with conflict review, then edit and export the confirmed profile in an editable form.

## Current state

The [profile skill](../../../skill/job-profile/SKILL.md) creates profiles; the app [loads and edits existing profile files](../../../packages/frontend/src/module/profile/components/profile-gate.tsx). The guided AI setup journey is not implemented.

## V1 boundaries and dependencies

Follow [Candidate](../../domain/candidate.md) rules for evidence, unknowns, and confirmation. AI proposes information; the user confirms candidate facts. Continue from [onboarding](02-onboarding.md), which requires a verified own-AI route before profile creation. Profile generation uses the selected user connection through the hosted encrypted credential adapter. If that connection fails or reaches quota, saved work waits for reconnect or an explicit manual switch; it never silently changes accounts or billing routes. Supply the confirmed profile and search basics required by the [first scout](04-first-scout.md). AI execution follows the [execution architecture](../../architecture/execution.md).

Use the [profile skill](../../../skill/job-profile/SKILL.md) and [questionnaire](../../../skill/job-profile/references/formats/format-questionnaire.md) as the reference for intake coverage. Adapt them to the app's authenticated workspace; local folder selection and machine Profile-root activation are not user-facing setup stages.

## Setup journey

1. **Explain ownership.** Before collecting information, briefly explain: “Your information belongs to you. Once setup is complete, you can export your profile and change its configuration however you want, including using it outside this app.”
2. **Ask for a CV.** Offer PDF upload first, with an explicit option to continue without one and answer manually. Extract only information supported by text in the supplied PDF, and present it as a draft. Scanned or unreadable PDFs receive a clear manual-entry option; V1 does not run OCR.
3. **Guide the intakes.** Cover the full questionnaire in manageable sections: identity and basics; experience, projects, skills, languages and education; compensation, availability and work eligibility; job-search preferences and sources; and CV tailoring preferences. Ask eligibility questions separately for each relevant country. Show extracted values and defaults as proposals to confirm, edit or skip.
4. **Collect optional additions.** Ask for interview-story names and their associated employer or project, then any observations the previous sections did not cover. Story narratives and unsupported impact claims are outside this setup.
5. **Import existing data when requested.** Support existing profile and dossier data with explicit source provenance. Preview duplicates and conflicts, let the user resolve them, and preserve known source dates and identifiers. A partial Markdown corpus is not complete event history: never invent events, transitions, or dates to fill gaps.
6. **Review and confirm.** Show the proposed profile, search configuration and remaining gaps. Let the user correct answers before confirming. Explicit skips remain unknown; the first scout requires confirmed target roles, locations, and work models, and any other missing run prerequisites must be identified before handing off to search.
7. **Complete setup.** Make profile editing, configuration and editable export available, and offer the first scout as the next action.

Cover every user-owned field without requiring every field to contain a value. Do not interpret silence as confirmation, infer legal authorization or language proficiency, or collect demographic/EEO data. CV tailoring preferences do not trigger CV generation during setup.

## Acceptance criteria

- Before intake, the user sees a brief explanation of ownership, export and configuration.
- The user can start with a text-based PDF or complete the same guided intake without one; a scanned or unreadable PDF falls back to manual entry, with no OCR.
- The intakes cover the profile-init questionnaire, with explicit confirmation, correction or skipping of proposed values and defaults.
- The user can review, correct, and confirm proposed information.
- Unsupported claims remain unconfirmed and missing facts unknown.
- Own-AI unavailability preserves saved work and offers reconnect or an explicit manual switch; generation never silently changes account or billing route.
- Profile and dossier imports preview conflicts and duplicates, retain provenance and known source dates, and do not invent events from incomplete source history.
- Interrupted intake or generation can resume without losing saved answers or existing confirmed information.
- The resulting profile has confirmed target roles, locations, and work models required for the first scout; other missing prerequisites remain visible.
- After setup, the user can edit the profile and search configuration and export them in an editable form compatible with existing profile data.

## Decisions for this step

PDF-first input with a manual alternative, no OCR, full guided questionnaire coverage with explicit skips, conflict-aware profile and dossier import, and user-controlled editing and editable export are requirements for this step. A verified own-AI route is required before profile creation.

Each confirmation publishes a new immutable whole-profile snapshot. A confirmed change automatically requests reassessment of affected current matches; it never edits an older snapshot or assessment. Before implementation, define PDF text-extraction and unreadable-file behavior, the exact first-scout prerequisites beyond roles/locations/work models, and compatibility details for existing profile and dossier imports and editable export. Do not change the selected own-AI prerequisite or extend CV intake to non-PDF formats or OCR. Use [Candidate](../../domain/candidate.md), [provider research](../../research/provider-connections.md), and the [repository architecture](../../architecture/repository.md) for the remaining implementation details.
