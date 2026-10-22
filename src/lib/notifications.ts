import config from "../config.js"
import prisma from "./prisma.js"
import { sendEmail, type OutgoingEmail } from "./email/index.js"

// Emails about what happens to a person's account, orders, refunds and complaints. Every notification is
// queued after the change it describes has been saved, and a failure to send is only logged: an email that
// cannot be sent never undoes or delays the thing it is about. Emails never contain addresses, phone
// numbers or anything else one side should not see about the other; they point to the page that does.

const pending = new Set<Promise<void>>()

export function queueNotification(label: string, work: () => Promise<void>): void {
    const run: Promise<void> = work()
        .catch((error: unknown) => {
            console.error("Could not send a notification", { label, reason: error instanceof Error ? error.message : undefined })
        })
        .finally(() => {
            pending.delete(run)
        })

    pending.add(run)
}

// Resolves once every queued notification has been sent or has failed. Shutdown waits for this, and so do tests.
export async function waitForNotifications(): Promise<void> {
    while (pending.size > 0) {
        await Promise.all([...pending])
    }
}

function naira(value: { toString(): string } | number): string {
    return `₦${Number(value.toString()).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Dates in emails are shown in Nigerian time.
function lagosTime(date: Date): string {
    return date.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "full", timeStyle: "short" })
}

function mail(to: string, subject: string, paragraphs: string[], action?: { label: string; path: string }): OutgoingEmail {
    const lines = [...paragraphs]

    if (action) {
        lines.push(`${action.label}: ${config.frontendUrl}${action.path}`)
    }

    return { to, subject, text: [...lines.flatMap((line) => [line, ""]), "The Vendly team"].join("\n") }
}

// One email failing must not stop the others in the same event.
async function sendAll(emails: OutgoingEmail[]): Promise<void> {
    for (const email of emails) {
        try {
            await sendEmail(email)
        } catch (error) {
            console.error("Could not send an email", { subject: email.subject, reason: error instanceof Error ? error.message : undefined })
        }
    }
}

function itemLines(items: Array<{ title: string; quantity: number }>): string {
    return items.map((item) => `  ${item.quantity} × ${item.title}`).join("\n")
}

// ---- accounts ----

export async function notifyWelcome(userId: number): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, role: true } })

    if (!user) {
        return
    }

    await sendAll([
        user.role === "SELLER"
            ? mail(user.email, "Welcome to Vendly", [
                `Welcome to Vendly, ${user.name}.`,
                "To start selling, set up your shop, add your payout bank account so customers' payments reach you, and add your first products."
            ], { label: "Set up your shop", path: "/seller/onboarding" })
            : mail(user.email, "Welcome to Vendly", [
                `Welcome to Vendly, ${user.name}.`,
                "Browse shops near you, add what you like to your cart and pay securely. You can follow every order from your account."
            ], { label: "Start shopping", path: "/" })
    ])
}

export async function notifyPasswordChanged(userId: number, how: "changed" | "reset" | "set"): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })

    if (!user) {
        return
    }

    const what = how === "set" ? "A password was added to your Vendly account" : how === "reset" ? "Your Vendly password was reset" : "Your Vendly password was changed"
    const when = lagosTime(new Date())

    await sendAll([
        mail(user.email, how === "set" ? "A password was added to your account" : "Your password was changed", [
            `${what} on ${when}.`,
            how === "changed" || how === "set"
                ? "You were logged out of your other devices."
                : "Every device was logged out, so log in again with your new password.",
            "If this was not you, reset your password straight away and contact Vendly support: someone else may have access to your email."
        ], { label: "Log in", path: "/login" })
    ])
}

// ---- orders ----

// A payment has been confirmed and its orders created: the buyer gets a receipt, and each seller a new-order alert.
export async function notifyPaymentSettled(attemptId: number): Promise<void> {
    const attempt = await prisma.paymentAttempt.findUnique({
        where: { id: attemptId },
        select: {
            amount: true,
            checkout: {
                select: {
                    id: true,
                    user: { select: { email: true, name: true } },
                    orders: {
                        orderBy: { id: "asc" },
                        select: {
                            id: true,
                            total: true,
                            sellerReceives: true,
                            liabilityDeduction: true,
                            deliveryState: true,
                            deliveryLga: true,
                            fulfilmentType: true,
                            readyAt: true,
                            orderItems: { orderBy: { id: "asc" }, select: { title: true, quantity: true } },
                            seller: { select: { email: true, sellerProfile: { select: { businessName: true } } } }
                        }
                    }
                }
            }
        }
    })

    if (!attempt) {
        return
    }

    const { checkout } = attempt
    const emails: OutgoingEmail[] = [
        mail(checkout.user.email, `Payment received: ${naira(attempt.amount)}`, [
            `Thank you ${checkout.user.name}, we received your payment of ${naira(attempt.amount)}.`,
            ...checkout.orders.map((order) =>
                `From ${order.seller.sellerProfile?.businessName ?? "the seller"} (${naira(order.total)}):\n${itemLines(order.orderItems)}${order.fulfilmentType === "PRE_ORDER" && order.readyAt ? `\n  Pre-order, to be ready: ${lagosTime(order.readyAt)}` : ""}`),
            "The seller will now prepare your order. We will tell you when it ships."
        ], { label: "See your order", path: `/orders/${checkout.id}` })
    ]

    for (const order of checkout.orders) {
        const kept = Number(order.liabilityDeduction.toString()) > 0
            ? [`${naira(order.liabilityDeduction)} of this payment was kept by Vendly to recover money refunded to buyers for your earlier orders.`]
            : []

        emails.push(mail(order.seller.email, `New order: ${naira(order.total)}`, [
            `You have a new paid order of ${naira(order.total)}, to be delivered in ${order.deliveryLga}, ${order.deliveryState}:`,
            itemLines(order.orderItems),
            ...(order.fulfilmentType === "PRE_ORDER" && order.readyAt ? [`This is a pre-order you approved: it must be ready on ${lagosTime(order.readyAt)}.`] : []),
            ...(order.sellerReceives ? [`After the payment provider's fee, ${naira(order.sellerReceives)} goes to your bank account.`] : []),
            ...kept,
            "Open the order to see the delivery details, then mark it shipped."
        ], { label: "Open the order", path: `/seller/orders/${order.id}` }))
    }

    await sendAll(emails)
}

