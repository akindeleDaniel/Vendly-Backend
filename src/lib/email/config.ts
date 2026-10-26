export type EmailConfig =
    | { mode: "console"; from: string }
    | { mode: "smtp"; from: string; smtp: { host: string; port: number; user: string; password: string } }

const defaultFrom = "StoreHatch <no-reply@storehatch.local>"

// EMAIL_MODE=console prints emails instead of sending them (development). EMAIL_MODE=smtp sends through any
// provider that offers SMTP (Gmail app password for development, or a transactional service for launch).
export function loadEmailConfig(env: NodeJS.ProcessEnv): EmailConfig {
    const mode = env.EMAIL_MODE?.trim().toLowerCase() || "console"
    const from = env.EMAIL_FROM?.trim() || defaultFrom

    if (mode === "console") {
        return { mode, from }
    }

    if (mode !== "smtp") {
        throw new Error("EMAIL_MODE must be console or smtp")
    }

    const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"].filter((name) => !env[name]?.trim())

    if (missing.length > 0) {
        throw new Error(`EMAIL_MODE=smtp needs these environment variables: ${missing.join(", ")}`)
    }

    const portValue = env.SMTP_PORT?.trim() || "587"
    const port = Number(portValue)

    if (!/^\d+$/.test(portValue) || port < 1 || port > 65535) {
        throw new Error("SMTP_PORT must be a whole number between 1 and 65535")
    }

    return {
        mode,
        from,
        smtp: { host: env.SMTP_HOST!.trim(), port, user: env.SMTP_USER!.trim(), password: env.SMTP_PASSWORD! }
    }
}

// Checked at startup. In production the codes must really be emailed, never printed.
export function assertEmailEnvironment(env: NodeJS.ProcessEnv): void {
    const config = loadEmailConfig(env)

    if (env.NODE_ENV === "production" && config.mode !== "smtp") {
        throw new Error("EMAIL_MODE must be smtp in production, otherwise login codes would be printed instead of emailed")
    }

    if (env.NODE_ENV === "production" && !env.EMAIL_FROM?.trim()) {
        throw new Error("EMAIL_FROM must be set in production")
    }
}
