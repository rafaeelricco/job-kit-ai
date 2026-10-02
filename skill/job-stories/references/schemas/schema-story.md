# Story shape

One file per story: `data/stories/<slug>.md`. Frontmatter is Fact, body is rehearsal.
A file whose basename starts with `_`, and `README.md`, are not stories.

## Frontmatter

| Field            | Law                                                                          |
| ---------------- | ---------------------------------------------------------------------------- |
| `id`             | slug, equals the basename without `.md`                                      |
| `company`        | must match a `company` in `data/experiences.yml`, or `""` for a side project |
| `covers`         | question tags; free list, lowercase kebab                                    |
| `claim`          | one sentence, conclusion first. Never a title                                |
| `evidence`       | `problem`, `decision`, `difficulty`, `impact` — all four, prose, no bullets  |
| `impact_numbers` | list of `{value, verified, kind}`                                            |
| `never_say`      | banned outbound claims, each with the reason it is false                     |
| `volunteer`      | weaknesses to state before being asked                                       |
| `sources`        | where each field was checked                                                 |
| `status`         | `draft` \| `needs-numbers` \| `ready`                                        |

`verified` ∈ `repo` | `site` | `client` | `operator` | `unverified`.
`kind` ∈ `outcome` | `process`. A process number counts your own activity (commits,
PRs, LOC, review comments). It may be stored; it never reaches outbound text.

`evidence.decision` states what was chosen **and what it replaced**. A sentence
naming only what was built is not a decision, and fails the author pass.

`evidence.impact` is the outcome for the client or user. "It worked", "the client
was happy", and "shipped to production" are not impact.

## Body

Everything below the frontmatter is for speech and never reaches outbound text.
`job-apply`, `job-outreach`, `job-stories`, and `job-resume-refine` read frontmatter only.

## Status law

- `draft` — any of the four `evidence` fields empty
- `needs-numbers` — all four filled, no `impact_numbers` entry with `kind: outcome`
  and `verified` not `unverified`
- `ready` — four parts filled and at least one shippable outcome number

Status is derived, never asserted by the operator.
