# Answer law

Every prefilled value comes from the Fact file named here. Read it; stop if
unreadable. Absent is absent — never infer, never answer from a prior draft or
memory. Never read story bodies.

| Value                                                        | Read from                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| language level                                               | `data/languages.yaml` `languages[].level` with `name`                                                                                                             |
| salary, notice, authorization, employment routes, relocation | `data/job_search.yaml`                                                                                                                                            |
| remote / in-person                                           | `data/job_search.yaml` `work_model`                                                                                                                               |
| name, email, phone, site, country                            | `data/basics.yaml`                                                                                                                                                |
| LinkedIn, GitHub                                             | `data/profiles.yaml`                                                                                                                                              |
| roles, employers, dates, work bullets, project depth         | `data/experiences.yml`                                                                                                                                            |
| public portfolio projects                                    | `data/projects.yml`                                                                                                                                               |
| skills / stack inventory                                     | `data/skills.yaml`, then `data/skills-by-company.yml` when present                                                                                                |
| story claims and verified outcomes                           | `data/stories/*.md` frontmatter only: `claim`, `evidence.*`, `impact_numbers` whose `verified` is not `unverified` and whose `kind` is `outcome`, and `never_say` |
| which CV to attach                                           | `data/cvs.yaml` `adapt_per_vacancy` (absent → true) and `base` (filename under `cv/`)                                                                             |

## Resolution order

Classify the field first: a demographic or EEO question takes rule 6 only,
never rules 1–5. Availability commitments — on-call, hours overlap, background
check, assessment, start on notice — take rules 1–3, then rule 7.
Every other field takes the first rule that yields a value;
the package prints the rule as `source`. Nothing waits for the operator.

1. A Fact file above prints it → that file.
2. "Derived answers" below computes it → `derived`.
3. `data/job_search.yaml` `screening_defaults` prints it (`on_call`,
   `hours_overlap`, `timezone`, `consent_to_data_processing`, and the legacy
   `willing_to_complete_assessments`, `willing_to_undergo_drug_tests`, and
   `willing_to_undergo_background_checks` the `candidate.yaml` move carries) →
   `data/job_search.yaml`, or a `data/answers.yaml` `qa[]` row does →
   `data/answers.yaml`. A `qa[]` row applies when its
   `question` equals the form label after normalizing both — lowercase,
   non-alphanumeric runs → one space, trim — and its `scope` holds: `country`
   equals the jurisdiction the label asks about, else the posting's printed
   hire-from country; `ats` equals the dossier's `ats` per
   `job-store/references/schemas/schema-dossier.md` "ATS family"; `company`
   slug-equals frontmatter `company`; absent scope always
   holds. A row with an empty `answer` never holds. Several rows hold → the one
   with a scope, then the latest `confirmed_at`; a tie skips rule 3. Never
   adapt, paraphrase, or merge a `qa[]` answer.
4. The field wants composed prose → author it under `./contract-prose.md` → `authored`.
5. A required application-terms or privacy checkbox needed to process this
   application, with no answer above, also takes `Yes` → `default`.
   This default excludes optional marketing and unrelated consent.
   Stage the value only; acceptance occurs in job-apply §5, never in prep.
6. Demographic or EEO → the option that declines to answer → `declined`;
   required with no such option → skip the posting.
7. Still nothing: optional → blank; required → skip the posting, reason
   `no answer for {label}`.

A dropdown or radio takes the option whose label matches the value; no match →
the option meaning other, not listed, or prefer not to say; none → rule 7.
Before staging any prose, enforce every `never_say` ban below.

## Derived answers

- Years of experience, only for an ask with no skill or domain qualifier:
  run `job-match/scripts/years.py` (launcher per
  `job-match/references/flows/flow-match.md` **score**) on every role's `date`
  in `data/experiences.yml`. `years: null` → the count is unavailable, never
  0, and the field follows rule 7. An ask qualified by a role title
  (`as a software engineer`) passes only the roles whose `position` names that
  title. An ask qualified by a skill or domain (`of Python`, `leading teams`)
  is not derived — no Fact file prints per-skill dates — and follows rule 7.
  `N+ years?` is `Yes` iff the derived count ≥ N.
- First / last name: `basics.yaml` `name` split at the first space.
- City / state / country: `basics.yaml` `country` when present; else
  `location` split on commas, the last part taken as the country only when it
  names one (a form option or a `legal_authorization.jurisdictions[].country`
  value) and the first part as the city. A `location` with one part or a
  non-country last part (`London`, `Austin, TX`) yields no country → rule 7.
  Country of residence is that country.
