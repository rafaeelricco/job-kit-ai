# Answer law

Every prefilled value comes from the Fact file named here. Read it; stop if
unreadable. Absent is absent — never infer, never answer from a prior draft or
memory. Never read story bodies.

| Value                                                                                                                                                       | Read from                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| language level                                                                                                                                              | `data/languages.yaml` `languages[].level` with `name`                                                                                                             |
| salary, bonus, equity, salary history, notice, employment routes, contractor entity, relocation, availability commitments, working hours, optional consents | `data/job_search.yaml` `salary_expectations`, `salary_history`, `employment_routes`, `availability`, `consents`                                                   |
| work authorization, visa, sponsorship                                                                                                                       | derived: **Sponsorship and authorization** below                                                                                                                  |
| remote / in-person                                                                                                                                          | `data/job_search.yaml` `work_model`                                                                                                                               |
| name, legal name, birth date, email, phone, address, time zone, site, residence country, citizenships                                                       | `data/basics.yaml`                                                                                                                                                |
| public network profiles (LinkedIn, GitHub, X, …)                                                                                                            | `data/profiles.yaml` row whose `network` the label names                                                                                                          |
| roles, employers, dates, work bullets, project depth                                                                                                        | `data/experiences.yml`                                                                                                                                            |
| education level, degree, field, grade, coursework                                                                                                           | `data/education.yaml`                                                                                                                                             |
| public portfolio projects                                                                                                                                   | `data/projects.yml`                                                                                                                                               |
| skills / stack inventory; primary language                                                                                                                  | `data/skills.yaml` (`primary` for a primary-language ask), then `data/skills-by-company.yml` when present                                                         |
| story claims and verified outcomes                                                                                                                          | `data/stories/*.md` frontmatter only: `claim`, `evidence.*`, `impact_numbers` whose `verified` is not `unverified` and whose `kind` is `outcome`, and `never_say` |
| which CV to attach                                                                                                                                          | `data/cvs.yaml` `adapt_per_vacancy` (absent → true) and `base` (filename under `cv/`)                                                                             |

## Resolution order

Classify the field first: a demographic or EEO question takes rule 6 only,
never rules 1–5. Availability commitments — on-call, hours overlap, background
check, assessment, drug test, in-person interview, travel, equipment, start on
notice — take rules 1–3, then rule 7; `job_search.yaml` `availability` prints them.
Every other field takes the first rule that yields a value;
the package prints the rule as `source`. Nothing waits for the operator.

1. A Fact file above prints it → that file.
2. "Derived answers" below computes it → `derived`.
3. A `data/answers.yaml` `qa[]` row does → `data/answers.yaml`; `pending[]`
   rows never answer. A `qa[]` row applies when its
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
   An optional consent (recruiter texts or WhatsApp, data retention or talent
   pool, interview recording or transcription, marketing use) takes its
   `job_search.yaml` `consents` key by rule 1; with none it stays unticked.
   Stage the value only; acceptance occurs in job-apply §5, never in prep.
6. Demographic or EEO, a government ID number (CPF, RG, SSN, national ID), a
   passport detail, or a parent's name → the option that declines to answer →
   `declined`; required with no such option → skip the posting.
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
- First / last name: `basics.yaml` `name` split at the first space. Legal,
  given, and family names: `legal_name` split at the first space (given =
  first part, family = the rest); absent → `name`.
- Address: line 1, line 2, district or neighborhood, and postal / ZIP / CEP /
  PIN code read `basics.yaml` `address.*`. A full or mailing address joins
  `line1, line2, district, city - state, postal_code, country`.
- WhatsApp or mobile number: `basics.yaml` `phone` when `phone_whatsapp` is true.
- Time zone: `basics.yaml` `timezone` with its current UTC offset
  (`America/Sao_Paulo (UTC-3)`). Preferred working hours: `availability.working_hours`
  plus that time zone.
- Date of birth: `basics.yaml` `birth_date`, on a required field only; optional
  → blank. `Over 18?` is `Yes` iff `birth_date` is at least 18 years before today.
