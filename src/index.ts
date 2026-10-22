import "dotenv/config"
import config, { assertRequiredEnvironment } from "./config.js"
import { assertEmailEnvironment } from "./lib/email/config.js"
import app from "./app.js"
import prisma from "./lib/prisma.js"
import { startPaymentChecker } from "./lib/payments/paymentChecker.js"
import { waitForNotifications } from "./lib/notifications.js"

assertRequiredEnvironment(process.env)
assertEmailEnvironment(process.env)

const server = app.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`)
})
const stopPaymentChecker = startPaymentChecker()
// A host stops the server by sending SIGTERM (a deploy, a restart). Payments and refunds are in the middle of
// several steps, so the server stops taking new requests, lets the ones running finish, then closes the database.
const shutdownDeadlineMs = 25_000
let shuttingDown = false

async function shutDown(reason: string, exitCode: number) {
    if (shuttingDown) {
        return
    }

    shuttingDown = true
    console.log(`Shutting down (${reason})`)

    const forced = setTimeout(() => {
        console.error("Shutdown took too long, exiting anyway")
        process.exit(1)
    }, shutdownDeadlineMs)
    forced.unref()

    try {
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeIdleConnections()
        })
        await stopPaymentChecker()
        await waitForNotifications()
        await prisma.$disconnect()
    } catch (error) {
        console.error("Error while shutting down", error instanceof Error ? error.message : undefined)
        exitCode = 1
    }

    process.exit(exitCode)
}

process.on("SIGTERM", () => void shutDown("SIGTERM", 0))
process.on("SIGINT", () => void shutDown("SIGINT", 0))
// A promise nobody handled is a bug worth knowing about, but not worth stopping payments for.
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection", reason instanceof Error ? reason.message : reason)
})
// Anything else leaves the process in an unknown state: finish what is running and exit so the host restarts it.
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception", error)
    void shutDown("uncaught exception", 1)
})