- Earliest start date: today plus `availability.notice_period`; `Immediately`
  when the notice is zero.
- Weekly hours: the posting's stated hours; full-time with none printed → 40.
- Seniority self-label: the current role's `position` in `data/experiences.yml`.
- Salary period: `salary_range_usd` is yearly. A monthly ask divides the
  figure by 12, rounded to 100; an hourly ask divides by 2080, rounded to 5.

- Language level is the printed self-assessment, paired with the language name. Never assert a certification, test score, or bare letter grade.
- Never name an employer's client. Use only a domain phrase already present in a Fact file.
- Remote is `Yes` when `work_model.remote` is true, else `No`. In-person is `Yes` when `work_model.onsite` or `work_model.hybrid` is true, else `No`. No `work_model` flag true → neither is an answer. Relocation uses `availability.open_to_relocation` verbatim; an empty key is no answer.
- Demographic and EEO questions are answered only by declining; never invent, recall, or read them from a file.
- Disqualifying questions get the truthful answer, even when it disqualifies.
- Every `never_say` entry is a run-global ban on outbound free-text, exact or semantically equivalent.
- A value no file prints and no rule derives follows the resolution order; never estimate one.
- Say a current-role gap out loud: `<skill> is real but predates my current role, treat it as secondary.`

## Salary expectation

Keep two bands separate:

- `ours` = `salary_expectations.salary_range_usd` (`ours.min`, `ours.max`), the accepted band, not the answer.
- `job` = USD figures printed by the posting (`job.min`, `job.max`); either may be absent.

If the posting prints figures in another currency, answer `job.max` in that
currency (`job.min` when only it is printed) — never convert. If `ours` is
empty and the posting prints none, the field follows resolution rule 7.

Otherwise use the first matching row:

| #   | Condition                             | Figure                    |
| --- | ------------------------------------- | ------------------------- |
| 1   | no `job.min`, no `job.max`            | `ours.max`                |
| 2   | both printed, `job.min >= ours.max`   | `(job.min + job.max) / 2` |
| 3   | both printed                          | `job.max`                 |
| 4   | `job.min` only, `job.min >= ours.max` | `job.min`                 |
| 5   | `job.min` only                        | `ours.max`                |
| 6   | `job.max` only                        | `job.max`                 |

Rows 2 and 4 meet an outpaying posting; never substitute an `ours` number for a `job`
operand. One-figure asks use the figure. Range asks use that figure as high and `job.min`
as low when printed and no higher than high, otherwise high. No posted number uses the
stored range.

Before staging any salary answer, including a prepared value, check the result
is `>= job.min` and `<= job.max` wherever those bounds exist, comparing figures
in the same currency and period. For USD, its annual equivalent must also be
`>= ours.min` when that floor is present. Check both endpoints of a range.
Name any broken bound and follow resolution rule 7 directly; never fall through
to another answer source.

A midpoint of `ours` answers no row.

## Sponsorship and authorization

Classify the question before answering. Match the asked jurisdiction in
`legal_authorization.jurisdictions[]` by code or clear synonym (`us`, `eu`, `uk`, `br`).
No matching row means no answer exists.

- Authorization, legally allowed, or permit → `work_authorization` or `legally_allowed_to_work`, verbatim.
- Requires visa → `requires_visa`, verbatim.
- Requires sponsorship → `requires_sponsorship`, verbatim.
- Working remotely or engagement model → `employment_routes`.

If no jurisdictions list exists, read only the legacy keys for the asked jurisdiction:

| Jurisdiction | Legacy keys                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| US           | `us_work_authorization`, `legally_allowed_to_work_in_us`, `requires_us_visa`, `requires_us_sponsorship`                 |
| EU           | `eu_work_authorization`, `legally_allowed_to_work_in_eu`, `requires_eu_visa`, `requires_eu_sponsorship`                 |
| Canada       | `canada_work_authorization`, `legally_allowed_to_work_in_canada`, `requires_canada_visa`, `requires_canada_sponsorship` |
| UK           | `uk_work_authorization`, `legally_allowed_to_work_in_uk`, `requires_uk_visa`, `requires_uk_sponsorship`                 |

Missing or empty keys mean no answer (resolution rule 7). Never answer one jurisdiction from another. A
binary question gets the literal truthful value. Never answer `No` to sponsorship just
because EOR exists. Put nuance in a free-text notes field once. Do not volunteer
sponsorship need to an engagement-only question. If possession versus need is ambiguous,
use the more specific field; never blend them into a hedge.
