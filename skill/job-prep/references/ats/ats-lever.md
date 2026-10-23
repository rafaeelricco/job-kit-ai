# Lever — stable field map

| selector                       | label           | source                                                             |
| ------------------------------ | --------------- | ------------------------------------------------------------------ |
| `input[name="name"]`           | Full name       | `data/basics.yaml`                                                 |
| `input[name="email"]`          | Email           | `data/basics.yaml`                                                 |
| `input[name="phone"]`          | Phone           | `data/basics.yaml`                                                 |
| `input[name="urls[LinkedIn]"]` | LinkedIn        | `data/profiles.yaml`                                               |
| `input[name="resume"]` (file)  | Resume          | plan `cv`                                                          |
| `[name^="cards["]`             | custom question | resolve per `job-apply/references/contracts/contract-screening.md` |
| `#btn-submit`                  | Submit          | recorded as `submit_selector`, never clicked                       |
