export { holdsSkill, splitSkills }

// `required_skills` is a comma list in the posting's own spelling; the profile
// writes its own. Match on a word boundary in either direction so "React" holds
// against "Tailwind CSS", while identifier punctuation stays attached — "C"
// never holds "C++" / "C#", and "React" never holds "React.js". "go" never
// matches inside "golang".
const norm = (raw: string): string => raw.trim().toLowerCase()

const prefixAtBoundary = (long: string, short: string): boolean =>
  long.length > short.length && long.startsWith(short) && /[^a-z0-9+.#]/.test(long.charAt(short.length))

// The contract says comma-separated, and most of the corpus is — but a minority
// of dossiers semicolon-join instead. Splitting on either keeps that file from
// rendering its whole stack as one chip that matches nothing.
const splitSkills = (raw: string): readonly string[] =>
  raw
    .split(/[,;]/)
    .map((skill) => skill.trim())
    .filter((skill) => skill !== "")

const holdsSkill = (held: readonly string[], wanted: string): boolean => {
  const want = norm(wanted)
  return held.some((skill) => {
    const have = norm(skill)
    return have === want || prefixAtBoundary(have, want) || prefixAtBoundary(want, have)
  })
}
