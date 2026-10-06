# Learn — seed the answer library

Runs once after the last posting, before the inbox leg. Writes
`data/answers.yaml` `pending[]` and nothing else.

Collect, across every posting this run opened a form on, each label the
resolution order in `contract-screening.md` could not answer from rules 1-3 —
what rule 7 left blank or stopped on. A label a Fact file, a derived answer, or
an existing `qa[]` row already answers is covered; do not write it.

Never write a label `contract-screening.md` rule 6 declines (demographic, EEO,
government ID, passport, parent's name). Never write an answer, a password, a one-time code, or an
authentication link. The operator fills answers; this leg only asks.

Row shape is the one `job-profile/references/flows/flow-mutate.md` defines
for `pending[]`. Per row: `question` is the form label as printed,
collapsed to one line; `source` is `job-apply · {slug}`; `confirmed_at` is today.

Drop a row whose `question` normalizes equal to an existing `qa[]` or
`pending[]` row's, and
collapse duplicates within the run, by the normalization in
`contract-screening.md` rule 3. Nothing left → write nothing and say so.

Write once for the whole run under
`job-profile/references/flows/flow-mutate.md` staging law, with two
additions this leg owns because it runs unattended. Re-read
`data/answers.yaml` now and re-apply the drop rule above against that fresh
`qa[]` and `pending[]`. Render to `data/answers.yaml.{run token}.tmp` — never the bare
`*.yaml.tmp` sibling, which another writer owns — appending at the tail of
`pending[]` in collection order, editing surgically, never re-serializing, never
dropping a comment or a key outside the appended rows. Re-parse, then re-read
`data/answers.yaml` once more immediately before the rename: changed since
the render → discard the staging file, write nothing, and print that the
profile changed under this run, naming the rows not written. Unchanged →
rename over the original. A parse failure discards the staging file and writes
nothing.

Print `pending += {question}` per appended row, then the count. Nothing appended, a
discarded staging file, or a profile that changed under this run prints one
line saying so and no count.
