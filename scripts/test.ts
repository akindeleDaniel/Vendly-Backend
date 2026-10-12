import { spawnSync } from "node:child_process"
import { connectTestDatabase } from "./testDatabase.js"

async function run() {
    try {
        const prisma = await connectTestDatabase()
        await prisma.$disconnect()

        runCommand([
            "node_modules/prisma/build/index.js",
            "migrate",
            "deploy",
            "--schema=prisma/schema.prisma"
        ])
        runCommand([
            "--import",
            "tsx",
            "--test",
            "tests/postgres.integration.test.ts"
        ], process.execPath)
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Test setup failed.")
        process.exitCode = 1
    }
}

function runCommand(args: string[], command = process.execPath) {
    const result = spawnSync(command, args, {
        env: process.env,
        stdio: "inherit"
    })

    if (result.error) {
        throw new Error(`Unable to start test command: ${result.error.message}`)
    }

    if (result.status !== 0) {
        throw new Error(`Test command failed with exit status ${result.status ?? "unknown"}.`)
    }
}

await run()
