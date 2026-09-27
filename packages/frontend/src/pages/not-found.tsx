export default NotFoundPage

import { Link } from "react-router-dom"

function NotFoundPage() {
  return (
    <main className="flex flex-col items-start gap-4 p-8 lg:p-16">
      <h1 className="text-4xl leading-[0.95] font-medium tracking-[-0.06em] text-ink-strong">Page not found</h1>
      <p className="text-sm text-ink-body">Nothing lives at this address.</p>
      <Link to="/" className="text-xs text-ink-soft underline underline-offset-3">
        Back to home
      </Link>
    </main>
  )
}
