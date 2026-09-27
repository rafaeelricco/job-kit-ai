export default SignInPage

import { useEffect, useRef, useState } from "react"
import { Navigate, useLocation, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { type Cancel } from "@lib/future"
import { cn } from "@components/utils"
import { Failed, Loading, NotAsked, type RemoteData } from "@lib/remote-data"
import { Just, Nothing, type Maybe } from "@lib/maybe"
import { fetchErrorToString, type FetchError } from "@api/request"
import { RESEND_COOLDOWN_SECONDS, type GoogleSignInError as GoogleError } from "@api/endpoints"
import { googleSignInHref, requestCode, verifyCode, type Session } from "@module/session/session"
import { returnTo } from "@module/session/helpers/return-to"
import { AuthLayout } from "@module/session/components/auth-layout"
import { Alert, AlertDescription } from "@ui/alert"
import { Button, buttonVariants } from "@ui/button"
import { FormInput, TextInput, useForm } from "@ui/forms"
import { Separator } from "@ui/separator"

/** Where the email flow is: asking for a code (prefilled with `email` after "Change email"), or entering the one sent to `email`. */
type Step = { type: "email"; email: string } | { type: "code"; email: string }

function SignInPage({ session }: { session: Session }) {
  const location = useLocation()

  return (
    // Sign-in success lands on SignedIn too: setSession broadcasts, App re-renders, this redirects.
    session.type === "SignedIn" ? <Navigate to={returnTo(location.state)} replace />
    : session.type === "Checking" ?
      <AuthLayout>
        <p className="text-sm text-muted-foreground">Checking your session…</p>
      </AuthLayout>
    : session.type === "SignedOut" ? <SignInForm sessionError={session.error} />
    : (session satisfies never)
  )
}

/** Google, or an email code: `step` tracks which half of the email flow is on screen. */
function SignInForm({ sessionError }: { sessionError: Maybe<FetchError> }) {
  const location = useLocation()

  const [params] = useSearchParams()
  const [step, setStep] = useState<Step>({ type: "email", email: "" })

  const error = params.get("error")
  const googleError: Maybe<GoogleError> =
    error === "cancelled" || error === "failed" || error === "unavailable" ? Just(error) : Nothing()

  return (
    <AuthLayout>
      <>
        {sessionError instanceof Just ?
          <Alert variant="destructive">
            <AlertDescription>{fetchErrorToString(sessionError.value)}</AlertDescription>
          </Alert>
        : null}
        {googleError instanceof Just && step.type === "email" ?
          <Alert variant="destructive">
            <AlertDescription>
              {googleError.value === "cancelled" ?
                "Google sign-in was cancelled. Try again, or use an email code."
              : googleError.value === "failed" ?
                "Google sign-in didn't finish. Try again."
              : googleError.value === "unavailable" ?
                "Google sign-in isn't set up on this server yet. Use an email code."
              : (googleError.value satisfies never)}
            </AlertDescription>
          </Alert>
        : null}

        {step.type === "email" ?
          <div className="flex w-full min-w-0 flex-col gap-4">
            {/* Reference control height (40px) on this page only; the app's default stays h-9. */}
            <a
              href={googleSignInHref(returnTo(location.state))}
              className={cn(buttonVariants({ variant: "secondary" }), "h-10 w-full px-6")}
            >
              <GoogleMark />
              Continue with Google
            </a>
            <div className="relative h-8 w-full">
              <div className="absolute inset-0 flex items-center">
                <Separator />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-background px-4 py-2 text-ink-faint">or</span>
              </div>
            </div>
            <EmailForm defaultEmail={step.email} onSent={(email) => setStep({ type: "code", email })} />
          </div>
        : step.type === "code" ?
          <CodeForm email={step.email} onChangeEmail={() => setStep({ type: "email", email: step.email })} />
        : (step satisfies never)}
      </>
    </AuthLayout>
  )
}

/** Asks for a sign-in code. The server answers alike for listed and unlisted addresses. */
function EmailForm({ defaultEmail, onSent }: { defaultEmail: string; onSent: (email: string) => void }) {
  const [submit, setSubmit] = useState<RemoteData<FetchError, never>>(NotAsked())
  const cancel = useRef<Cancel>(() => {})
  useEffect(() => () => cancel.current(), [])

  const { fields, onSubmit } = useForm({
    fields: {
      email: new TextInput({
        label: "Email",
        hideLabel: true,
        type: "email",
        defaultValue: defaultEmail,
        placeholder: "Email address",
        input: { autoComplete: "email" },
      }),
    },
    validate: (values) => ({
      email:
        values.email.trim() === "" ? "Enter your email address."
        : !values.email.includes("@") ? "Enter a valid email address."
        : null,
    }),
  })

  const sendCode = (email: string): void => {
    if (submit.isLoading) return
    setSubmit(Loading())
    cancel.current = requestCode(email).fork(
      (error) => setSubmit(Failed(error)),
      () => onSent(email)
    )
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => sendCode(values.email.trim()))()
      }}
      className="flex flex-col gap-4"
    >
      <FormInput config={fields.email} className="h-10" disabled={submit.isLoading} />
      {submit instanceof Failed ?
        <Alert variant="destructive">
          <AlertDescription>{fetchErrorToString(submit.error)}</AlertDescription>
        </Alert>
      : null}
      <Button type="submit" className="h-10 w-full px-6" disabled={submit.isLoading}>
        Send code
      </Button>
    </form>
  )
}

