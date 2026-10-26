import { OAuth2Client } from "google-auth-library"
import { maximumNameLength, normaliseEmail } from "./accountRules.js"

export type GoogleIdentity = { googleId: string; email: string; name: string }
// Returns who Google says the person is, or null when the sign-in token is not valid for StoreHatch.
export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity | null>

let verifierOverride: GoogleVerifier | null = null
let client: OAuth2Client | null = null

// Tests replace the check so they do not need a real Google sign-in. Pass null to restore it.
export function setGoogleVerifierForTesting(verifier: GoogleVerifier | null) {
    verifierOverride = verifier
}

export function googleSignInAvailable(): boolean {
    return verifierOverride !== null || Boolean(process.env.GOOGLE_CLIENT_ID?.trim())
}

// Checks the sign-in token the browser got from Google: its signature (against Google's public keys), that it
// was issued for StoreHatch's own client id, that it has not expired, and that Google has verified the email.
export async function verifyGoogleCredential(credential: string): Promise<GoogleIdentity | null> {
    if (verifierOverride) {
        return verifierOverride(credential)
    }

    const clientId = process.env.GOOGLE_CLIENT_ID?.trim()

    if (!clientId) {
        return null
    }

    try {
        client ??= new OAuth2Client()
        const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId })
        const payload = ticket.getPayload()
        const email = normaliseEmail(payload?.email)

        if (!payload?.sub || !email || payload.email_verified !== true) {
            return null
        }

        const name = (payload.name?.trim() || email.split("@")[0] || "StoreHatch user").slice(0, maximumNameLength)
        return { googleId: payload.sub, email, name }
    } catch {
        return null
    }
}
