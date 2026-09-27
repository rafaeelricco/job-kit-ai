# Emit tree

Source = `../../templates/` only. Destination = intake target path.

## Tree to write

```
<target>/
  README.md
  data/                 # Fact-law shells, search deck + observations
    stories/            # README + one .md stub per confirmed story
  cv/README.md
```

No skill pack trees inside the profile. Skills come from job-kit install.

Copy the entire `../../templates/` tree into the target (preserving structure), then
substitute every token in the target tree (all text files):

| Token                   | Approved identity |
| ----------------------- | ----------------- |
| `{{linkedin_username}}` | LinkedIn username |
| `{{display_name}}`      | Display name      |
| `{{email}}`             | Email             |
| `{{github_username}}`   | GitHub username   |

## Leak gate (must pass before fill)

Always screen for unsubstituted tokens:

```bash
rg -n '\{\{' "<target>"
```

When a donor fed this flow — a source of truth taken from someone else's
checkout, or a scaffold copied from an existing profile — ask the operator which
terms identify that donor (names, emails, handles, employers, client names) and
screen for those too:

```bash
rg -n '<donor-term>|<donor-term>' "<target>"
```

Any hit → STOP and fix templates or rewrite; do not hand off a dirty tree.
After substitution, no `{{…}}` tokens may remain. Target must not contain skill pack trees.

## After fill

`flow-fill.md` overwrites Fact-law files under `data/`, writes `data/stories/*.md`
stubs, and may place `cv/en-us-resume.pdf`.
It must not write skill trees or any path outside the emitted layout (`data/`, `cv/`,
root README). Re-run this leak gate after fill.

`job-scout` persist creates `scout/` under Profile root at first run. It is not
emitted here and never a Gap; this flow neither creates nor reads it.

Gaps allowlist and never-Gaps: `./references/flows/flow-fill.md`. Handoff: `./references/flows/flow-activate.md` step 9.
