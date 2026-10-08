# Research sources and interpretation

The public sources below inform the review criteria. Contextual defaults and
scoring choices are distinguished from source-backed recommendations.
The relevant guidance is recorded locally; original-source links provide
attribution and are not required reading to run a review.

## Recommendations and original sources

**Content and organization.** [Harvard's resume guide](https://careerservices.fas.harvard.edu/resources/create-a-strong-resume/)
supports specific, active, factual language, visible results, consistent formatting,
and easy scanning. [UK National Careers Service](https://nationalcareers.service.gov.uk/careers-advice/cv-sections)
supports tailoring the document to the role. Evaluate the evidence and its visibility,
rather than rewarding impressive adjectives or keyword repetition.

**Summary.** [Georgetown Alumni Career Services](https://alumni.georgetown.edu/learn/career-resources/job-search-document-review-coaching-services/)
and [CareerOneStop](https://cloudfront.careeronestop.org/JobSearch/Resumes/ResumeGuide/top-portion-of-resume.aspx)
inform the identity, relevant strengths, and supporting evidence checks.
[Indeed's summary guidance](https://www.indeed.com/career-advice/resumes-cover-letters/writing-a-resume-summary-with-examples)
offers a short, tailored summary as a useful pattern. CareerOneStop recommends
omitting a summary when work experience already shows a clear, consistent progression.
Suggested sentence or line counts are editing defaults, not scoring requirements.

**Achievement descriptions.** [MIT's PAR guidance](https://capd.mit.edu/resources/resumes-writing-about-your-skills/)
and [Princeton's description guidance](https://careerdevelopment.princeton.edu/resume-guide/crafting-your-descriptions)
connect action, context, and result. Methods and scope earn space when they explain
the contribution or demonstrate a relevant capability. Result-first descriptions
can communicate the same evidence. [MIT's career toolkit](https://capd.mit.edu/resources/career-toolkit-crafting-an-effective-resume/)
supports describing contribution and positive outcomes when exact numbers are
unavailable. A meaningful qualitative outcome is evidence; lack of a percentage
is not itself a weakness.

**Parsing and qualification visibility.** [Greenhouse's parsing guidance](https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse)
identifies image-only documents, columns, complex tables, header/footer contact
details, and files over 2.5 MB as potential parsing risks. Extracted reading order and rendered pages provide complementary
evidence; local extraction cannot guarantee an employer's parser result.
[Greenhouse Talent Matching](https://support.greenhouse.io/hc/en-us/articles/41131886674075-Talent-Matching-FAQ)
and [Workable Screening Assistant](https://help.workable.com/hc/en-us/articles/23685011706775-Using-the-Screening-Assistant-AI-powered)
describe product-specific matching against selected criteria. The rubric's job
alignment measures visible evidence against the supplied posting, not either
vendor's actual score. [Greenhouse Boolean search](https://support.greenhouse.io/hc/en-us/articles/202360199-Search-candidates-using-Boolean-queries)
supports using recognizable role terminology where it truthfully describes the work.

**First skim and spelling.** [Ladders' 2018 eye-tracking study](https://www.bu.edu/com/files/2018/10/TheLadders-EyeTracking-StudyC2.pdf)
found the first pass concentrates on name, current and previous titles and employers, dates, and education.
[interviewing.io](https://interviewing.io/blog/are-recruiters-better-than-a-coin-flip-at-judging-resumes) measured a
median of 31 seconds per technical resume. A [PLOS ONE field experiment](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0283280)
found spelling errors cut interview chances. These support the top-third Positioning check, recency weighting, and
the spelling rule.

**Parser evidence.** [Textkernel's parser output codes](https://developer.textkernel.com/tx-platform/v10/resume-parser/overview/parser-output/)
rate columns a major issue and a date range split across lines fatal, and derive skill duration and recency from the
roles that mention a skill. [Greenhouse auto-reject](https://support.greenhouse.io/hc/en-us/articles/360000653472-Auto-reject)
acts on application-question answers, so knockout questions, not CV content, are the documented automatic rejection
path. [Indeed](https://www.indeed.com/news/releases/protecting-trust-in-hiring-ai-how-indeed-detects-and-defends-against-resume-manipulation)
flags hidden text for human review.

**Market context.** Field experiments find callbacks fall with unemployment duration
([Kroft, Lange and Notowidigdo 2013](https://doi.org/10.1093/qje/qjt015)) and that foreign experience is discounted
([Oreopoulos 2011](https://doi.org/10.1257/pol.3.4.148)). These support the gap and unknown-employer checks.

**AI-writing signals.** A [field experiment with about 480,000 jobseekers](https://pubsonline.informs.org/doi/10.1287/mnsc.2024.04528)
found AI writing assistance raised hires. Recruiter surveys name uniform bullet shapes and stock phrases as signs of
generated text, but no field study yet ties them to callbacks, so the rubric caps their effect at one point.

## Career positioning and search visibility

Read `./references/career-positioning-sources.md` for the relevant content
extracted from Danilo Moraes's post and attached prompt, Jessica B.'s
sourcing post, and LinkedIn's Recruiter documentation, including their limits.
`./references/rubric.md` owns the resulting diagnostic rules.

## Evidence strength

| Evidence                    | Examples above                                                     | Use in the rubric                        |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| Field experiment            | Spelling errors, unemployment gaps, foreign experience, AI editing | Rules that change ratings                |
| Vendor documentation        | Greenhouse, Textkernel, Indeed                                     | Parsing checks and knockout framing      |
| Eye-tracking, observational | Ladders, interviewing.io                                           | Positioning area and recency weighting   |
| Survey                      | AI-writing signals                                                 | Notes and deductions capped at one point |
| Practitioner guidance       | University career guides                                           | Core criteria and anchors                |

## Claims not to repeat

- "75% of resumes are auto-rejected by an ATS": traced to a defunct vendor's marketing, with no published data.
- Checker "ATS score" percentages are each tool's own metric, not what employers see.
- "LaTeX breaks ATS parsing": judge the extracted text, not the authoring tool.
- File names affect ranking: no vendor documents it.

## Context and limits

- Resume length and section order depend on career stage, market, and purpose.
  [Stanford's guide](https://careered.stanford.edu/sites/g/files/sbiybj22801/files/media/file/resume_and_cover_letter_examples_1.pdf)
  provides resume examples; [Harvard's academic CV guide](https://hwpi.harvard.edu/files/ocs/files/gsas-cvs-and-cover-letters.pdf)
  covers a different document purpose. Do not apply industry-resume compression
  rules to academic publication or research inventories.
- The six-month gap threshold and the personal-data list (photo, date of birth,
  marital status, national ID, street address) are review defaults drawn from the
  experiments above and common hiring guidance, not legal rules. State the norm applied.
- Two-page layouts and 11–12 pt body text are contextual design choices,
  not ATS requirements. A simple single-column layout is a conservative default;
  observed readability and extraction evidence matter more than template conformity.
- [GitHub's portfolio guidance](https://docs.github.com/en/account-and-profile/tutorials/using-your-github-profile-to-enhance-your-resume)
  supports relevant, inspectable technical work. Portfolio advice applies when the
  target role benefits from it, not to every applicant.
- Community templates are examples, not validated universal rules.
- Example achievements and figures in the linked guides are illustrative. They are
  not facts about the reviewed candidate and must not be reused as such.
