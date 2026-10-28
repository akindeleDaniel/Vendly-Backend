import { createHash } from "node:crypto"
import type { Request } from "express"
import prisma from "./prisma.js"

// How many people look at a shop and its products, so sellers can see what draws interest and what turns into
// orders. A view is counted when a product or shop page is opened, once per visitor per day per page. A visitor is
// told apart by a one-way code made from their connection details and the date, kept for two days to avoid counting
// twice; no address, name or account is stored with the counts. Robots (link previews, search engines) do not count.
const robots = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|headless|curl|wget|python|postman/i
export const viewSeenKeepDays = 2

// Today's date in Nigeria as a date with no time (UTC+1 all year).
function lagosDay(now: Date): string {
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10)
}

// Counts one view of a product or shop, if this visitor has not been counted for it today. Never throws: a failed
// count must not break the page.
export async function recordView(req: Request, kind: "PRODUCT" | "SHOP", subjectId: number, sellerId: number, now = new Date()): Promise<void> {
    try {
        const userAgent = req.get("user-agent") ?? ""

        if (userAgent === "" || robots.test(userAgent)) {
            return
        }

        const day = lagosDay(now)
        const visitor = createHash("sha256")
            .update(`${process.env.JWT_SECRET ?? ""}:${req.ip ?? ""}:${userAgent}:${day}`)
            .digest("hex")
        const firstToday = await prisma.$executeRaw`
            INSERT INTO "ViewSeen" ("visitor", "kind", "subjectId", "createdAt")
            VALUES (${visitor}, ${kind}::"ViewKind", ${subjectId}, ${now})
            ON CONFLICT DO NOTHING`

        if (firstToday === 0) {
            return
        }

        await prisma.$executeRaw`
            INSERT INTO "ViewDay" ("kind", "subjectId", "sellerId", "day", "views")
            VALUES (${kind}::"ViewKind", ${subjectId}, ${sellerId}, ${day}::date, 1)
            ON CONFLICT ("kind", "subjectId", "day") DO UPDATE SET "views" = "ViewDay"."views" + 1`
    } catch (error) {
        console.error("Could not count a view", { reason: error instanceof Error ? error.message : undefined })
    }
}

// The "already counted today" codes are only needed for a day; older ones are removed by the housekeeping job.
export async function purgeOldViewVisitors(now = new Date()): Promise<number> {
    const result = await prisma.viewSeen.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - viewSeenKeepDays * 24 * 60 * 60 * 1000) } } })
    return result.count
}