async function loadOrderForNotice(orderId: number) {
    return prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            checkoutId: true,
            shippingNote: true,
            orderItems: { orderBy: { id: "asc" }, select: { title: true, quantity: true } },
            seller: { select: { email: true, sellerProfile: { select: { businessName: true } } } },
            checkout: { select: { user: { select: { email: true, name: true } } } }
        }
    })
}

export async function notifyShipped(orderId: number): Promise<void> {
    const order = await loadOrderForNotice(orderId)

    if (!order) {
        return
    }

    const shop = order.seller.sellerProfile?.businessName ?? "The seller"

    await sendAll([
        mail(order.checkout.user.email, `Your order from ${shop} has shipped`, [
            `${shop} has shipped your order:`,
            itemLines(order.orderItems),
            ...(order.shippingNote ? [`Note from the seller: ${order.shippingNote}`] : []),
            "When it arrives, please confirm that you received it."
        ], { label: "See your order", path: `/orders/${order.checkoutId}` })
    ])
}

export async function notifyDeliveryReported(orderId: number): Promise<void> {
    const order = await loadOrderForNotice(orderId)

    if (!order) {
        return
    }

    const shop = order.seller.sellerProfile?.businessName ?? "The seller"

    await sendAll([
        mail(order.checkout.user.email, `${shop} says your order was delivered. Please confirm`, [
            `${shop} says your order was delivered:`,
            itemLines(order.orderItems),
            "Please confirm that you received it, or report a problem if you did not or something is wrong.",
            "If we hear nothing from you within 7 days and there is no complaint, the order will be closed automatically. You can still report a problem about it afterwards."
        ], { label: "Confirm or report a problem", path: `/orders/${order.checkoutId}` })
    ])
}

export async function notifyDeliveryConfirmed(orderId: number, by: "BUYER" | "SYSTEM"): Promise<void> {
    const order = await loadOrderForNotice(orderId)

    if (!order) {
        return
    }

    const emails = [
        mail(order.seller.email, by === "BUYER" ? `Order #${order.id} was confirmed as received` : `Order #${order.id} was closed as delivered`, [
            by === "BUYER"
                ? `The buyer confirmed that order #${order.id} arrived.`
                : `Order #${order.id} was closed automatically because the buyer did not reply within 7 days of your delivery report.`,
            itemLines(order.orderItems)
        ], { label: "Open the order", path: `/seller/orders/${order.id}` })
    ]

    if (by === "SYSTEM") {
        emails.push(mail(order.checkout.user.email, "Your order was closed as delivered", [
            `We did not hear from you within 7 days of the seller reporting delivery, so your order from ${order.seller.sellerProfile?.businessName ?? "the seller"} was closed as delivered:`,
            itemLines(order.orderItems),
            "If something is wrong, you can still report a problem."
        ], { label: "See your order", path: `/orders/${order.checkoutId}` }))
    }

    await sendAll(emails)
}

