export { TermsPage, PrivacyPage }

import { Link } from "react-router-dom"

function LegalPage({ title }: { title: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-8 lg:p-16">
      <Link to="/sign-in" className="text-xs text-ink-soft underline underline-offset-3">
        Back to sign-in
      </Link>
      <h1 className="text-4xl leading-[0.95] font-medium tracking-[-0.06em] text-ink-strong">{title}</h1>
      <p className="text-sm text-ink-body">
        Job Kit is in a private pilot. This page is a placeholder until the {title.toLowerCase()} is published.
      </p>
    </main>
  )
}

const TermsPage = () => <LegalPage title="Terms of use" />
const PrivacyPage = () => <LegalPage title="Privacy policy" />