/** Verifies the code mailed to `email`. Success needs no handler: commitSession re-renders App, and SignInPage redirects. */
function CodeForm({ email, onChangeEmail }: { email: string; onChangeEmail: () => void }) {
  const [submit, setSubmit] = useState<RemoteData<FetchError, never>>(NotAsked())
  // Mounted right after a send, so the cooldown starts full.
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS)

  const cancel = useRef<Cancel>(() => {})

  useEffect(() => () => cancel.current(), [])

  useEffect(() => {
    if (cooldown === 0) return undefined
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const run = (f: () => Cancel): void => {
    cancel.current()
    setSubmit(Loading())
    cancel.current = f()
  }

  const { fields, onSubmit } = useForm({
    fields: {
      code: new TextInput({
        label: "One-time code",
        hideLabel: true,
        type: "text",
        defaultValue: "",
        input: { autoComplete: "one-time-code", inputMode: "numeric", maxLength: 6, autoFocus: true },
      }),
    },
    validate: (values) => ({
      code: /^[0-9]{6}$/.test(values.code.trim()) ? null : "Enter the 6-digit code.",
    }),
  })

  const verify = (code: string): void => {
    if (submit.isLoading) return
    run(() =>
      verifyCode(email, code).fork(
        (error) => setSubmit(Failed(error)),
        () => {}
      )
    )
  }
  const resend = (): void =>
    run(() =>
      requestCode(email).fork(
        (error) => setSubmit(Failed(error)),
        () => {
          setSubmit(NotAsked())
          setCooldown(RESEND_COOLDOWN_SECONDS)
          // The server also ignores a resend while too many wrong codes lock the address, and its reply doesn't say so.
          toast("If a new code can be sent, it's on its way. Check your spam folder too.")
        }
      )
    )

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => verify(values.code.trim()))()
      }}
      className="flex w-full min-w-0 flex-col gap-4"
    >
      <p className="text-sm text-ink-soft">
        A 6-digit code is on its way to <span className="font-mono text-xs">{email}</span>. It expires in 10 minutes.
      </p>
      <FormInput config={fields.code} className="h-10 font-mono tracking-[0.3em]" disabled={submit.isLoading} />
      {submit instanceof Failed ?
        <Alert variant="destructive">
          <AlertDescription>{fetchErrorToString(submit.error)}</AlertDescription>
        </Alert>
      : null}
      <Button type="submit" className="h-10 w-full px-6" disabled={submit.isLoading}>
        Verify code
      </Button>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          className="flex-1 text-ink-soft"
          disabled={submit.isLoading || cooldown > 0}
          onClick={resend}
        >
          {cooldown > 0 ?
            <span className="tabular-nums">Resend code ({cooldown}s)</span>
          : "Resend code"}
        </Button>
        <Button type="button" variant="ghost" className="flex-1 text-ink-soft" onClick={onChangeEmail}>
          Change email
        </Button>
      </div>
    </form>
  )
}

/** Google's four-colour "G", required on Google sign-in buttons by its branding rules. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.36-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}