export async function notifyDeliveryReminder(orderId: number, closesAt: Date): Promise<void> {
    const order = await loadOrderForNotice(orderId)

    if (!order) {
        return
    }

    await sendAll([
        mail(order.checkout.user.email, "Did your order arrive?", [
            `${order.seller.sellerProfile?.businessName ?? "The seller"} reported your order as delivered, and we have not heard from you:`,
            itemLines(order.orderItems),
            `Please confirm that you received it, or report a problem. If you do neither, it will be closed as delivered on ${lagosTime(closesAt)}.`
        ], { label: "Confirm or report a problem", path: `/orders/${order.checkoutId}` })
    ])
}

// ---- refunds ----

// The buyer hears about each step of a refund: started, completed, failed, or taking longer.
export async function notifyRefundProgress(refundId: number, status: "PROCESSING" | "SUCCEEDED" | "FAILED" | "NEEDS_ATTENTION"): Promise<void> {
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: {
            amount: true,
            customerNote: true,
            order: { select: { id: true, checkoutId: true, checkout: { select: { user: { select: { email: true } } } } } },
            paymentAttempt: { select: { checkout: { select: { id: true, user: { select: { email: true } } } } } }
        }
    })

    if (!refund) {
        return
    }

    const email = refund.order?.checkout.user.email ?? refund.paymentAttempt.checkout.user.email
    const checkoutId = refund.order?.checkoutId ?? refund.paymentAttempt.checkout.id
    const forOrder = refund.order ? `order #${refund.order.id}` : "your payment"
    const note = refund.customerNote ? [`Note from Vendly: ${refund.customerNote}`] : []
    const amount = naira(refund.amount)

    const subject = {
        PROCESSING: `Your refund of ${amount} has started`,
        SUCCEEDED: `Your refund of ${amount} is complete`,
        FAILED: `Your refund of ${amount} could not be completed`,
        NEEDS_ATTENTION: `Your refund of ${amount} needs a little more time`
    }[status]
    const body = {
        PROCESSING: `We have started refunding ${amount} for ${forOrder} to your original payment method. Banks usually take a few working days to show it.`,
        SUCCEEDED: `The refund of ${amount} for ${forOrder} has been sent to your original payment method. Banks usually take a few working days to show it.`,
        FAILED: `The refund of ${amount} for ${forOrder} could not be completed by the payment provider. Vendly has been told and will deal with it; you do not need to do anything.`,
        NEEDS_ATTENTION: `The payment provider needs more time to refund ${amount} for ${forOrder}. Vendly is following it up and will tell you if we need anything from you.`
    }[status]

    await sendAll([mail(email, subject, [body, ...note], { label: "See your order", path: `/orders/${checkoutId}` })])
}

// The seller is told, with the reason, that Vendly refunded a buyer and will take the money back from later sales.
export async function notifySellerCharged(refundId: number): Promise<void> {
    const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        select: { amount: true, reason: true, order: { select: { id: true, seller: { select: { email: true } } } } }
    })

    if (!refund?.order) {
        return
    }

    await sendAll([
        mail(refund.order.seller.email, `Vendly refunded a buyer for order #${refund.order.id}`, [
            `Vendly refunded ${naira(refund.amount)} to the buyer of order #${refund.order.id}.`,
            `Reason: ${refund.reason}`,
            "As agreed in the payout terms, this amount is now owed to Vendly. It is taken from your later orders (at most half of each payment) until it is repaid.",
            "You can see what you owe, and every deduction, on your page."
        ], { label: "See what you owe", path: "/seller/liabilities" })
    ])
}

// ---- complaints ----

function excerpt(text: string): string {
    const clean = text.replace(/\s+/g, " ").trim()
    return clean.length > 300 ? `${clean.slice(0, 297)}...` : clean
}

