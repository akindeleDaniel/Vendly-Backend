import type { Prisma } from "../generated/prisma/client.js"
import { appealStatus, disputeReasonLabels } from "./disputes.js"

export type DisputeViewer = "BUYER" | "SELLER" | "ADMIN"

function money(amount: Prisma.Decimal): string {
    return amount.toFixed(2)
}

const orderSummarySelect = {
    id: true,
    checkoutId: true,
    status: true,
    total: true,
    deliveryName: true,
    seller: { select: { email: true, sellerProfile: { select: { businessName: true, slug: true } } } },
    checkout: { select: { user: { select: { name: true, email: true } } } },
    orderItems: { orderBy: { id: "asc" as const }, select: { title: true, quantity: true, unitPrice: true } }
}

// What a complaint list needs: the order it is about and when the thread last moved.
export const disputeListInclude = {
    order: { select: orderSummarySelect },
    messages: { orderBy: { id: "desc" as const }, take: 1, select: { createdAt: true, author: true } }
} satisfies Prisma.DisputeInclude

// A whole complaint: the order, the shared thread and any refunds made for it.
export const disputeDetailInclude = {
    order: { select: orderSummarySelect },
    messages: { orderBy: { id: "asc" as const } },
    refunds: {
        orderBy: { id: "asc" as const },
        select: { reference: true, amount: true, status: true, customerNote: true, reason: true, createdAt: true, completedAt: true }
    }
} satisfies Prisma.DisputeInclude

type ListRecord = Prisma.DisputeGetPayload<{ include: typeof disputeListInclude }>
type DetailRecord = Prisma.DisputeGetPayload<{ include: typeof disputeDetailInclude }>

export function toDisputeSummary(dispute: ListRecord) {
    const lastMessage = dispute.messages[0]

    return {
        id: dispute.id,
        orderId: dispute.orderId,
        // The buyer's order pages are addressed by checkout, so a complaint can link back to its order.
        checkoutId: dispute.order.checkoutId,
        reason: dispute.reason,
        reasonLabel: disputeReasonLabels[dispute.reason],
        openedBy: dispute.openedBy,
        status: dispute.status,
        outcome: dispute.outcome,
        requestedAmount: money(dispute.requestedAmount),
        approvedAmount: dispute.approvedAmount ? money(dispute.approvedAmount) : null,
        orderTotal: money(dispute.order.total),
        items: dispute.order.orderItems.map((item) => ({ title: item.title, quantity: item.quantity })),
        seller: { businessName: dispute.order.seller.sellerProfile?.businessName ?? null },
        buyerName: dispute.order.deliveryName,
        responseDueAt: dispute.responseDueAt,
        createdAt: dispute.createdAt,
        resolvedAt: dispute.resolvedAt,
        lastMessageAt: lastMessage?.createdAt ?? dispute.createdAt,
        lastMessageBy: lastMessage?.author ?? null
    }
}

// The full complaint as one party sees it. Both sides read the same thread. Contact details are for
// administrators only, and the reason given to a seller for a refund is not shown to the buyer.
export function toDisputeDetail(dispute: DetailRecord, viewer: DisputeViewer) {
    const { order } = dispute

    return {
        ...toDisputeSummary({ ...dispute, messages: dispute.messages.slice(-1).map((message) => ({ createdAt: message.createdAt, author: message.author })) }),
        decisionNote: dispute.decisionNote,
        // A rejection by StoreHatch can be appealed once, within 7 days: canAppeal and until when.
        appeal: appealStatus(dispute),
        sellerRespondedAt: dispute.sellerRespondedAt,
        escalatedAt: dispute.escalatedAt,
        order: {
            id: order.id,
            checkoutId: order.checkoutId,
            status: order.status,
            total: money(order.total),
            seller: order.seller.sellerProfile ? { businessName: order.seller.sellerProfile.businessName, slug: order.seller.sellerProfile.slug } : null,
            items: order.orderItems.map((item) => ({
                title: item.title,
                quantity: item.quantity,
                unitPrice: money(item.unitPrice),
                lineTotal: money(item.unitPrice.times(item.quantity))
            }))
        },
        messages: dispute.messages.map((message) => ({
            id: message.id,
            author: message.author,
            body: message.body,
            evidenceUrls: Array.isArray(message.evidenceUrls)
                ? message.evidenceUrls.filter((url): url is string => typeof url === "string")
                : [],
            createdAt: message.createdAt
        })),
        refunds: dispute.refunds.map((refund) => ({
            reference: refund.reference,
            amount: money(refund.amount),
            status: refund.status,
            note: refund.customerNote,
            ...(viewer === "BUYER" ? {} : { reason: refund.reason }),
            createdAt: refund.createdAt,
            completedAt: refund.completedAt
        })),
        ...(viewer === "ADMIN"
            ? {
                buyer: { name: order.checkout.user.name, email: order.checkout.user.email },
                sellerContact: { email: order.seller.email }
            }
            : {})
    }
}
