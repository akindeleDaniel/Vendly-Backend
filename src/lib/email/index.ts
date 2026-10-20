import nodemailer from "nodemailer"
import { loadEmailConfig } from "./config.js"

export type OutgoingEmail = { to: string; subject: string; text: string }
export type EmailSender = (email: OutgoingEmail) => Promise<void>

let senderOverride: EmailSender | null = null
let defaultSender: EmailSender | null = null

// Tests replace the sender so they can read the codes without sending anything. Pass null to restore it.
export function setEmailSenderForTesting(sender: EmailSender | null) {
    senderOverride = sender
}

function buildDefaultSender(): EmailSender {
    const config = loadEmailConfig(process.env)

    if (config.mode === "console") {
        // Development only (the server refuses to start in production with this mode): the message, including
        // any code in it, is printed instead of being sent, so fake addresses work.
        return async (email) => {
            console.log(`[email, not sent] to: ${email.to}\nsubject: ${email.subject}\n${email.text}\n`)
        }
    }

    const transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: { user: config.smtp.user, pass: config.smtp.password }
    })

    return async (email) => {
        await transport.sendMail({ from: config.from, to: email.to, subject: email.subject, text: email.text })
    }
}

export async function sendEmail(email: OutgoingEmail): Promise<void> {
    defaultSender ??= buildDefaultSender()
    await (senderOverride ?? defaultSender)(email)
}
