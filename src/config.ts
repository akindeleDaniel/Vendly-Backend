export type CookieSameSite = "lax" | "strict" | "none"

export type AppConfig = {
    port: number
    frontendUrl: string
    cookieSameSite: CookieSameSite
    cookieSecure: boolean
}

const cookieSameSiteValues: CookieSameSite[] = ["lax", "strict", "none"]

function isCookieSameSite(value: string): value is CookieSameSite {
    return (cookieSameSiteValues as string[]).includes(value)
}

// Reads deployment settings from environment variables. Unset values fall back to the
// local-development defaults; invalid values throw so the server fails at startup.
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
    const portValue = env.PORT?.trim() || "3000"
    const port = Number(portValue)

    if (!/^\d+$/.test(portValue) || port < 1 || port > 65535) {
        throw new Error("PORT must be a whole number between 1 and 65535")
    }

    const frontendUrlValue = env.FRONTEND_URL?.trim() || "http://localhost:5173"
    let frontendUrl: URL

    try {
        frontendUrl = new URL(frontendUrlValue)
    } catch {
        throw new Error("FRONTEND_URL must be a valid http or https URL, for example http://localhost:5173")
    }

    if (frontendUrl.protocol !== "http:" && frontendUrl.protocol !== "https:") {
        throw new Error("FRONTEND_URL must be a valid http or https URL, for example http://localhost:5173")
    }

    if (frontendUrl.pathname !== "/" || frontendUrl.search || frontendUrl.hash) {
        throw new Error("FRONTEND_URL must be the frontend origin only, without a path, query or fragment")
    }

    const cookieSameSite = env.COOKIE_SAME_SITE?.trim().toLowerCase() || "lax"

    if (!isCookieSameSite(cookieSameSite)) {
        throw new Error("COOKIE_SAME_SITE must be lax, strict or none")
    }

    return {
        port,
        frontendUrl: frontendUrl.origin,
        cookieSameSite,
        // Browsers reject SameSite=None cookies that are not Secure.
        cookieSecure: env.NODE_ENV === "production" || cookieSameSite === "none"
    }
}

// Secrets have no safe default, so the server refuses to start without them.
export function assertRequiredEnvironment(env: NodeJS.ProcessEnv): void {
    const missing = ["DATABASE_URL", "JWT_SECRET"].filter((name) => !env[name]?.trim())

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
    }
}

const config = loadConfig(process.env)

export default config
