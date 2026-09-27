export { notifyAccessChanged, subscribeAccessChanged }

// Each surface calls useAccess for itself, so the sidebar holds a different
// instance than the gate the user picks a folder in and never sees that pick
// land. A grant announces itself to the app instead: whoever reads the folder
// re-reads it. Without this, choosing a folder leaves the footer on "No profile
// folder" until the next full page load.
const target = new EventTarget()
const CHANGED = "access-changed"

function notifyAccessChanged(): void {
  target.dispatchEvent(new Event(CHANGED))
}

function subscribeAccessChanged(listener: () => void): () => void {
  target.addEventListener(CHANGED, listener)
  return () => target.removeEventListener(CHANGED, listener)
}
