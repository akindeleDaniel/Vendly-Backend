import "dotenv/config"
import { assertEmailEnvironment, loadEmailConfig } from "../src/lib/email/config.js"
import { sendEmail } from "../src/lib/email/index.js"

// Sends one test email with the settings in .env, to check that real emails work.
// Usage: npx tsx scripts/sendTestEmail.ts [recipient]   (the recipient defaults to SMTP_USER, so it goes to yourself)
async function main() {
    assertEmailEnvironment(process.env)
    const config = loadEmailConfig(process.env)
    const recipient = process.argv[2]?.trim() || process.env.SMTP_USER?.trim()

    if (config.mode !== "smtp") {
        console.error("EMAIL_MODE is not smtp, so nothing would really be sent. Set EMAIL_MODE=smtp in .env first.")
        process.exitCode = 1
        return
    }

    if (!recipient) {
        console.error("Give a recipient: npx tsx scripts/sendTestEmail.ts you@example.com")
        process.exitCode = 1
        return
    }

    try {
        await sendEmail({
            to: recipient,
            subject: "StoreHatch test email",
            text: "If you can read this, StoreHatch can send real emails.\n\nThe StoreHatch team"
        })
        console.log(`Sent a test email to ${recipient}. Check that inbox (and its spam folder).`)
    } catch (error) {
        // Only the reason is shown, never the password or any other setting.
        console.error("The test email could not be sent:", error instanceof Error ? error.message : "unknown error")
        process.exitCode = 1
    }
}

await main()
