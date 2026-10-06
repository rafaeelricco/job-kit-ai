# worker-resume-guidance

Caller hands, inline or as the files the brief names, CandidateProfile, one or more JobProfiles, one ResumeGuidance
skeleton per JobProfile from `scripts/scaffold_guidance.py`, the Skill hold
section of `contract-match.md`, and `contract-resume-guidance.md`.

1. Open nothing but the files the brief names, and fetch nothing. Run no script
   and write no file: the caller runs `validate_guidance.py`.
2. Return each skeleton with `status` set on its `unknown` requirements:
   `not_evidenced` for a discrete skill, `unknown` for capability evidence;
   `profile_term` stays `null`. The skeleton already marks every direct Skill
   hold `held`, and the validator rejects any other `held`. Never add, drop,
   or reorder a requirement; never change a row the skeleton already marked
   `held`.
3. Leave `priority_roles` and `warnings` as the skeleton set them.
4. Emit the JSON array, then stop.
