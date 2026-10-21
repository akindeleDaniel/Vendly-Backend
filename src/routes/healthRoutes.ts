import { Router } from "express"
import prisma from "../lib/prisma.js"

const router = Router()

// For the host's uptime checks: is the process running.
router.get("/", (_req, res) => {
    res.send({ status: "ok" })
})

// Can the process reach the database. A host should stop sending traffic to a server that answers 503.
router.get("/ready", async (_req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`
        res.send({ status: "ready" })
    } catch (error) {
        console.error("Readiness check failed", { reason: error instanceof Error ? error.message : undefined })
        res.status(503).send({ status: "unavailable" })
    }
})

export default router
