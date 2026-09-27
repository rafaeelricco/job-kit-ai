# worker-resume-guidance

Caller pastes CandidateProfile, one or more JobProfiles, one ResumeGuidance
skeleton per JobProfile from `scripts/scaffold_guidance.py`, the Skill hold
section of `contract-match.md`, and `contract-resume-guidance.md`.

1. Open nothing and fetch nothing.
2. Return each skeleton with `status` set on its `unknown` requirements:
   `not_evidenced` for a discrete skill, `unknown` for capability evidence;
   `profile_term` stays `null`. The skeleton already marks every direct Skill
   hold `held`, and the validator rejects any other `held`. Never add, drop,
   or reorder a requirement; never change a row the skeleton already marked
   `held`.
3. Fill `priority_roles` with exact candidate roles matched on role type and
   seniority only; none → add `no_relevant_role` to `warnings`.
4. Emit the JSON array, then stop.