// Sent after each change to a complaint, to the people who did not make it. Every change to a complaint writes
// one message in its thread, so the newest message says what just happened.
export async function notifyComplaintActivity(disputeId: number): Promise<void> {
    const dispute = await prisma.dispute.findUnique({
        where: { id: disputeId },
        select: {
            id: true,
            openedBy: true,
            status: true,
            outcome: true,
            responseDueAt: true,
            order: {
                select: {
                    id: true,
                    seller: { select: { email: true, sellerProfile: { select: { businessName: true } } } },
                    checkout: { select: { user: { select: { email: true } } } }
                }
            },
            messages: { orderBy: { id: "asc" }, select: { author: true, body: true } }
        }
    })
    const latest = dispute?.messages.at(-1)

    if (!dispute || !latest) {
        return
    }

    const orderLabel = `order #${dispute.order.id}`
    const buyerEmail = dispute.order.checkout.user.email
    const sellerEmail = dispute.order.seller.email
    const isFirst = dispute.messages.length === 1
    const buyerLink = { label: "Open the complaint", path: `/disputes/${dispute.id}` }
    const sellerLink = { label: "Open the complaint", path: `/seller/disputes/${dispute.id}` }
    const said = excerpt(latest.body)
    const statusLine = dispute.status === "OPEN"
        ? "It is waiting for the seller's answer."
        : dispute.status === "SELLER_AGREED"
            ? "The seller agreed, and it is waiting for Vendly to approve the refund."
            : dispute.status === "UNDER_REVIEW"
                ? "It is with Vendly for a decision."
                : dispute.status === "RESOLVED"
                    ? dispute.outcome === "REFUNDED" ? "It is resolved: a refund was approved." : "It is resolved: Vendly did not approve a refund."
                    : "It has been closed."

    const emails: OutgoingEmail[] = []

    if (latest.author === "BUYER") {
        emails.push(isFirst
            ? mail(sellerEmail, `New complaint about ${orderLabel}: please answer`, [
                `A buyer has reported a problem with ${orderLabel}.`,
                `They wrote: "${said}"`,
                `Please answer by ${lagosTime(dispute.responseDueAt)}. If you do not, it goes to Vendly to decide.`
            ], sellerLink)
            : mail(sellerEmail, `New message about the complaint on ${orderLabel}`, [`The buyer wrote: "${said}"`, statusLine], sellerLink))
    } else if (latest.author === "SELLER") {
        emails.push(isFirst && dispute.openedBy === "SELLER"
            ? mail(buyerEmail, `The seller offered you a refund for ${orderLabel}`, [
                "The seller has offered to refund your order, and Vendly will review it.",
                `They wrote: "${said}"`
            ], buyerLink)
            : mail(buyerEmail, `The seller replied about ${orderLabel}`, [`The seller wrote: "${said}"`, statusLine], buyerLink))
    } else if (latest.author === "ADMIN") {
        const subject = dispute.status === "RESOLVED"
            ? dispute.outcome === "REFUNDED" ? `Vendly approved a refund for ${orderLabel}` : `Vendly's decision on the complaint about ${orderLabel}`
            : `Vendly wrote in the complaint about ${orderLabel}`
        const paragraphs = [`Vendly wrote: "${said}"`, statusLine]
        emails.push(mail(buyerEmail, subject, paragraphs, buyerLink), mail(sellerEmail, subject, paragraphs, sellerLink))
    } else {
        const subject = dispute.status === "WITHDRAWN" ? `The complaint about ${orderLabel} was withdrawn` : `The complaint about ${orderLabel} was passed to Vendly`
        const paragraphs = [said, statusLine]
        emails.push(mail(buyerEmail, subject, paragraphs, buyerLink), mail(sellerEmail, subject, paragraphs, sellerLink))
    }

    await sendAll(emails)
}

// ---- reviews ----

// A buyer reviewed a delivered order: the seller is told the stars and what was written (no reply is possible).
export async function notifyNewReviews(productReviewIds: number[], shopReviewId: number | null): Promise<void> {
    const [products, shop] = await Promise.all([
        prisma.productReview.findMany({
            where: { id: { in: productReviewIds } },
            select: { rating: true, comment: true, listing: { select: { title: true, user: { select: { email: true } } } } }
        }),
        shopReviewId === null
            ? Promise.resolve(null)
            : prisma.shopReview.findUnique({
                where: { id: shopReviewId },
                select: { rating: true, comment: true, sellerProfile: { select: { businessName: true, user: { select: { email: true } } } } }
            })
    ])
    const sellerEmail = shop?.sellerProfile.user.email ?? products[0]?.listing.user.email

    if (!sellerEmail) {
        return
    }

    const stars = (rating: number) => `${rating} out of 5 stars`
    const lines = [
        ...(shop ? [`Your shop: ${stars(shop.rating)}${shop.comment ? `: "${excerpt(shop.comment)}"` : ""}`] : []),
        ...products.map((review) => `${review.listing.title}: ${stars(review.rating)}${review.comment ? `: "${excerpt(review.comment)}"` : ""}`)
    ]

    await sendAll([
        mail(sellerEmail, "A buyer reviewed your order", [
            "A buyer whose order was delivered has left a review:",
            lines.join("\n"),
            "If a review breaks the rules, you can report it and Vendly will look at it."
        ], { label: "See your reviews", path: "/seller/reviews" })
    ])
}

