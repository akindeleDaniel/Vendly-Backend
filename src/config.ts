export type CookieSameSite = "lax" | "strict" | "none"

export type AppConfig = {
    port: number
    frontendUrl: string
    // This server's own public address, used to build share links (for example https://api.storehatch.shop).
    publicApiUrl: string
    cookieSameSite: CookieSameSite
    cookieSecure: boolean
    // How many proxies (a load balancer, the host's router) sit in front of the server. Tells Express which
    // address in X-Forwarded-For is the real visitor, which rate limiting depends on. False for none.
    trustProxy: number | false
    // The most one seller's order may be worth, in naira, and the most a seller may owe for unrecovered refunds
    // before new orders pause. Null means no limit. See lib/orderLimits.ts.
    maximumOrderValue: number | null
    sellerDebtLimit: number | null
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

    const trustProxyValue = env.TRUST_PROXY?.trim() || "0"

    if (!/^\d+$/.test(trustProxyValue)) {
        throw new Error("TRUST_PROXY must be the number of proxies in front of the server (0 for none, usually 1 on a host), not true or an address")
    }

    const publicApiUrlValue = env.PUBLIC_API_URL?.trim() || `http://localhost:${port}`
    let publicApiUrl: URL

    try {
        publicApiUrl = new URL(publicApiUrlValue)
    } catch {
        throw new Error("PUBLIC_API_URL must be a valid http or https URL, for example https://api.storehatch.shop")
    }

    if ((publicApiUrl.protocol !== "http:" && publicApiUrl.protocol !== "https:") || publicApiUrl.pathname !== "/" || publicApiUrl.search || publicApiUrl.hash) {
        throw new Error("PUBLIC_API_URL must be this server's origin only, for example https://api.storehatch.shop")
    }

    const maximumOrderValue = readNairaLimit(env.MAX_ORDER_VALUE, "MAX_ORDER_VALUE", 100000)
    const sellerDebtLimit = readNairaLimit(env.SELLER_DEBT_LIMIT, "SELLER_DEBT_LIMIT", 50000)

    return {
        port,
        frontendUrl: frontendUrl.origin,
        publicApiUrl: publicApiUrl.origin,
        cookieSameSite,
        trustProxy: Number(trustProxyValue) || false,
        // Browsers reject SameSite=None cookies that are not Secure.
        cookieSecure: env.NODE_ENV === "production" || cookieSameSite === "none",
        maximumOrderValue,
        sellerDebtLimit
    }
}

// A limit in whole naira. Unset uses the default; 0 switches the limit off.
function readNairaLimit(value: string | undefined, name: string, fallback: number): number | null {
    const text = value?.trim()

    if (!text) {
        return fallback
    }

    if (!/^\d{1,10}$/.test(text)) {
        throw new Error(`${name} must be a whole number of naira (0 to switch the limit off)`)
    }

    return Number(text) || null
}

// Secrets have no safe default, so the server refuses to start without them.
export function assertRequiredEnvironment(env: NodeJS.ProcessEnv): void {
    const missing = ["DATABASE_URL", "JWT_SECRET"].filter((name) => !env[name]?.trim())

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
    }

    if (env.NODE_ENV === "production") {
        // Without the provider secrets the server would start and then quietly refuse every payment webhook.
        // TRUST_PROXY must be a deliberate choice (0 if there is no proxy), because a wrong value makes rate
        // limiting treat every visitor as one person.
        const missingInProduction = ["PAYSTACK_SECRET_KEY", "FLUTTERWAVE_SECRET_KEY", "FLUTTERWAVE_WEBHOOK_SECRET", "TRUST_PROXY"]
            .filter((name) => !env[name]?.trim())

        if (missingInProduction.length > 0) {
            throw new Error(`Missing environment variables required in production: ${missingInProduction.join(", ")}`)
        }

        if ((env.JWT_SECRET ?? "").trim().length < 32) {
            throw new Error("JWT_SECRET must be at least 32 characters in production")
        }
    }
}

const config = loadConfig(process.env)

export default config
