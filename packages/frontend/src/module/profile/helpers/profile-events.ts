export { notifyProfileChanged, subscribeProfileChanged }

// The sidebar's identity and the settings form live in separate trees with no
// state in common, so a save announces itself to the app rather than to a
// component: whoever displays profile data re-reads it. Without this, editing
// your name leaves the old one in the footer until the next full page load.
const target = new EventTarget()
const CHANGED = "profile-changed"

function notifyProfileChanged(): void {
  target.dispatchEvent(new Event(CHANGED))
}

function subscribeProfileChanged(listener: () => void): () => void {
  target.addEventListener(CHANGED, listener)
  return () => target.removeEventListener(CHANGED, listener)
}
