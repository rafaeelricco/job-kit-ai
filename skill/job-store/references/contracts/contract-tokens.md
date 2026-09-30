# Token law

Callers name this file to parse a message into tokens. `job-store`'s own load
path does not read it; a skill that parses arguments reads it before its first
token test.

## Grammar

    /job-<name> [<verb>] [<target>…] [--<flag> [<value>]…]

- **Verb** — first token only, bare, never `--`-prefixed, always one of the
  skill's own. A skill that declares no verb has none: its first token is a
  target. A verb wins over a same-spelled target, so a deck pack or story slug
  spelled like a verb is unreachable and the skill names it.
- **Target** — what the run acts on: a `scout/jobs/` filename, a URL, a
  `<pack-id>`, or a posting body already in the message. A target never changes
  what the skill does, only what it acts on. Exact match always: never resolve a
  target by company+title, because one company posts many roles.
- **Flag** — every remaining token. One that takes a value consumes exactly one
  following token; `--flag=value` is not a form. A flag is legal with every
  selector unless the skill's own flow refuses it.

Prose around the tokens is context, not tokens: read it for the targets it
names, ignore the rest.

## Shared flags

One spelling per concept. A skill takes the subset its own flow names, never a
synonym for a concept already on this table.

| Flag                      | Value                                          | Means                                        |
| ------------------------- | ---------------------------------------------- | -------------------------------------------- |
| `--all`                   | —                                              | the whole readable set                       |
| `--new`                   | —                                              | frontmatter `status:` = `new` only           |
| `--posting`               | —                                              | the body already in the message; never fetch |
| `--top <n>`               | one positive integer                           | cap, applied last — after every filter       |
| `--status <s>[,<s>…]`     | one token, comma-joined                        | keep only these statuses                     |
| `--exclude <s>[,<s>…]`    | one token, comma-joined                        | drop these statuses                          |
| `--since <n>d` or `<iso>` | one token                                      | earliest date considered                     |
| `--from <name>`           | exactly the value the skill's own flow names   | consume that skill's last output as input    |
| `--engine <name>`         | one token                                      | scoring engine other than the default worker |
| `--channel <c>`           | `ats`, `dm_request`, `direct_email`, `founder` | keep only that `channel`                     |
| `--host <family>`         | `ats`                                          | keep only hosts of that family               |
| `--match <text>`          | one token                                      | loose text filter; never a target            |
| `--unattended`            | —                                              | no operator in the loop; waives no guard     |

Status vocabulary is `./references/flows/flow-read.md` frontmatter `status:`.

A skill may declare a flag this table does not name when the concept is its own
private protocol with one other skill — `job-apply`'s plan bind, for instance.
Such a flag is declared in that skill's own flow, never here, and never reuses a
spelling above for a different meaning.

## Stop rules

Stop, name the token, and write nothing when:

1. Two selectors arrive where the skill takes one.
2. A `--` flag the skill does not declare.
3. A value flag with no value, a value that fails its type, or any flag repeated.
4. A leftover token no verb, target, or flag claims.
5. A named target that does not resolve — say which.

A stop ends the run. One unreadable target among many is that target's failure
alone only where the skill's own flow says so.
