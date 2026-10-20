import { syncPayment } from "../../controllers/paymentController.js"
import { escalateOverdueDisputes } from "../disputes.js"
import { checkOpenRefunds } from "./refunds.js"
import { purgeStaleAccountRecords } from "../accountCleanup.js"
import { purgeOldRefreshTokens } from "../sessions.js"
import prisma from "../prisma.js"

const checkIntervalMs = 5 * 60 * 1000
// Paystack sends no webhook for failed or abandoned payments, so payments still pending this long
// after they started are checked with the provider.
const pendingCheckAfterMs = 10 * 60 * 1000
// A payment checked more recently than this (by any request or another server) is skipped.
const recheckAfterMs = 4 * 60 * 1000
const maximumPaymentsPerRun = 20

// Checks stuck payments once: pending payments older than 10 minutes, and verified payments whose
// checkout has not been settled yet (unless a recovery case already covers them). Each payment is
// claimed by stamping lastCheckedAt, so several servers never check the same payment at once.
// Provider calls happen outside database transactions. Does nothing when nothing is waiting.
export async function checkStuckPayments(now = new Date()): Promise<number> {
    const recheckCutoff = new Date(now.getTime() - recheckAfterMs)
    const notRecentlyChecked = [{ lastCheckedAt: null }, { lastCheckedAt: { lte: recheckCutoff } }]
    const candidates = await prisma.paymentAttempt.findMany({
        where: {
            OR: [
                { status: "PENDING", createdAt: { lte: new Date(now.getTime() - pendingCheckAfterMs) } },
                { status: "SUCCESS", checkout: { status: { not: "COMPLETED" } }, recoveryCase: null }
            ],
            AND: [{ OR: notRecentlyChecked }]
        },
        orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        take: maximumPaymentsPerRun
    })
    let checked = 0

    for (const candidate of candidates) {
        const claimed = await prisma.paymentAttempt.updateMany({
            where: { id: candidate.id, status: candidate.status, OR: notRecentlyChecked },
            data: { lastCheckedAt: now }
        })

        if (claimed.count !== 1) {
            continue
        }

        checked++

        try {
            await syncPayment(candidate)
        } catch (error) {
            console.error("Stuck payment check failed", {
                reference: candidate.reference,
                reason: error instanceof Error ? error.message : undefined
            })
        }
    }

    return checked
}

// Runs the checker every 5 minutes inside the server process. Runs never overlap, and the timer
// does not keep the process alive on shutdown.
export function startPaymentChecker(): void {
    let running = false

    const timer = setInterval(async () => {
        if (running) {
            return
        }

        running = true

        try {
            await checkStuckPayments()
        } catch (error) {
            console.error("Stuck payment checker failed", { reason: error instanceof Error ? error.message : undefined })
        }

        try {
            await checkOpenRefunds()
        } catch (error) {
            console.error("Refund checker failed", { reason: error instanceof Error ? error.message : undefined })
        }

        try {
            await escalateOverdueDisputes()
        } catch (error) {
            console.error("Complaint escalation failed", { reason: error instanceof Error ? error.message : undefined })
        }

        try {
            await purgeOldRefreshTokens()
            await purgeStaleAccountRecords()
        } catch (error) {
            console.error("Old login cleanup failed", { reason: error instanceof Error ? error.message : undefined })
        } finally {
            running = false
        }
    }, checkIntervalMs)

    timer.unref()
}
