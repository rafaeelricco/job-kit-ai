export { AuthLayout }

import { type ReactNode } from "react"
import { Link } from "react-router-dom"
import { AsciiMascot } from "@module/session/components/ascii-mascot"

/** Sign-in chrome: the ASCII mascot panel from md up, the brand heading above `children`, the legal links below. */
function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh w-full bg-background md:grid-cols-2">
      <AsciiMascot className="hidden md:sticky md:top-0 md:block md:h-dvh" />
      <div className="flex min-w-0 flex-col border-divider pt-10 md:border-l-[0.5px]">
        <div className="flex flex-1 flex-col items-center justify-center p-8 pb-16 lg:p-16">
          <div className="flex w-full max-w-sm min-w-0 flex-col items-start gap-8">
            <header className="w-full space-y-4">
              <img
                src={`${import.meta.env.BASE_URL}brand/mascot-mark.svg`}
                alt="Job Kit"
                className="mb-4 h-14 w-auto dark:hidden"
              />
              <img
                src={`${import.meta.env.BASE_URL}brand/mascot-mark-dark.svg`}
                alt="Job Kit"
                className="mb-4 hidden h-14 w-auto dark:block"
              />
              <h1 className="max-w-xs text-4xl leading-[0.95] font-medium tracking-[-0.06em] text-ink-strong">
                Welcome to Job Kit
              </h1>
            </header>

            {children}

            <div className="flex py-6">
              <p className="text-xs text-ink-muted *:[a]:text-ink-soft *:[a]:underline *:[a]:underline-offset-3">
                By continuing, you agree to the <Link to="/legal/terms">terms of use</Link> and the{" "}
                <Link to="/legal/privacy">privacy policy</Link>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
