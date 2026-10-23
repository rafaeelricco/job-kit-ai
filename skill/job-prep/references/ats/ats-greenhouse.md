# Greenhouse — stable field map

| selector                             | label           | source                                                             |
| ------------------------------------ | --------------- | ------------------------------------------------------------------ |
| `#first_name`                        | First name      | `data/basics.yaml`                                                 |
| `#last_name`                         | Last name       | `data/basics.yaml`                                                 |
| `#email`                             | Email           | `data/basics.yaml`                                                 |
| `#phone`                             | Phone           | `data/basics.yaml`                                                 |
| `#resume` (file)                     | Resume          | plan `cv`                                                          |
| `input[id^=job_application_answers]` | custom question | resolve per `job-apply/references/contracts/contract-screening.md` |
| `#submit_app`                        | Submit          | recorded as `submit_selector`, never clicked                       |
