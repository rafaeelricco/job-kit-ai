export { httpHref }

// Posting URLs come from the corpus, so only the two navigable schemes get an
// anchor; anything else is shown as plain text.
function httpHref(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null
  } catch {
    return null
  }
}
