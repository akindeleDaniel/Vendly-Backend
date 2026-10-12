import assert from "node:assert/strict"
import { test } from "node:test"
import { getTestDatabaseUrl } from "../scripts/testDatabase.js"

const testUrl = "postgresql://test:test@localhost:5433/vendly_test?schema=public"
const developmentUrl = "postgresql://dev:dev@localhost:5432/vendly"
const repeatedTestUrl = "postgresql://test:test@localhost:5432/vendly_test?schema=public"

function configuredTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        VENDLY_TEST_DATABASE: "vendly_test",
        VENDLY_ORIGINAL_DATABASE_URL: developmentUrl,
        TEST_DATABASE_URL: testUrl,
        ...overrides
    }
}

test("requires an explicit test database selection", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({ VENDLY_TEST_DATABASE: undefined })),
        /explicitly select the test database/
    )
})

test("rejects missing test database configuration", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({ TEST_DATABASE_URL: undefined })),
        /Both TEST_DATABASE_URL/
    )
})

test("rejects test URLs that point to the development database", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({ TEST_DATABASE_URL: "postgresql://localhost:5432/vendly" })),
        /must target a database named vendly_test/
    )
})

test("rejects identical development and test database targets regardless of credentials", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({
            VENDLY_ORIGINAL_DATABASE_URL: "postgresql://dev:dev@localhost:5432/vendly_test",
            TEST_DATABASE_URL: "postgresql://test:test@localhost/vendly_test"
        })),
        /must not target the development database/
    )
})

test("accepts an explicitly selected distinct vendly_test database", () => {
    assert.equal(getTestDatabaseUrl(configuredTestEnv()), testUrl)
})

test("accepts explicitly approved local PostgreSQL hosts", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]"]) {
        const url = `postgresql://${host}/vendly_test`
        assert.equal(
            getTestDatabaseUrl(configuredTestEnv({ TEST_DATABASE_URL: url })),
            url
        )
    }
})

test("rejects PostgreSQL servers outside the local test host allowlist", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({
            TEST_DATABASE_URL: "postgresql://db.production.example:5432/vendly_test"
        })),
        /host must be localhost, 127\.0\.0\.1, or ::1/
    )
})

test("rejects malformed test database URLs before connecting", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({ TEST_DATABASE_URL: "postgresql:///vendly_test" })),
        /must identify a PostgreSQL host and database/
    )
})

test("normalizes loopback hostnames for development target collision checks", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({
            VENDLY_ORIGINAL_DATABASE_URL: "postgresql://dev:dev@LOCALHOST:5432/vendly_test",
            TEST_DATABASE_URL: "postgresql://test:test@[::1]/vendly_test"
        })),
        /must not target the development database/
    )
})

test("revalidates against the preserved development target after DATABASE_URL changes", () => {
    assert.equal(
        getTestDatabaseUrl(configuredTestEnv({
            DATABASE_URL: repeatedTestUrl,
            TEST_DATABASE_URL: repeatedTestUrl
        })),
        repeatedTestUrl
    )
})

test("rejects a repeated test target that collides with the preserved development target", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({
            DATABASE_URL: repeatedTestUrl,
            VENDLY_ORIGINAL_DATABASE_URL: repeatedTestUrl,
            TEST_DATABASE_URL: repeatedTestUrl
        })),
        /must not target the development database/
    )
})

test("rejects repeated validation when the original development target is missing", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({
            DATABASE_URL: repeatedTestUrl,
            VENDLY_ORIGINAL_DATABASE_URL: undefined,
            TEST_DATABASE_URL: repeatedTestUrl
        })),
        /could not be established safely/
    )
})

test("rejects a malformed preserved original development target", () => {
    assert.throws(
        () => getTestDatabaseUrl(configuredTestEnv({
            DATABASE_URL: repeatedTestUrl,
            VENDLY_ORIGINAL_DATABASE_URL: "not-a-database-url",
            TEST_DATABASE_URL: repeatedTestUrl
        })),
        /DATABASE_URL must be a valid PostgreSQL connection URL/
    )
})
