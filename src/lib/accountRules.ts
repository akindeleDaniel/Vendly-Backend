// Rules for what a new account may contain. Each check returns a message for the person, or null.

export const minimumPasswordLength = 10
// bcrypt only uses the first 72 bytes, so anything longer would silently stop mattering.
export const maximumPasswordBytes = 72
export const maximumNameLength = 80
export const maximumEmailLength = 254

export const registrationRoles = ["CONSUMER", "SELLER"] as const
export type RegistrationRole = typeof registrationRoles[number]

// Passwords long enough to pass the length rule that are still among the most guessed.
const commonPasswords = new Set([
    "password12", "password123", "password1234", "password12345", "password123456", "passw0rd123", "p@ssword123",
    "1234567890", "12345678910", "123456789012", "0123456789", "0987654321", "1122334455", "1234512345", "9876543210",
    "qwertyuiop", "qwerty1234", "qwerty12345", "qwerty123456", "qwertyuiop123", "asdfghjkl1", "asdfghjklq", "1q2w3e4r5t",
    "1qaz2wsx3edc", "zxcvbnm123", "abcdefghij", "abcd123456", "abc1234567", "abcabc1234",
    "iloveyou12", "iloveyou123", "iloveyou1234", "welcome123", "welcome1234", "letmein123", "letmein1234", "changeme123",
    "administrator", "adminadmin", "admin12345", "admin123456", "administrator1", "superuser12",
    "football123", "baseball123", "dragon12345", "monkey12345", "sunshine123", "princess123", "trustno1234", "master12345",
    "internet123", "computer123", "whatever123", "freedom1234", "starwars123", "shadow12345", "michael1234", "jennifer123",
    "nigeria123", "nigeria1234", "lagos12345", "naija12345", "vendly1234", "vendly12345", "marketplace1"
])

export function validateName(value: unknown): string | null {
    if (typeof value !== "string" || value.trim().length === 0) {
        return "Enter your name"
    }

    if (value.trim().length > maximumNameLength) {
        return `Name must be ${maximumNameLength} characters or fewer`
    }

    return null
}

// Emails are stored trimmed and in lowercase, so "A@x.com" and "a@x.com" are one account.
export function normaliseEmail(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }

    const email = value.trim().toLowerCase()

    if (email.length === 0 || email.length > maximumEmailLength) {
        return null
    }

    // One @, something on each side, a dot in the domain, no spaces. The real check is the code we email.
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) ? email : null
}

export function validatePassword(value: unknown, context: { email: string; name: string }): string | null {
    if (typeof value !== "string") {
        return "Enter a password"
    }

    if (value.length < minimumPasswordLength) {
        return `Password must be at least ${minimumPasswordLength} characters`
    }

    if (Buffer.byteLength(value, "utf8") > maximumPasswordBytes) {
        return `Password must be ${maximumPasswordBytes} bytes or fewer`
    }

    const lowered = value.toLowerCase()

    if (commonPasswords.has(lowered) || /^(.)\1+$/.test(value)) {
        return "That password is too common. Choose a different one"
    }

    if (lowered === context.email || lowered === context.name.trim().toLowerCase()) {
        return "Your password cannot be the same as your email or name"
    }

    return null
}

export function isRegistrationRole(value: unknown): value is RegistrationRole {
    return typeof value === "string" && (registrationRoles as readonly string[]).includes(value)
}
