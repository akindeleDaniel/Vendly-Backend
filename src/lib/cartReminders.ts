import { createHmac, timingSafeEqual } from "node:crypto"
import prisma from "./prisma.js"
import config from "../config.js"
import { notifyCartReminder, queueNotification } from "./notifications.js"

// One reminder email to a signed-in shopper who left things in their cart: about a day after they last added or
// changed something, while at least one item can still be bought. Changing the cart again allows one more reminder
// later. Carts left alone for over a week are not reminded at all, and nor is anyone in the middle of paying, anyone
// whose email is not confirmed, or anyone who switched these emails off.
export const cartReminderAfterHours = 24
export const cartReminderStopAfterDays = 7

const hourMs = 60 * 60 * 1000
const batchSize = 100

function cartsDue(now: Date) {
    return {
        itemsChangedAt: {
            lte: new Date(now.getTime() - cartReminderAfterHours * hourMs),
            gte: new Date(now.getTime() - cartReminderStopAfterDays * 24 * hourMs)
        },
        reminderSentAt: null,
        user: {
            cartRemindersOff: false,
            emailVerifiedAt: { not: null },
            checkouts: { none: { status: { in: ["PENDING" as const, "PAYMENT_PENDING" as const] }, expiresAt: { gt: now } } }
        },
        cartItems: {
            some: { listing: { archivedAt: null, stockQuantity: { gt: 0 }, user: { sellerProfile: { is: { blockedAt: null } } } } }
        }
    }
}

// Sends the reminders that are due. Each cart is claimed with a conditional write first, so several servers or
// repeated runs never send the same reminder twice.
export async function sendCartReminders(now = new Date()): Promise<number> {
    const due = await prisma.cart.findMany({ where: cartsDue(now), select: { id: true }, orderBy: { id: "asc" }, take: batchSize })
    let sent = 0

    for (const { id } of due) {
        const claimed = await prisma.cart.updateMany({ where: { id, ...cartsDue(now) }, data: { reminderSentAt: now } })

        if (claimed.count === 1) {
            sent++
            queueNotification("cart reminder", () => notifyCartReminder(id))
        }
    }

    return sent
}

// The "stop these emails" link works without logging in, so it carries a signature that only this server can make.
function sign(userId: number): string {
    const secret = process.env.JWT_SECRET

    if (!secret) {
        throw new Error("JWT_SECRET is not set")
    }

    return createHmac("sha256", secret).update(`cart-reminders-off:${userId}`).digest("base64url")
}

export function cartReminderStopUrl(userId: number): string {
    return `${config.publicApiUrl}/email/cart-reminders/stop?u=${userId}&t=${sign(userId)}`
}

// The user id the link was made for, or null when it was changed or made up.
export function readCartReminderStopLink(u: unknown, t: unknown): number | null {
    if (typeof u !== "string" || !/^[1-9]\d{0,9}$/.test(u) || typeof t !== "string" || t.length > 100) {
        return null
    }

    const userId = Number(u)
    const expected = Buffer.from(sign(userId))
    const given = Buffer.from(t)
    return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null
}