- City / state / country: `basics.yaml` `country` when present; else
  `location` split on commas, the last part taken as the country only when it
  names one (a form option or a country `job-profile/scripts/geography.py`
  resolves by name or three-letter code; a bare two-letter part is a state or
  province abbreviation, never a country) and the first part as the city. A
  `location` with one part or a non-country last part (`London`, `Austin, TX`,
  `Denver, CO`) yields no country → rule 7.
  Country of residence is that country. State / province is `location`'s middle
  comma part when it has three parts.
- Citizenship: answer only from `basics.yaml` `citizenships`, verbatim, when a
  form asks for citizenship, including a citizenship field in an immigration
  section. Never infer citizenship from residence. Immigration status,
  authorization, visa, and sponsorship questions use **Sponsorship and
  authorization** below. A demographic or
  EEO question still takes rule 6 and is answered by declining.
- Earliest start date: today plus `availability.notice_period`; `Immediately`
  when the notice is zero.
- Weekly hours: the posting's stated hours; full-time with none printed → 40.
- Current role: the `data/experiences.yml` role whose `date` ends `Present`.
  None → `currently employed?` is `No`; a current company or title field takes
  `Not currently employed (most recently {position} at {company})` from the
  most recent role; current salary uses `salary_history.last`.
- Seniority self-label: the current role's `position`, else the most recent role's.
- How did you hear about us / source: the dossier `source` pack.
  `linkedin-jobs` or `linkedin-posts` → `LinkedIn`; a `*-boards` pack or
  `surface: careers` → `Company careers page`; any other pack → its entry
  host's site name (`wellfound.com` → `Wellfound`). A dropdown without that
  option takes the option meaning job board, else other.
- Salary history: current or previous salary prints `salary_history.last` in
  its own currency and period; another currency or period → rule 7.
- Bachelor's degree?: `Yes` when an `education.yaml` `level` names a bachelor's
  degree; an ask that names a field also needs that entry's `field` to name it,
  else rule 7.
- Own company / CNPJ / invoicing entity: a yes/no ask is `Yes` only when
  `employment_routes.contractor_entity` is `Yes`, else `No`; free text prints it
  verbatim.
- Salary period: `salary_range_usd` is yearly. A monthly ask divides the
  figure by 12, rounded to 100; a daily ask by 260, rounded to 10; an hourly
  ask by 2080, rounded to 5.

- Language level is the printed self-assessment, paired with the language name. Never assert a certification, test score, or bare letter grade.
- Never name an employer's client. Use only a domain phrase already present in a Fact file.
- Remote is `Yes` when `work_model.remote` or `work_model.hybrid` is true, else `No`. In-person is `Yes` when `work_model.onsite` or `work_model.hybrid` is true, else `No`. No `work_model` flag true → neither is an answer. Relocation uses `availability.open_to_relocation` verbatim; an empty key is no answer.
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
currency (`job.min` when only it is printed) — never convert. An ask in
another currency with no figure printed in it, or an empty `ours` with none
printed, follows resolution rule 7; `ours` never answers a non-USD ask.

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

Classify the question before answering.
Authorized countries are `basics.yaml` `citizenships` plus `basics.yaml`
`permits`. Name the asked jurisdiction by code or clear
synonym (`us`, `eu`, `uk`, `br`), then run `job-profile/scripts/geography.py`
once per authorized country with `{"country": "<authorized country>",
"places": ["<asked jurisdiction>"]}`. Only a country or the EU is a
jurisdiction; any other region (`LATAM`, `Americas`, `worldwide`) gets no answer.
EU free movement: an authorized country whose `EU` match is `true` also counts
`true` for an asked country whose `EU` match is `true`.

| Result                                         | Authorized / legally allowed / permit | Requires visa | Requires sponsorship |
| ---------------------------------------------- | ------------------------------------- | ------------- | -------------------- |
| any `true`                                     | `Yes`                                 | `No`          | `No`                 |
| every result `false`                           | `No`                                  | `Yes`         | `Yes`                |
| no authorized country, or `null` and no `true` | no answer (rule 7)                    | no answer     | no answer            |

A free-text status is `Citizen` when a citizenship matched, else `Work permit`.
Working remotely or engagement model → `employment_routes`.

Never answer one jurisdiction from another, except through EU membership. A
binary question gets the literal truthful value. Never answer `No` to sponsorship just
because EOR exists. Put nuance in a free-text notes field once. Do not volunteer
sponsorship need to an engagement-only question. If possession versus need is ambiguous,
use the more specific field; never blend them into a hedge.
