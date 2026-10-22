import prisma from "./prisma.js"
import { notifyDeliveryConfirmed, notifyDeliveryReminder, queueNotification } from "./notifications.js"

// Silence alone is not proof that a parcel arrived, so a seller's delivery report is never final by itself. But an
// order cannot wait for ever either. After the seller reports delivery, the buyer is reminded on day 4, and on day 7,
// if they have not answered and there is no open complaint, the order is closed as delivered. That closing is
// marked as automatic: it is not the buyer saying they received it, so a buyer can still report that it never arrived
// within the usual complaint period.
export const deliveryReminderAfterDays = 4
export const deliveryAutoCloseAfterDays = 7

const dayMs = 24 * 60 * 60 * 1000
const batchSize = 100
const activeComplaintStatuses = ["OPEN", "SELLER_AGREED", "UNDER_REVIEW"] as const

// Closes overdue orders, then reminds buyers whose time is running out. Each order is closed or reminded once:
// the writes are conditional, so several servers or repeated runs never repeat an email. An order with an open
// complaint is left alone until the complaint is decided.
export async function remindAndCloseDeliveries(now = new Date()): Promise<{ closed: number; reminded: number }> {
    const noActiveComplaint = { disputes: { none: { status: { in: [...activeComplaintStatuses] } } } }
    const overdue = await prisma.order.findMany({
        where: {
            status: "SHIPPED",
            deliveryReportedAt: { lte: new Date(now.getTime() - deliveryAutoCloseAfterDays * dayMs) },
            ...noActiveComplaint
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: batchSize
    })
    let closed = 0

    for (const { id } of overdue) {
        const result = await prisma.order.updateMany({
            where: {
                id,
                status: "SHIPPED",
                deliveryReportedAt: { lte: new Date(now.getTime() - deliveryAutoCloseAfterDays * dayMs) },
                ...noActiveComplaint
            },
            data: { status: "DELIVERED", deliveryAutoClosedAt: now }
        })

        if (result.count === 1) {
            closed++
            queueNotification("delivery closed", () => notifyDeliveryConfirmed(id, "SYSTEM"))
        }
    }

    const dueReminder = await prisma.order.findMany({
        where: {
            status: "SHIPPED",
            deliveryReportedAt: { lte: new Date(now.getTime() - deliveryReminderAfterDays * dayMs) },
            deliveryReminderSentAt: null,
            ...noActiveComplaint
        },
        select: { id: true, deliveryReportedAt: true },
        orderBy: { id: "asc" },
        take: batchSize
    })
    let reminded = 0

    for (const order of dueReminder) {
        const result = await prisma.order.updateMany({
            where: { id: order.id, status: "SHIPPED", deliveryReminderSentAt: null, ...noActiveComplaint },
            data: { deliveryReminderSentAt: now }
        })

        if (result.count === 1 && order.deliveryReportedAt) {
            reminded++
            const closesAt = new Date(order.deliveryReportedAt.getTime() + deliveryAutoCloseAfterDays * dayMs)
            queueNotification("delivery reminder", () => notifyDeliveryReminder(order.id, closesAt))
        }
    }

    return { closed, reminded }
}