// ---- pre-orders ----

export type PreOrderEvent = "REQUESTED" | "APPROVED" | "DECLINED" | "CANCELLED" | "EXPIRED_UNANSWERED" | "EXPIRED_UNPAID"

export async function notifyPreOrderUpdate(requestId: number, event: PreOrderEvent): Promise<void> {
    const request = await prisma.preOrderRequest.findUnique({
        where: { id: requestId },
        select: {
            id: true,
            readyAt: true,
            note: true,
            sellerNote: true,
            payBy: true,
            items: true,
            buyer: { select: { email: true, name: true } },
            seller: { select: { email: true, sellerProfile: { select: { businessName: true } } } }
        }
    })

    if (!request) {
        return
    }

    const shop = request.seller.sellerProfile?.businessName ?? "the shop"
    const lines = Array.isArray(request.items)
        ? request.items.flatMap((entry) => {
            const item = entry as { listingId?: number; quantity?: number } | null
            return item && typeof item.quantity === "number" ? [item.quantity] : []
        })
        : []
    const count = lines.reduce((sum, quantity) => sum + quantity, 0)
    const ready = lagosTime(request.readyAt)
    const buyerLink = { label: "See your pre-order", path: `/pre-orders/${request.id}` }
    const sellerLink = { label: "Answer the request", path: `/seller/pre-orders/${request.id}` }

    if (event === "REQUESTED") {
        await sendAll([mail(request.seller.email, "A buyer asked for a pre-order", [
            `A buyer wants ${count} item${count === 1 ? "" : "s"} ready on ${ready}.`,
            ...(request.note ? [`They wrote: "${excerpt(request.note)}"`] : []),
            "Please approve or decline. If you do not answer within 2 days, the request lapses and nothing is charged."
        ], sellerLink)])
    } else if (event === "APPROVED") {
        await sendAll([mail(request.buyer.email, `${shop} approved your pre-order`, [
            `${shop} can have your order ready on ${ready}.`,
            ...(request.sellerNote ? [`Note from the seller: "${excerpt(request.sellerNote)}"`] : []),
            `Pay for it by ${request.payBy ? lagosTime(request.payBy) : "the time shown in your pre-order"}, otherwise the approval lapses. Nothing has been charged yet.`
        ], { label: "Pay for your pre-order", path: "/cart" })])
    } else if (event === "DECLINED") {
        await sendAll([mail(request.buyer.email, `${shop} could not take your pre-order`, [
            `${shop} cannot have your order ready on ${ready}.`,
            ...(request.sellerNote ? [`Note from the seller: "${excerpt(request.sellerNote)}"`] : []),
            "Nothing was charged. You can ask again for a different time."
        ], buyerLink)])
    } else if (event === "CANCELLED") {
        await sendAll([mail(request.seller.email, "A pre-order request was cancelled", [
            `The buyer cancelled the pre-order request for ${ready}. Nothing more to do.`
        ])])
    } else if (event === "EXPIRED_UNANSWERED") {
        await sendAll([
            mail(request.buyer.email, `${shop} did not answer your pre-order`, [
                `${shop} did not answer your request for ${ready} in time, so it has lapsed. Nothing was charged.`,
                "You can ask again, or order something that is ready now."
            ], buyerLink),
            mail(request.seller.email, "A pre-order request lapsed", [`You did not answer the pre-order request for ${ready} in time, so it lapsed.`])
        ])
    } else {
        await sendAll([mail(request.buyer.email, "Your pre-order approval has lapsed", [
            `You did not pay for your approved pre-order from ${shop} in time, so the approval has lapsed. Nothing was charged.`,
            "You can ask again."
        ], buyerLink)])
    }
}
