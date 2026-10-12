import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { Prisma, PrismaClient } from "../src/generated/prisma/client.js"
import { connectTestDatabase } from "../scripts/testDatabase.js"

let prisma: PrismaClient

before(async () => {
    prisma = await connectTestDatabase()
})

after(async () => {
    await prisma?.$disconnect()
})

test("connects to the dedicated PostgreSQL test database with Serializable transactions", async () => {
    const databases = await prisma.$queryRaw<Array<{ database_name: string }>>`
        SELECT current_database() AS database_name
    `
    assert.equal(databases[0]?.database_name, "vendly_test")

    const isolation = await prisma.$transaction(
        (tx) => tx.$queryRaw<Array<{ transaction_isolation: string }>>`
            SHOW transaction_isolation
        `,
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    assert.equal(isolation[0]?.transaction_isolation, "serializable")
})
