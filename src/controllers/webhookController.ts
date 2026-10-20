import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma, type PaymentProvider } from "../generated/prisma/client.js"
import { getPaymentProvider } from "../lib/payments/providers.js"
import { syncRefundsForPayment } from "../lib/payments/refunds.js"
import { syncPayment } from "./paymentController.js"

// Receives a provider's webhooks. The body arrives as raw bytes so the signature can be checked
// against exactly what was sent. A payment event is never trusted on its own: it only prompts
// Vendly to verify the reference with the provider and settle through the shared path. Each
// event is recorded once; a redelivered event that was already processed is acknowledged
// without repeating any work. Answering 500 asks the provider to deliver the event again.
export function handlePaymentWebhook(provider: PaymentProvider) {
    return async (req: Request, res: Response) => {
        const rawBody = req.body

        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
            res.status(400).send({ message: "Webhook body is missing" })
            return
        }

        const adapter = getPaymentProvider(provider)

        if (!adapter.verifyWebhook(rawBody, req.headers)) {
            console.warn("Rejected a payment webhook with an invalid signature", { provider })
            res.status(401).send({ message: "Invalid signature" })
            return
        }

        const event = adapter.parseWebhook(rawBody)

        if (!event) {
            res.status(400).send({ message: "Unrecognised webhook event" })
            return
        }

        // A refund event only prompts Vendly to ask the provider about that payment's open refunds.
        // That check is safe to repeat, so these events are not recorded or deduplicated.
        if (event.isRefundEvent) {
            if (event.reference) {
                try {
                    await syncRefundsForPayment(provider, event.reference)
                } catch (error) {
                    console.error("Refund webhook processing failed", {
                        provider,
                        reference: event.reference,
                        reason: error instanceof Error ? error.message : undefined
                    })
                    res.status(500).send({ message: "Sorry there is an issue on our end" })
                    return
                }
            }

            res.send({ message: "Event received" })
            return
        }

        if (!event.isPaymentEvent || !event.reference) {
            res.send({ message: "Event ignored" })
            return
        }

        const eventWhere = { provider_eventKey: { provider, eventKey: event.eventKey } }

        try {
            await prisma.paymentEvent.create({
                data: { provider, eventKey: event.eventKey, eventType: event.eventType, reference: event.reference }
            })
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
                throw error
            }

            const recorded = await prisma.paymentEvent.findUniqueOrThrow({ where: eventWhere })

            if (recorded.processedAt) {
                res.send({ message: "Event already processed" })
                return
            }
        }

        const attempt = await prisma.paymentAttempt.findUnique({ where: { reference: event.reference } })

        if (!attempt || attempt.provider !== provider) {
            console.warn("Payment webhook for an unknown reference", { provider, reference: event.reference })
        } else {
            try {
                await syncPayment(attempt)
            } catch (error) {
                console.error("Payment webhook processing failed", {
                    provider,
                    reference: event.reference,
                    reason: error instanceof Error ? error.message : undefined
                })
                res.status(500).send({ message: "Sorry there is an issue on our end" })
                return
            }

            const current = await prisma.paymentAttempt.findUniqueOrThrow({
                where: { id: attempt.id },
                select: { status: true }
            })

            if (current.status === "FAILED") {
                // A success reported for an attempt Vendly already closed needs manual recovery.
                console.error("Payment webhook reported success for a closed payment", {
                    provider,
                    reference: event.reference
                })
            }
        }

        await prisma.paymentEvent.update({ where: eventWhere, data: { processedAt: new Date() } })
        res.send({ message: "Event received" })
    }
}
