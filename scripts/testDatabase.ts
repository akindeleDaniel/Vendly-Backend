import dotenv from "dotenv"

type DatabaseTarget = {
    hostname: string
    port: string
    database: string
}

const approvedTestHosts = new Set(["localhost", "127.0.0.1", "::1"])
const originalDevelopmentDatabaseUrlKey = "VENDLY_ORIGINAL_DATABASE_URL"

function getOriginalDevelopmentDatabaseUrl(env: NodeJS.ProcessEnv): string {
    const originalDevelopmentUrl = env[originalDevelopmentDatabaseUrlKey]

    if (!originalDevelopmentUrl) {
        throw new Error("The original development DATABASE_URL could not be established safely.")
    }

    return originalDevelopmentUrl
}

export function getTestDatabaseUrl(env: NodeJS.ProcessEnv): string {
    if (env.VENDLY_TEST_DATABASE !== "vendly_test") {
        throw new Error("Set VENDLY_TEST_DATABASE=vendly_test to explicitly select the test database.")
    }

    const testUrl = env.TEST_DATABASE_URL
    const developmentUrl = getOriginalDevelopmentDatabaseUrl(env)

    if (!testUrl) {
        throw new Error("Both TEST_DATABASE_URL and the development DATABASE_URL must be configured.")
    }

    const testTarget = parseDatabaseTarget(testUrl, "TEST_DATABASE_URL")
    const developmentTarget = parseDatabaseTarget(developmentUrl, "DATABASE_URL")

    if (!approvedTestHosts.has(testTarget.hostname)) {
        throw new Error(
            "TEST_DATABASE_URL host must be localhost, 127.0.0.1, or ::1."
        )
    }

    if (testTarget.database !== "vendly_test") {
        throw new Error("TEST_DATABASE_URL must target a database named vendly_test.")
    }

    if (
        canonicalHost(testTarget.hostname) === canonicalHost(developmentTarget.hostname) &&
        testTarget.port === developmentTarget.port &&
        testTarget.database === developmentTarget.database
    ) {
        throw new Error("TEST_DATABASE_URL must not target the development database.")
    }

    return testUrl
}

function parseDatabaseTarget(value: string, variableName: string): DatabaseTarget {
    let url: URL

    try {
        url = new URL(value)
    } catch {
        throw new Error(`${variableName} must be a valid PostgreSQL connection URL.`)
    }

    if (
        (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
        !url.hostname ||
        !url.pathname ||
        url.pathname === "/"
    ) {
        throw new Error(`${variableName} must identify a PostgreSQL host and database.`)
    }

    return {
        hostname: normalizeHostname(url.hostname),
        port: url.port || "5432",
        database: decodeURIComponent(url.pathname.slice(1))
    }
}

function normalizeHostname(hostname: string): string {
    return hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
}

function canonicalHost(hostname: string): string {
    return approvedTestHosts.has(hostname) ? "loopback" : hostname
}

export async function connectTestDatabase() {
    dotenv.config()
    dotenv.config({ path: ".env.test" })

    if (process.env[originalDevelopmentDatabaseUrlKey] === undefined) {
        const originalDevelopmentUrl = process.env.DATABASE_URL

        if (!originalDevelopmentUrl) {
            throw new Error("The development DATABASE_URL must be configured before the test database can be validated.")
        }

        process.env[originalDevelopmentDatabaseUrlKey] = originalDevelopmentUrl
    }

    const testUrl = getTestDatabaseUrl(process.env)
    process.env.NODE_ENV = "test"
    process.env.DATABASE_URL = testUrl

    const { PrismaClient } = await import("../src/generated/prisma/client.js")
    const prisma = new PrismaClient()

    try {
        const rows = await prisma.$queryRaw<Array<{ database_name: string }>>`
            SELECT current_database() AS database_name
        `

        if (rows[0]?.database_name !== "vendly_test") {
            throw new Error("The PostgreSQL connection did not resolve to vendly_test.")
        }

        return prisma
    } catch (error) {
        await prisma.$disconnect()
        throw error
    }
}
