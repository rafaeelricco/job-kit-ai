export { type Mail, type Mailer, mailerFromEnv }

import nodemailer from "nodemailer"
import { Future } from "@lib/future"
import env from "@be/app/environment"

type Mail = { readonly to: string; readonly subject: string; readonly text: string }
type Mailer = { readonly send: (mail: Mail) => Future<Error, void> }

/** SMTP when `SMTP_URL` is set; otherwise logged, so a local run needs no mail server. */
function mailerFromEnv(): Mailer {
  if (env.SMTP_URL === "") {
    // A logged sign-in code is a credential in the logs: allowed in development only.
    if (env.NODE_ENV === "production") throw new Error("SMTP_URL is required in production")
    return {
      send: (mail) => Future.attemptP(async () => console.log(`[mail] ${mail.to}: ${mail.subject}\n${mail.text}`)),
    }
  }
  const transport = nodemailer.createTransport(env.SMTP_URL)
  return {
    send: (mail) => Future.attemptP(() => transport.sendMail({ from: env.MAIL_FROM, ...mail })).map(() => undefined),
  }
}
