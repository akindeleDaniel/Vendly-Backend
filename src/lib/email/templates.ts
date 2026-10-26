import type { OtpPurpose } from "../../generated/prisma/client.js"
import type { OutgoingEmail } from "./index.js"

const purposeText: Record<OtpPurpose, { subject: string; reason: string }> = {
    VERIFY_EMAIL: { subject: "Confirm your email", reason: "finish creating your StoreHatch account" },
    LOGIN: { subject: "Your login code", reason: "log in to StoreHatch on a new device" },
    PASSWORD_RESET: { subject: "Reset your password", reason: "reset your StoreHatch password" },
    GOOGLE_LINK: { subject: "Link Google to your account", reason: "link your Google account to your StoreHatch account" },
    SET_PASSWORD: { subject: "Set your password", reason: "set a password for your StoreHatch account" }
}

export function otpEmail(to: string, purpose: OtpPurpose, code: string, validMinutes: number): OutgoingEmail {
    const { subject, reason } = purposeText[purpose]

    return {
        to,
        subject: `${subject}: ${code}`,
        text: [
            `Your StoreHatch code is ${code}.`,
            "",
            `Enter it to ${reason}. It works for ${validMinutes} minutes and only once.`,
            "",
            "If you did not ask for this, ignore this email. Nobody can use the code without your password, and StoreHatch will never ask you for it."
        ].join("\n")
    }
}

// Sent instead of a code when someone signs up with an address that already has an account, so the
// sign-up page can give the same answer for every address without revealing which ones are registered.
export function accountExistsEmail(to: string): OutgoingEmail {
    return {
        to,
        subject: "You already have a StoreHatch account",
        text: [
            "Someone tried to create a StoreHatch account with this email address, but you already have one.",
            "",
            "If it was you, log in instead, or use \"Forgot password\" if you do not remember your password.",
            "If it was not you, you can ignore this email; your account has not changed."
        ].join("\n")
    }
}
