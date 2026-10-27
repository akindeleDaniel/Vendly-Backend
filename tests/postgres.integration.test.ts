import assert from "node:assert/strict"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import { after, before, test } from "node:test"
import cookieParser from "cookie-parser"
import express from "express"
import jwt from "jsonwebtoken"
import { Prisma, PrismaClient, type PaymentProvider } from "../src/generated/prisma/client.js"
import { connectTestDatabase } from "../scripts/testDatabase.js"
import checkoutRoutes from "../src/routes/checkoutRoutes.js"
import cartRoutes from "../src/routes/cartRoutes.js"
import listingRoutes from "../src/routes/listingRoutes.js"
import app from "../src/app.js"
import config, { assertRequiredEnvironment, loadConfig } from "../src/config.js"
import { payoutFeeTerms } from "../src/controllers/payoutController.js"
import { checkStuckPayments } from "../src/lib/payments/paymentChecker.js"
import { escalateOverdueDisputes } from "../src/lib/disputes.js"
import { checkOpenRefunds } from "../src/lib/payments/refunds.js"
import { purgeOldRefreshTokens } from "../src/lib/sessions.js"
import { setEmailSenderForTesting, type OutgoingEmail } from "../src/lib/email/index.js"
import { assertEmailEnvironment, loadEmailConfig } from "../src/lib/email/config.js"
import { otpDailyLimit } from "../src/lib/otp.js"
import { purgeStaleAccountRecords } from "../src/lib/accountCleanup.js"
import { setGoogleVerifierForTesting, type GoogleIdentity } from "../src/lib/google.js"
import { setRateLimitingForTesting } from "../src/middleware/rateLimits.js"
import { isHttpsUrl, priceProblem } from "../src/lib/inputRules.js"
import { startPaymentChecker } from "../src/lib/payments/paymentChecker.js"
import { waitForNotifications } from "../src/lib/notifications.js"
import { recalculateRating } from "../src/lib/reviews.js"
import { findStockAlerts } from "../src/lib/stockAlerts.js"
import { expirePreOrders } from "../src/lib/preOrders.js"
import { remindAndCloseDeliveries } from "../src/lib/deliveryClosing.js"
import { reviewSellerStanding } from "../src/lib/sellerStanding.js"
import { flutterwaveAdapter } from "../src/lib/payments/flutterwave.js"
import { paystackAdapter } from "../src/lib/payments/paystack.js"
import { setPaymentProvidersForTesting } from "../src/lib/payments/providers.js"
import {
    PaymentProviderError,
    type CreateRefundInput,
    type CreateSubaccountInput,
    type InitializePaymentInput,
    type PaymentVerification,
    type PaymentProviderAdapter,
    type ProviderRefund,
    type ProviderSubaccount,
    type ResolveAccountInput
} from "../src/lib/payments/types.js"
import bcrypt from "bcrypt"

let prisma: PrismaClient

// Most tests make hundreds of requests from one address; the tests of the limits switch limiting on for themselves.
setRateLimitingForTesting(false)

const sentEmails: OutgoingEmail[] = []
setEmailSenderForTesting(async (email) => { sentEmails.push(email) })

// Google sign-in tokens, as the fake verifier knows them: the token is just a key into this table.
const googleIdentities = new Map<string, GoogleIdentity>()
setGoogleVerifierForTesting(async (credential) => googleIdentities.get(credential) ?? null)

function googleToken(identity: GoogleIdentity): string {
    const credential = `fake-google-token-${randomUUID()}`
    googleIdentities.set(credential, identity)
    return credential
}

function newGoogleIdentity(prefix = "google"): GoogleIdentity {
    return { googleId: `google-sub-${randomUUID()}`, email: `${prefix}-${randomUUID()}@example.test`, name: "Grace Hopper" }
}

function emailsTo(address: string) {
    return sentEmails.filter((email) => email.to === address)
}

function codeSentTo(address: string): string {
    const email = emailsTo(address).findLast((candidate) => /Your StoreHatch code is \d{6}/.test(candidate.text))
    assert.ok(email, `No email with a code was sent to ${address}`)
    const match = /Your StoreHatch code is (\d{6})/.exec(email.text)
    assert.ok(match?.[1], "The email has no code in it")
    return match[1]
}

before(async () => {
    prisma = await connectTestDatabase()
})

after(async () => {
    await prisma?.$disconnect()
})

type CheckoutLifecycleFixture = {
    consumerId: number
    sellerId: number
    listingId: number
    token: string
    sellerToken: string
    baseUrl: string
    server: Server
    addConsumer(quantity: number): Promise<{ id: number; token: string }>
    createCheckout(token?: string): Promise<number>
    cleanup(): Promise<void>
}

async function createCheckoutLifecycleFixture(
    name: string,
    stockQuantity: number,
    cartQuantity: number
): Promise<CheckoutLifecycleFixture> {
    const suffix = randomUUID()
    const consumerIds: number[] = []
    let server: Server | undefined
    const consumer = await prisma.user.create({
        data: {
            name: `${name} consumer`,
            email: `${name}-consumer-${suffix}@example.test`,
            passwordHash: "integration-test-not-a-password",
            role: "CONSUMER",
            cart: { create: {} }
        }
    })
    consumerIds.push(consumer.id)
    const seller = await prisma.user.create({
        data: {
            name: `${name} seller`,
            email: `${name}-seller-${suffix}@example.test`,
            passwordHash: "integration-test-not-a-password",
            role: "SELLER",
            sellerProfile: {
                create: {
                    businessName: `${name} Shop`,
                    state: "Lagos",
                    lga: "Ikeja",
                    location: "Ikeja, Lagos",
                    logoUrl: "https://example.test/logo.png",
                    slug: `${name}-${suffix}`,
                    shippingPolicy: "FREE",
                    shippingCost: null
                }
            }
        }
    })
    const listing = await prisma.listing.create({
        data: {
            title: `${name} listing`,
            description: `Fixture for ${name}`,
            price: 1500,
            stockQuantity,
            category: "Electronics",
            imageUrl: "https://example.test/listing.png",
            userId: seller.id
        }
    })
    const cart = await prisma.cart.findUniqueOrThrow({
        where: { userId: consumer.id },
        select: { id: true }
    })
    await prisma.cartItem.create({
        data: {
            cartId: cart.id,
            listingId: listing.id,
            quantity: cartQuantity
        }
    })

    const jwtSecret = process.env.JWT_SECRET
    assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
    const app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use("/checkout", checkoutRoutes)
    app.use("/cart", cartRoutes)
    app.use("/listings", listingRoutes)
    server = createServer(app)
    await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const baseUrl = `http://127.0.0.1:${address.port}`

    const fixture: CheckoutLifecycleFixture = {
        consumerId: consumer.id,
        sellerId: seller.id,
        listingId: listing.id,
        token: jwt.sign({ id: consumer.id }, jwtSecret),
        sellerToken: jwt.sign({ id: seller.id }, jwtSecret),
        baseUrl,
        server,
        async addConsumer(quantity: number) {
            const otherConsumer = await prisma.user.create({
                data: {
                    name: `${name} other consumer`,
                    email: `${name}-other-consumer-${randomUUID()}@example.test`,
                    passwordHash: "integration-test-not-a-password",
                    role: "CONSUMER",
                    cart: {
                        create: {
                            cartItems: {
                                create: {
                                    listingId: listing.id,
                                    quantity
                                }
                            }
                        }
                    }
                }
            })
            consumerIds.push(otherConsumer.id)
            return {
                id: otherConsumer.id,
                token: jwt.sign({ id: otherConsumer.id }, jwtSecret)
            }
        },
        async createCheckout(token = jwt.sign({ id: consumer.id }, jwtSecret)) {
            const headers = { cookie: `token=${token}` }
            const previewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
            assert.equal(previewResponse.status, 200)
            const preview = await previewResponse.json() as { reviewToken?: unknown }
            assert.equal(typeof preview.reviewToken, "string")
            const checkoutResponse = await fetch(`${baseUrl}/checkout`, {
                method: "POST",
                headers: {
                    ...headers,
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    reviewToken: preview.reviewToken,
                    delivery: {
                        fullName: "Test Consumer",
                        phone: "08000000000",
                        address: "1 Test Street",
                        state: "Lagos",
                        lga: "Ikeja"
                    }
                })
            })
            assert.equal(checkoutResponse.status, 201)
            const body = await checkoutResponse.json() as { checkout?: { id?: unknown } }
            assert.ok(typeof body.checkout?.id === "number")
            return body.checkout.id
        },
        async cleanup() {
            if (server?.listening) {
                await new Promise<void>((resolve, reject) => {
                    server!.close((error) => error ? reject(error) : resolve())
                })
            }
            await prisma.preOrderRequest.updateMany({ where: { sellerId: seller.id }, data: {} })
            await prisma.order.updateMany({ where: { preOrderRequest: { sellerId: seller.id } }, data: { preOrderRequestId: null } })
            await prisma.preOrderRequest.deleteMany({ where: { sellerId: seller.id } })
            await prisma.productReview.deleteMany({ where: { listing: { userId: seller.id } } })
            await prisma.shopReview.deleteMany({ where: { sellerProfile: { userId: seller.id } } })
            const checkoutIds = (await prisma.checkout.findMany({
                where: { userId: { in: consumerIds } },
                select: { id: true }
            })).map(({ id }) => id)
            if (checkoutIds.length > 0) {
                await prisma.disputeMessage.deleteMany({ where: { dispute: { order: { checkoutId: { in: checkoutIds } } } } })
                await prisma.dispute.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                await prisma.liabilityRecovery.deleteMany({
                    where: {
                        OR: [
                            { order: { checkoutId: { in: checkoutIds } } },
                            { liability: { refund: { paymentAttempt: { checkoutId: { in: checkoutIds } } } } }
                        ]
                    }
                })
                await prisma.sellerLiability.deleteMany({ where: { refund: { paymentAttempt: { checkoutId: { in: checkoutIds } } } } })
                await prisma.refund.deleteMany({ where: { paymentAttempt: { checkoutId: { in: checkoutIds } } } })
                await prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.paymentRecoveryCase.deleteMany({ where: { paymentAttempt: { checkoutId: { in: checkoutIds } } } })
                await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
            }
            await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: consumerIds } } } })
            await prisma.cart.deleteMany({ where: { userId: { in: consumerIds } } })
            // Every listing of the seller, including the choices of products that have options.
            await prisma.listing.deleteMany({ where: { userId: seller.id } })
            await prisma.sellerProfile.deleteMany({ where: { userId: seller.id } })
            await prisma.user.deleteMany({ where: { id: { in: [...consumerIds, seller.id] } } })
        }
    }
    return fixture
}

const fixtureDelivery = {
    fullName: "Test Consumer",
    phone: "08000000000",
    address: "1 Test Street",
    state: "Lagos",
    lga: "Ikeja"
}

const changedDelivery = {
    fullName: "Test Consumer",
    phone: "08000000001",
    address: "2 Updated Street",
    state: "Lagos",
    lga: "Ikeja",
    instructions: "Call on arrival"
}

const paymentActivityLockMessage = "An existing checkout has payment activity and cannot be replaced"
const processingLockMessage = "An existing checkout is being processed and cannot be replaced"

type CheckoutResponseBody = {
    code?: unknown
    message?: unknown
    listingId?: unknown
    reviewToken?: unknown
    review?: { reviewToken?: unknown }
    checkout?: {
        id?: unknown
        status?: unknown
        expiresAt?: unknown
        delivery?: unknown
    }
}

async function requestCheckoutPreview(fixture: CheckoutLifecycleFixture, token = fixture.token) {
    const response = await fetch(`${fixture.baseUrl}/checkout/preview`, {
        headers: { cookie: `token=${token}` }
    })
    return { status: response.status, body: await response.json() as CheckoutResponseBody }
}

async function submitCheckout(
    fixture: CheckoutLifecycleFixture,
    body: Record<string, unknown>,
    token = fixture.token
) {
    const response = await fetch(`${fixture.baseUrl}/checkout`, {
        method: "POST",
        headers: {
            cookie: `token=${token}`,
            "content-type": "application/json"
        },
        body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() as CheckoutResponseBody }
}

function pickItemsUnavailable(body: unknown) {
    const { code, listingId } = body as CheckoutResponseBody
    return { code, listingId }
}

function loadConsumerCheckouts(userId: number) {
    return prisma.checkout.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        include: {
            inventoryReservations: { orderBy: { listingId: "asc" } },
            orders: { orderBy: { id: "asc" } }
        }
    })
}

async function installRowTrigger(options: {
    table: "Checkout" | "OrderItem" | "Listing"
    event: "INSERT" | "UPDATE"
    column: "id" | "listingId"
    targetId: number
    matchedStatement: string
}): Promise<() => Promise<void>> {
    const { table, event, column, targetId, matchedStatement } = options
    assert.ok(Number.isSafeInteger(targetId) && targetId > 0)
    const name = `vendly_test_trigger_${randomUUID().replaceAll("-", "")}`
    const remove = async () => {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON public."${table}"`)
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${name}"()`)
    }

    await prisma.$executeRawUnsafe(`
        CREATE FUNCTION public."${name}"()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
        IF NEW."${column}" = TG_ARGV[0]::integer THEN
        ${matchedStatement}
        END IF;
        RETURN NEW;
        END;
        $trigger$
    `)

    try {
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER "${name}"
            BEFORE ${event} ON public."${table}"
            FOR EACH ROW
            EXECUTE FUNCTION public."${name}"('${targetId}')
        `)
    } catch (error) {
        await remove()
        throw error
    }

    return remove
}

async function assertCheckoutUnchanged(
    fixture: CheckoutLifecycleFixture,
    checkoutId: number,
    expectedStatus: "PENDING" | "PAYMENT_PENDING",
    expectedOrderStatus: "PENDING_PAYMENT" | "PAID" = "PENDING_PAYMENT"
) {
    const checkouts = await loadConsumerCheckouts(fixture.consumerId)
    assert.deepEqual(checkouts.map(({ id, status, deliveryAddress }) => ({ id, status, deliveryAddress })), [
        { id: checkoutId, status: expectedStatus, deliveryAddress: fixtureDelivery.address }
    ])
    assert.deepEqual(
        checkouts[0]?.inventoryReservations.map(({ quantity, status }) => ({ quantity, status })),
        [{ quantity: 2, status: "ACTIVE" }]
    )
    assert.deepEqual(checkouts[0]?.orders.map(({ status }) => status), [expectedOrderStatus])
}

async function assertReservedWithinStock(listingId: number, expectedReserved: number, expectedStock: number) {
    const [reservations, listing] = await Promise.all([
        prisma.inventoryReservation.aggregate({
            where: {
                listingId,
                status: "ACTIVE",
                expiresAt: { gt: new Date() }
            },
            _sum: { quantity: true }
        }),
        prisma.listing.findUniqueOrThrow({
            where: { id: listingId },
            select: { stockQuantity: true }
        })
    ])
    assert.equal(reservations._sum.quantity ?? 0, expectedReserved)
    assert.equal(listing.stockQuantity, expectedStock)
    assert.ok((reservations._sum.quantity ?? 0) <= listing.stockQuantity)
}

test("connects to the dedicated PostgreSQL test database with Serializable transactions", async () => {
    const databases = await prisma.$queryRaw<Array<{ database_name: string }>>`
        SELECT current_database() AS database_name
    `
    assert.equal(databases[0]?.database_name, "vendly_test")
    const isolation = await prisma.$transaction(
        (tx) => tx.$queryRaw<Array<{ transaction_isolation: string }>>`
        SHOW transaction_isolation
    `,
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    assert.equal(isolation[0]?.transaction_isolation, "serializable")
})

test("rejects checkout creation with a stale price review token", async () => {
    const suffix = randomUUID()
    let consumerId: number | undefined
    let sellerId: number | undefined
    let listingId: number | undefined
    let server: Server | undefined
    try {
        const consumer = await prisma.user.create({
            data: {
                name: "Checkout review test consumer",
                email: `checkout-review-consumer-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "CONSUMER",
                cart: { create: {} }
            }
        })
        consumerId = consumer.id
        const seller = await prisma.user.create({
            data: {
                name: "Checkout review test seller",
                email: `checkout-review-seller-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "SELLER",
                sellerProfile: {
                    create: {
                        businessName: "Checkout Review Test Shop",
                        state: "Lagos",
                        lga: "Ikeja",
                        location: "Ikeja, Lagos",
                        logoUrl: "https://example.test/logo.png",
                        slug: `checkout-review-${suffix}`,
                        shippingPolicy: "FREE",
                        shippingCost: null
                    }
                }
            }
        })
        sellerId = seller.id
        const listing = await prisma.listing.create({
            data: {
                title: "Checkout review test listing",
                description: "Fixture for stale checkout review coverage",
                price: 1500,
                stockQuantity: 5,
                category: "Electronics",
                imageUrl: "https://example.test/listing.png",
                userId: seller.id
            }
        })
        listingId = listing.id
        const cart = await prisma.cart.findUniqueOrThrow({
            where: { userId: consumer.id },
            select: { id: true }
        })
        await prisma.cartItem.create({
            data: {
                cartId: cart.id,
                listingId: listing.id,
                quantity: 2
            }
        })
        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
        const token = jwt.sign({ id: consumer.id }, jwtSecret)
        const app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use("/checkout", checkoutRoutes)
        server = createServer(app)
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        const baseUrl = `http://127.0.0.1:${address.port}`
        const headers = { cookie: `token=${token}` }
        const previewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(previewResponse.status, 200)
        const preview = await previewResponse.json() as { reviewToken?: unknown }
        assert.equal(typeof preview.reviewToken, "string")
        await prisma.listing.update({
            where: { id: listing.id },
            data: { price: 1750 }
        })
        const checkoutResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                reviewToken: preview.reviewToken,
                delivery: {
                    fullName: "Test Consumer",
                    phone: "08000000000",
                    address: "1 Test Street",
                    state: "Lagos",
                    lga: "Ikeja"
                }
            })
        })
        assert.equal(checkoutResponse.status, 409)
        const checkoutBody = await checkoutResponse.json() as { code?: unknown }
        assert.equal(checkoutBody.code, "CHECKOUT_REVIEW_REQUIRED")
        const [checkouts, checkoutItems, orders, orderItems, activeReservations] = await Promise.all([
                prisma.checkout.count({ where: { userId: consumer.id } }),
                prisma.checkoutItem.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.order.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.orderItem.count({ where: { order: { checkout: { userId: consumer.id } } } }),
                prisma.inventoryReservation.count({
            where: {
                checkout: { userId: consumer.id },
                status: "ACTIVE"
            }
        })
        ])
        assert.deepEqual(
            { checkouts, checkoutItems, orders, orderItems, activeReservations },
            { checkouts: 0, checkoutItems: 0, orders: 0, orderItems: 0, activeReservations: 0 }
        )
    } finally {
        if (server?.listening) {
            await new Promise<void>((resolve, reject) => {
                server!.close((error) => error ? reject(error) : resolve())
            })
        }
        if (consumerId !== undefined) {
            const checkoutIds = (await prisma.checkout.findMany({
                where: { userId: consumerId },
                select: { id: true }
            })).map(({ id }) => id)
            if (checkoutIds.length > 0) {
                await prisma.orderItem.deleteMany({
                    where: { order: { checkoutId: { in: checkoutIds } } }
                })
                await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
            }
            await prisma.cartItem.deleteMany({ where: { cart: { userId: consumerId } } })
            await prisma.cart.deleteMany({ where: { userId: consumerId } })
        }
        if (listingId !== undefined) {
            await prisma.listing.delete({ where: { id: listingId } })
        }
        if (sellerId !== undefined) {
            await prisma.sellerProfile.deleteMany({ where: { userId: sellerId } })
            await prisma.user.delete({ where: { id: sellerId } })
        }
        if (consumerId !== undefined) {
            await prisma.user.delete({ where: { id: consumerId } })
        }
    }
})

test("rolls back all checkout records when an order item insert fails", async () => {
    const suffix = randomUUID()
    const sqlSuffix = suffix.replaceAll("-", "")
    assert.match(sqlSuffix, /^[a-f0-9]{32}$/)
    const triggerName = `vendly_test_order_item_fail_${sqlSuffix}`
    const functionName = `vendly_test_order_item_fail_${sqlSuffix}`
    let consumerId: number | undefined
    let sellerId: number | undefined
    let listingId: number | undefined
    let server: Server | undefined
    let functionInstallAttempted = false
    let triggerInstallAttempted = false
    try {
        const consumer = await prisma.user.create({
            data: {
                name: "Checkout rollback test consumer",
                email: `checkout-rollback-consumer-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "CONSUMER",
                cart: { create: {} }
            }
        })
        consumerId = consumer.id
        const seller = await prisma.user.create({
            data: {
                name: "Checkout rollback test seller",
                email: `checkout-rollback-seller-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "SELLER",
                sellerProfile: {
                    create: {
                        businessName: "Checkout Rollback Test Shop",
                        state: "Lagos",
                        lga: "Ikeja",
                        location: "Ikeja, Lagos",
                        logoUrl: "https://example.test/logo.png",
                        slug: `checkout-rollback-${suffix}`,
                        shippingPolicy: "FREE",
                        shippingCost: null
                    }
                }
            }
        })
        sellerId = seller.id
        const listing = await prisma.listing.create({
            data: {
                title: "Checkout rollback test listing",
                description: "Fixture for checkout transaction rollback coverage",
                price: 1500,
                stockQuantity: 5,
                category: "Electronics",
                imageUrl: "https://example.test/listing.png",
                userId: seller.id
            }
        })
        listingId = listing.id
        const cart = await prisma.cart.findUniqueOrThrow({
            where: { userId: consumer.id },
            select: { id: true }
        })
        await prisma.cartItem.create({
            data: {
                cartId: cart.id,
                listingId: listing.id,
                quantity: 2
            }
        })
        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
        const token = jwt.sign({ id: consumer.id }, jwtSecret)
        const app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use("/checkout", checkoutRoutes)
        server = createServer(app)
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        const baseUrl = `http://127.0.0.1:${address.port}`
        const headers = { cookie: `token=${token}` }
        const previewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(previewResponse.status, 200)
        const preview = await previewResponse.json() as { reviewToken?: unknown }
        assert.equal(typeof preview.reviewToken, "string")
        const fixtureListingId = listing.id
        assert.ok(Number.isSafeInteger(fixtureListingId) && fixtureListingId > 0)
        functionInstallAttempted = true
        await prisma.$executeRawUnsafe(`
            CREATE FUNCTION public."${functionName}"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $trigger$
            BEGIN
            IF NEW."listingId" = TG_ARGV[0]::integer THEN
            RAISE EXCEPTION 'integration test forced OrderItem insert failure';
            END IF;
            RETURN NEW;
            END;
            $trigger$
        `)
        triggerInstallAttempted = true
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            BEFORE INSERT ON public."OrderItem"
            FOR EACH ROW
            EXECUTE FUNCTION public."${functionName}"('${fixtureListingId}')
        `)
        const checkoutResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                reviewToken: preview.reviewToken,
                delivery: {
                    fullName: "Test Consumer",
                    phone: "08000000000",
                    address: "1 Test Street",
                    state: "Lagos",
                    lga: "Ikeja"
                }
            })
        })
        assert.equal(checkoutResponse.status, 500)
        assert.deepEqual(await checkoutResponse.json(), {
            message: "Sorry, there is an issue on our end"
        })
        const [checkouts, checkoutItems, reservations, orders, orderItems] = await Promise.all([
                prisma.checkout.count({ where: { userId: consumer.id } }),
                prisma.checkoutItem.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.inventoryReservation.count({
            where: {
                checkout: { userId: consumer.id },
                listingId: listing.id
            }
        }),
                prisma.order.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.orderItem.count({
            where: {
                listingId: listing.id,
                order: { checkout: { userId: consumer.id } }
            }
        })
        ])
        assert.deepEqual(
            { checkouts, checkoutItems, reservations, orders, orderItems },
            { checkouts: 0, checkoutItems: 0, reservations: 0, orders: 0, orderItems: 0 }
        )
    } finally {
        const cleanupErrors: Error[] = []
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
            try {
                await operation()
            } catch (error) {
                cleanupErrors.push(new Error(`${label} failed`, { cause: error }))
            }
        }
        if (server?.listening) {
            await cleanup("HTTP server shutdown", () => new Promise<void>((resolve, reject) => {
                server!.close((error) => error ? reject(error) : resolve())
            }))
        }
        if (triggerInstallAttempted && listingId !== undefined) {
            await cleanup("Test trigger removal", () => prisma.$executeRawUnsafe(
                    `DROP TRIGGER IF EXISTS "${triggerName}" ON public."OrderItem"`
            ))
        }
        if (functionInstallAttempted) {
            await cleanup("Test trigger function removal", () => prisma.$executeRawUnsafe(
                    `DROP FUNCTION IF EXISTS public."${functionName}"()`
            ))
        }
        if (consumerId !== undefined) {
            await cleanup("Checkout fixture cleanup", async () => {
                const checkoutIds = (await prisma.checkout.findMany({
                    where: { userId: consumerId },
                    select: { id: true }
                })).map(({ id }) => id)
                if (checkoutIds.length > 0) {
                    await prisma.orderItem.deleteMany({
                        where: { order: { checkoutId: { in: checkoutIds } } }
                    })
                    await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
                }
                await prisma.cartItem.deleteMany({ where: { cart: { userId: consumerId } } })
                await prisma.cart.deleteMany({ where: { userId: consumerId } })
            })
        }
        if (listingId !== undefined) {
            await cleanup("Fixture listing cleanup", () => prisma.listing.delete({ where: { id: listingId } }))
        }
        if (sellerId !== undefined) {
            await cleanup("Fixture seller cleanup", async () => {
                await prisma.sellerProfile.deleteMany({ where: { userId: sellerId } })
                await prisma.user.delete({ where: { id: sellerId } })
            })
        }
        if (consumerId !== undefined) {
            await cleanup("Fixture consumer cleanup", () => prisma.user.delete({ where: { id: consumerId } }))
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Checkout rollback test cleanup failed.")
        }
    }
})

test("prevents concurrent consumers from over-reserving listing stock", async () => {
    const suffix = randomUUID()
    const consumerIds: number[] = []
    let sellerId: number | undefined
    let listingId: number | undefined
    let server: Server | undefined
    let signalBarrierAcquired!: () => void
    let releaseBarrier!: () => void
    let barrierLockAcquired = false
    let requestPromises: Promise<Response>[] = []
    const barrierAcquired = new Promise<void>((resolve) => {
        signalBarrierAcquired = resolve
    })
    const barrierRelease = new Promise<void>((resolve) => {
        releaseBarrier = resolve
    })
    let barrierTransaction: Promise<void> | undefined
    try {
        const seller = await prisma.user.create({
            data: {
                name: "Concurrent reservation test seller",
                email: `checkout-concurrent-seller-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "SELLER",
                sellerProfile: {
                    create: {
                        businessName: "Concurrent Reservation Test Shop",
                        state: "Lagos",
                        lga: "Ikeja",
                        location: "Ikeja, Lagos",
                        logoUrl: "https://example.test/logo.png",
                        slug: `checkout-concurrent-${suffix}`,
                        shippingPolicy: "FREE",
                        shippingCost: null
                    }
                }
            }
        })

        sellerId = seller.id
        const listing = await prisma.listing.create({
            data: {
                title: "Concurrent reservation test listing",
                description: "Fixture for concurrent reservation coverage",
                price: 1500,
                stockQuantity: 1,
                category: "Electronics",
                imageUrl: "https://example.test/listing.png",
                userId: seller.id
            }
        })
        listingId = listing.id
        for (const consumerIndex of [1, 2]) {
            const consumer = await prisma.user.create({
                data: {
                    name: `Concurrent reservation test consumer ${consumerIndex}`,
                    email: `checkout-concurrent-consumer-${consumerIndex}-${suffix}@example.test`,
                    passwordHash: "integration-test-not-a-password",
                    role: "CONSUMER",
                    cart: {
                        create: {
                            cartItems: {
                                create: {
                                    listingId: listing.id,
                                    quantity: 1
                                }
                            }
                        }
                    }
                }
            })
            consumerIds.push(consumer.id)
        }
        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
        const tokens = consumerIds.map((id) => jwt.sign({ id }, jwtSecret))
        const app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use("/checkout", checkoutRoutes)
        server = createServer(app)
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        const baseUrl = `http://127.0.0.1:${address.port}`
        const reviews = await Promise.all(tokens.map(async (token) => {
            const response = await fetch(`${baseUrl}/checkout/preview`, {
                headers: { cookie: `token=${token}` }
            })
            assert.equal(response.status, 200)
            const body = await response.json() as {
                reviewToken?: unknown
                sellers?: Array<{ items?: Array<{ listingId?: number; availableQuantity?: number }> }>
            }
            assert.equal(typeof body.reviewToken, "string")
            assert.deepEqual(
                body.sellers?.flatMap((seller) => seller.items ?? []).map(({ listingId, availableQuantity }) => ({
                listingId,
                availableQuantity
            })),
                [{ listingId: listing.id, availableQuantity: 1 }]
            )
            return body.reviewToken as string
        }))
        barrierTransaction = prisma.$transaction(async (tx) => {
            await tx.$executeRaw`LOCK TABLE "InventoryReservation" IN SHARE MODE`
            barrierLockAcquired = true
            signalBarrierAcquired()
            await barrierRelease
        }, {
            maxWait: 10_000,
            timeout: 60_000
        })
        await Promise.race([
                barrierAcquired,
                barrierTransaction.then(() => {
            throw new Error("Coordinator lock transaction ended before the barrier was released.")
        })
        ])
        const delivery = {
            fullName: "Test Consumer",
            phone: "08000000000",
            address: "1 Test Street",
            state: "Lagos",
            lga: "Ikeja"
        }
        requestPromises = tokens.map((token, index) => fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                cookie: `token=${token}`,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                reviewToken: reviews[index],
                delivery
            })
        }))
        const deadline = Date.now() + 15_000
        let observedWaiters: Array<{ pid: number; mode: string; waitEvent: string | null }> = []
        while (Date.now() < deadline) {
            observedWaiters = await prisma.$queryRaw<Array<{
                pid: number
                mode: string
                waitEvent: string | null
            }>>`
                SELECT DISTINCT
                activity.pid::integer AS pid,
                locks.mode,
                activity.wait_event AS "waitEvent"
                FROM pg_locks AS locks
                JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
                WHERE activity.datname = current_database()
                AND activity.pid <> pg_backend_pid()
                AND activity.wait_event_type = 'Lock'
                AND activity.wait_event = 'relation'
                AND activity.query ILIKE '%INSERT%'
                AND activity.query ILIKE '%InventoryReservation%'
                AND locks.locktype = 'relation'
                AND locks.relation = '"public"."InventoryReservation"'::regclass
                AND locks.mode = 'RowExclusiveLock'
                AND NOT locks.granted
            `
            if (new Set(observedWaiters.map(({ pid }) => pid)).size === 2) {
                break
            }
            await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const waitingPids = new Set(observedWaiters.map(({ pid }) => pid))
        assert.equal(
            waitingPids.size,
            2,
            `Timed out waiting for both checkout sessions on InventoryReservation RowExclusiveLock; observed ${JSON.stringify(observedWaiters)}`
        )
        assert.ok(barrierLockAcquired, "Coordinator table-lock barrier must remain held until both sessions are waiting")
        releaseBarrier()
        await barrierTransaction
        barrierTransaction = undefined
        const responses = await Promise.all(requestPromises)
        const responseBodies = await Promise.all(responses.map(async (response) => ({
            status: response.status,
            body: await response.json() as { code?: unknown }
        })))
        const successes = responseBodies.filter(({ status }) => status === 201)
        const conflicts = responseBodies.filter(({ status }) => status === 409)
        assert.equal(successes.length, 1, `Expected one successful checkout, received ${JSON.stringify(responseBodies)}`)
        assert.equal(conflicts.length, 1, `Expected one checkout conflict, received ${JSON.stringify(responseBodies)}`)
        assert.equal(conflicts[0]?.body.code, "CHECKOUT_CONFLICT")
        assert.equal(successes[0]?.body.code, "CHECKOUT_CREATED")
        const perConsumerRecords = await Promise.all(consumerIds.map(async (userId) => {
            const [checkouts, checkoutItems, reservations, orders, orderItems] = await Promise.all([
                    prisma.checkout.count({ where: { userId } }),
                    prisma.checkoutItem.count({ where: { checkout: { userId } } }),
                    prisma.inventoryReservation.count({ where: { checkout: { userId }, listingId: listing.id } }),
                    prisma.order.count({ where: { checkout: { userId } } }),
                    prisma.orderItem.count({ where: { listingId: listing.id, order: { checkout: { userId } } } })
            ])
            return { userId, checkouts, checkoutItems, reservations, orders, orderItems }
        }))
        const successfulConsumerId = consumerIds[responseBodies.findIndex(({ status }) => status === 201)]
        assert.ok(successfulConsumerId !== undefined)
        for (const records of perConsumerRecords) {
            if (records.userId === successfulConsumerId) {
                assert.deepEqual(
                    { ...records, userId: undefined },
                    { userId: undefined, checkouts: 1, checkoutItems: 1, reservations: 1, orders: 1, orderItems: 1 }
                )
            } else {
                assert.deepEqual(
                    { ...records, userId: undefined },
                    { userId: undefined, checkouts: 0, checkoutItems: 0, reservations: 0, orders: 0, orderItems: 0 }
                )
            }
        }
        const [activeReservationQuantity, finalListing] = await Promise.all([
                prisma.inventoryReservation.aggregate({
            where: {
                listingId: listing.id,
                status: "ACTIVE",
                expiresAt: { gt: new Date() },
                checkout: { userId: { in: consumerIds } }
            },
            _sum: { quantity: true }
        }),
                prisma.listing.findUniqueOrThrow({
            where: { id: listing.id },
            select: { stockQuantity: true }
        })
        ])
        assert.ok((activeReservationQuantity._sum.quantity ?? 0) <= 1)
        assert.equal(finalListing.stockQuantity, 1)
    } finally {
        const cleanupErrors: Error[] = []
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
            try {
                await operation()
            } catch (error) {
                cleanupErrors.push(new Error(`${label} failed`, { cause: error }))
            }
        }
        releaseBarrier()
        if (barrierTransaction) {
            await cleanup("Coordinator barrier release", () => barrierTransaction!)
        }
        if (requestPromises.length > 0) {
            await Promise.allSettled(requestPromises)
        }
        if (server?.listening) {
            await cleanup("HTTP server shutdown", () => new Promise<void>((resolve, reject) => {
                server!.close((error) => error ? reject(error) : resolve())
            }))
        }
        if (consumerIds.length > 0) {
            await cleanup("Checkout fixture cleanup", async () => {
                const checkoutIds = (await prisma.checkout.findMany({
                    where: { userId: { in: consumerIds } },
                    select: { id: true }
                })).map(({ id }) => id)
                if (checkoutIds.length > 0) {
                    await prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                    await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
                }
                await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: consumerIds } } } })
                await prisma.cart.deleteMany({ where: { userId: { in: consumerIds } } })
            })
        }
        if (listingId !== undefined) {
            await cleanup("Fixture listing cleanup", () => prisma.listing.delete({ where: { id: listingId } }))
        }
        if (sellerId !== undefined) {
            await cleanup("Fixture seller cleanup", async () => {
                await prisma.sellerProfile.deleteMany({ where: { userId: sellerId } })
                await prisma.user.delete({ where: { id: sellerId } })
            })
        }
        for (const userId of consumerIds) {
            await cleanup("Fixture consumer cleanup", () => prisma.user.delete({ where: { id: userId } }))
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Concurrent reservation test cleanup failed.")
        }
    }
})

test("reuses an unchanged eligible checkout", async () => {
    const suffix = randomUUID()
    let consumerId: number | undefined
    let sellerId: number | undefined
    let listingId: number | undefined
    let server: Server | undefined

    try {
        const consumer = await prisma.user.create({
            data: {
                name: "Checkout reuse test consumer",
                email: `checkout-reuse-consumer-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "CONSUMER",
                cart: { create: {} }
            }
        })

        consumerId = consumer.id
        const seller = await prisma.user.create({
            data: {
                name: "Checkout reuse test seller",
                email: `checkout-reuse-seller-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "SELLER",
                sellerProfile: {
                    create: {
                        businessName: "Checkout Reuse Test Shop",
                        state: "Lagos",
                        lga: "Ikeja",
                        location: "Ikeja, Lagos",
                        logoUrl: "https://example.test/logo.png",
                        slug: `checkout-reuse-${suffix}`,
                        shippingPolicy: "FREE",
                        shippingCost: null
                    }
                }
            }
        })
        sellerId = seller.id
        const listing = await prisma.listing.create({
            data: {
                title: "Checkout reuse test listing",
                description: "Fixture for unchanged checkout reuse coverage",
                price: 1500,
                stockQuantity: 5,
                category: "Electronics",
                imageUrl: "https://example.test/listing.png",
                userId: seller.id
            }
        })
        listingId = listing.id
        const cart = await prisma.cart.findUniqueOrThrow({
            where: { userId: consumer.id },
            select: { id: true }
        })
        await prisma.cartItem.create({
            data: {
                cartId: cart.id,
                listingId: listing.id,
                quantity: 2
            }
        })

        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
        const token = jwt.sign({ id: consumer.id }, jwtSecret)
        const app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use("/checkout", checkoutRoutes)
        server = createServer(app)
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        const baseUrl = `http://127.0.0.1:${address.port}`
        const headers = { cookie: `token=${token}` }
        const delivery = {
            fullName: "Test Consumer",
            phone: "08000000000",
            address: "1 Test Street",
            state: "Lagos",
            lga: "Ikeja"
        }

        const firstPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(firstPreviewResponse.status, 200)
        const firstPreview = await firstPreviewResponse.json() as { reviewToken?: unknown }
        assert.equal(typeof firstPreview.reviewToken, "string")
        const firstCheckoutResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: firstPreview.reviewToken, delivery })
        })
        assert.equal(firstCheckoutResponse.status, 201)
        const firstCheckoutBody = await firstCheckoutResponse.json() as {
            code?: unknown
            checkout?: { id?: unknown }
        }
        assert.equal(firstCheckoutBody.code, "CHECKOUT_CREATED")
        const checkoutId = firstCheckoutBody.checkout?.id
        assert.ok(typeof checkoutId === "number", "Created checkout response must include its ID")

        const loadCheckoutState = async () => {
            const checkouts = await prisma.checkout.findMany({
                where: { userId: consumer.id },
                include: {
                    checkoutItems: true,
                    inventoryReservations: true,
                    orders: { include: { orderItems: true } }
                },
                orderBy: { id: "asc" }
            })
            return checkouts.map((checkout) => ({
                id: checkout.id,
                status: checkout.status,
                expiresAt: checkout.expiresAt.toISOString(),
                total: checkout.total.toString(),
                checkoutItems: checkout.checkoutItems.map((item) => ({
                    listingId: item.listingId,
                    title: item.title,
                    unitPrice: item.unitPrice.toString(),
                    quantity: item.quantity
                })).sort((left, right) => left.listingId - right.listingId),
                inventoryReservations: checkout.inventoryReservations.map((reservation) => ({
                    listingId: reservation.listingId,
                    quantity: reservation.quantity,
                    status: reservation.status,
                    expiresAt: reservation.expiresAt.toISOString()
                })).sort((left, right) => left.listingId - right.listingId),
                orders: checkout.orders.map((order) => ({
                    id: order.id,
                    status: order.status,
                    subtotal: order.subtotal.toString(),
                    shippingCost: order.shippingCost.toString(),
                    total: order.total.toString(),
                    orderItems: order.orderItems.map((item) => ({
                        listingId: item.listingId,
                        title: item.title,
                        unitPrice: item.unitPrice.toString(),
                        quantity: item.quantity
                    })).sort((left, right) => left.listingId - right.listingId)
                })).sort((left, right) => left.id - right.id)
            }))
        }
        const stateBeforeReuse = await loadCheckoutState()
        assert.equal(stateBeforeReuse.length, 1)
        assert.equal(stateBeforeReuse[0]?.id, checkoutId)
        assert.equal(stateBeforeReuse[0]?.status, "PENDING")
        assert.deepEqual(stateBeforeReuse[0]?.checkoutItems.map(({ listingId: itemListingId, quantity }) => ({
            listingId: itemListingId,
            quantity
        })), [{ listingId: listing.id, quantity: 2 }])
        assert.deepEqual(stateBeforeReuse[0]?.inventoryReservations.map(({ listingId: reservationListingId, quantity, status }) => ({
            listingId: reservationListingId,
            quantity,
            status
        })), [{ listingId: listing.id, quantity: 2, status: "ACTIVE" }])
        assert.deepEqual(stateBeforeReuse[0]?.orders.map(({ status, orderItems }) => ({
            status,
            orderItems: orderItems.map(({ listingId: itemListingId, quantity }) => ({
                listingId: itemListingId,
                quantity
            }))
        })), [{
            status: "PENDING_PAYMENT",
            orderItems: [{ listingId: listing.id, quantity: 2 }]
        }])

        const secondPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(secondPreviewResponse.status, 200)
        const secondPreview = await secondPreviewResponse.json() as {
            reviewToken?: unknown
            sellers?: Array<{ items?: Array<{ listingId?: number; availableQuantity?: number }> }>
        }
        assert.equal(typeof secondPreview.reviewToken, "string")
        assert.deepEqual(
            secondPreview.sellers?.flatMap((seller) => seller.items ?? []).map(({ listingId: itemListingId, availableQuantity }) => ({
                listingId: itemListingId,
                availableQuantity
            })),
            [{ listingId: listing.id, availableQuantity: listing.stockQuantity }]
        )

        const secondCheckoutResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: secondPreview.reviewToken, delivery })
        })
        assert.equal(secondCheckoutResponse.status, 200)
        const secondCheckoutBody = await secondCheckoutResponse.json() as {
            code?: unknown
            checkout?: { id?: unknown }
        }
        assert.equal(secondCheckoutBody.code, "CHECKOUT_REUSED")
        assert.equal(secondCheckoutBody.checkout?.id, checkoutId)

        const [checkoutCount, checkoutItemCount, reservationCount, orderCount, orderItemCount] = await Promise.all([
            prisma.checkout.count({ where: { userId: consumer.id } }),
            prisma.checkoutItem.count({ where: { checkout: { userId: consumer.id }, listingId: listing.id } }),
            prisma.inventoryReservation.count({ where: { checkout: { userId: consumer.id }, listingId: listing.id } }),
            prisma.order.count({ where: { checkout: { userId: consumer.id } } }),
            prisma.orderItem.count({ where: { listingId: listing.id, order: { checkout: { userId: consumer.id } } } })
        ])
        assert.deepEqual(
            { checkoutCount, checkoutItemCount, reservationCount, orderCount, orderItemCount },
            { checkoutCount: 1, checkoutItemCount: 1, reservationCount: 1, orderCount: 1, orderItemCount: 1 }
        )
        assert.deepEqual(await loadCheckoutState(), stateBeforeReuse)
    } finally {
        const cleanupErrors: Error[] = []
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
            try {
                await operation()
            } catch (error) {
                cleanupErrors.push(new Error(`${label} failed`, { cause: error }))
            }
        }
        if (server?.listening) {
            await cleanup("HTTP server shutdown", () => new Promise<void>((resolve, reject) => {
                server!.close((error) => error ? reject(error) : resolve())
            }))
        }
        if (consumerId !== undefined) {
            await cleanup("Checkout fixture cleanup", async () => {
                const checkoutIds = (await prisma.checkout.findMany({
                    where: { userId: consumerId },
                    select: { id: true }
                })).map(({ id }) => id)
                if (checkoutIds.length > 0) {
                    await prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                    await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
                }
                await prisma.cartItem.deleteMany({ where: { cart: { userId: consumerId } } })
                await prisma.cart.deleteMany({ where: { userId: consumerId } })
            })
        }
        if (listingId !== undefined) {
            await cleanup("Fixture listing cleanup", () => prisma.listing.delete({ where: { id: listingId } }))
        }
        if (sellerId !== undefined) {
            await cleanup("Fixture seller cleanup", async () => {
                await prisma.sellerProfile.deleteMany({ where: { userId: sellerId } })
                await prisma.user.delete({ where: { id: sellerId } })
            })
        }
        if (consumerId !== undefined) {
            await cleanup("Fixture consumer cleanup", () => prisma.user.delete({ where: { id: consumerId } }))
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Checkout reuse test cleanup failed.")
        }
    }
})

test("replaces an eligible checkout after the cart changes", async () => {
    const suffix = randomUUID()
    let consumerId: number | undefined
    let sellerId: number | undefined
    let listingId: number | undefined
    let server: Server | undefined

    try {
        const consumer = await prisma.user.create({
            data: {
                name: "Checkout replacement test consumer",
                email: `checkout-replacement-consumer-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "CONSUMER",
                cart: { create: {} }
            }
        })

        consumerId = consumer.id
        const seller = await prisma.user.create({
            data: {
                name: "Checkout replacement test seller",
                email: `checkout-replacement-seller-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "SELLER",
                sellerProfile: {
                    create: {
                        businessName: "Checkout Replacement Test Shop",
                        state: "Lagos",
                        lga: "Ikeja",
                        location: "Ikeja, Lagos",
                        logoUrl: "https://example.test/logo.png",
                        slug: `checkout-replacement-${suffix}`,
                        shippingPolicy: "FREE",
                        shippingCost: null
                    }
                }
            }
        })
        sellerId = seller.id
        const listing = await prisma.listing.create({
            data: {
                title: "Checkout replacement test listing",
                description: "Fixture for cart-change checkout replacement coverage",
                price: 1500,
                stockQuantity: 5,
                category: "Electronics",
                imageUrl: "https://example.test/listing.png",
                userId: seller.id
            }
        })
        listingId = listing.id
        const cart = await prisma.cart.findUniqueOrThrow({
            where: { userId: consumer.id },
            select: { id: true }
        })
        const cartItem = await prisma.cartItem.create({
            data: {
                cartId: cart.id,
                listingId: listing.id,
                quantity: 1
            }
        })

        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
        const token = jwt.sign({ id: consumer.id }, jwtSecret)
        const app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use("/checkout", checkoutRoutes)
        server = createServer(app)
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        const baseUrl = `http://127.0.0.1:${address.port}`
        const headers = { cookie: `token=${token}` }
        const delivery = {
            fullName: "Test Consumer",
            phone: "08000000000",
            address: "1 Test Street",
            state: "Lagos",
            lga: "Ikeja"
        }

        const initialPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(initialPreviewResponse.status, 200)
        const initialPreview = await initialPreviewResponse.json() as { reviewToken?: unknown }
        assert.equal(typeof initialPreview.reviewToken, "string")
        const initialCheckoutResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: initialPreview.reviewToken, delivery })
        })
        assert.equal(initialCheckoutResponse.status, 201)
        const initialCheckoutBody = await initialCheckoutResponse.json() as {
            code?: unknown
            checkout?: { id?: unknown }
        }
        assert.equal(initialCheckoutBody.code, "CHECKOUT_CREATED")
        const oldCheckoutId = initialCheckoutBody.checkout?.id
        assert.ok(typeof oldCheckoutId === "number", "Initial checkout response must include its ID")

        await prisma.cartItem.update({
            where: { id: cartItem.id },
            data: { quantity: 2 }
        })
        const replacementPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(replacementPreviewResponse.status, 200)
        const replacementPreview = await replacementPreviewResponse.json() as {
            reviewToken?: unknown
            sellers?: Array<{ items?: Array<{ listingId?: number; quantity?: number; availableQuantity?: number }> }>
        }
        assert.equal(typeof replacementPreview.reviewToken, "string")
        assert.deepEqual(
            replacementPreview.sellers?.flatMap((seller) => seller.items ?? []).map((item) => ({
                listingId: item.listingId,
                quantity: item.quantity,
                availableQuantity: item.availableQuantity
            })),
            [{ listingId: listing.id, quantity: 2, availableQuantity: listing.stockQuantity }]
        )

        const replacementResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: replacementPreview.reviewToken, delivery })
        })
        assert.equal(replacementResponse.status, 201)
        const replacementBody = await replacementResponse.json() as {
            code?: unknown
            checkout?: { id?: unknown; status?: unknown }
        }
        assert.equal(replacementBody.code, "CHECKOUT_REPLACED")
        assert.equal(replacementBody.checkout?.status, "PENDING")
        const newCheckoutId = replacementBody.checkout?.id
        assert.ok(typeof newCheckoutId === "number", "Replacement checkout response must include its ID")
        assert.notEqual(newCheckoutId, oldCheckoutId)

        const [oldCheckout, newCheckout, checkoutCount, checkoutItemCount, reservationCount, orderCount, orderItemCount] =
            await Promise.all([
                prisma.checkout.findUniqueOrThrow({
                    where: { id: oldCheckoutId },
                    include: {
                        checkoutItems: true,
                        inventoryReservations: true,
                        orders: { include: { orderItems: true } }
                    }
                }),
                prisma.checkout.findUniqueOrThrow({
                    where: { id: newCheckoutId },
                    include: {
                        checkoutItems: true,
                        inventoryReservations: true,
                        orders: { include: { orderItems: true } }
                    }
                }),
                prisma.checkout.count({ where: { userId: consumer.id } }),
                prisma.checkoutItem.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.inventoryReservation.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.order.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.orderItem.count({ where: { order: { checkout: { userId: consumer.id } } } })
            ])

        assert.equal(checkoutCount, 2)
        assert.equal(checkoutItemCount, 2)
        assert.equal(reservationCount, 2)
        assert.equal(orderCount, 2)
        assert.equal(orderItemCount, 2)

        assert.equal(oldCheckout.userId, consumer.id)
        assert.equal(oldCheckout.status, "EXPIRED")
        assert.deepEqual(oldCheckout.checkoutItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 1
        }])
        assert.deepEqual(oldCheckout.inventoryReservations.map(({ listingId: reservationListingId, quantity, status }) => ({
            listingId: reservationListingId,
            quantity,
            status
        })), [{ listingId: listing.id, quantity: 1, status: "RELEASED" }])
        assert.equal(oldCheckout.orders.length, 1)
        assert.equal(oldCheckout.orders[0]?.status, "CANCELLED")
        assert.deepEqual(oldCheckout.orders[0]?.orderItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 1
        }])

        assert.equal(newCheckout.userId, consumer.id)
        assert.equal(newCheckout.status, "PENDING")
        assert.deepEqual(newCheckout.checkoutItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 2
        }])
        assert.deepEqual(newCheckout.inventoryReservations.map(({ listingId: reservationListingId, quantity, status, expiresAt }) => ({
            listingId: reservationListingId,
            quantity,
            status,
            expiresAt: expiresAt.toISOString()
        })), [{
            listingId: listing.id,
            quantity: 2,
            status: "ACTIVE",
            expiresAt: newCheckout.expiresAt.toISOString()
        }])
        assert.equal(newCheckout.orders.length, 1)
        assert.equal(newCheckout.orders[0]?.status, "PENDING_PAYMENT")
        assert.deepEqual(newCheckout.orders[0]?.orderItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 2
        }])

        const [activeReservationQuantity, finalListing] = await Promise.all([
            prisma.inventoryReservation.aggregate({
                where: {
                    listingId: listing.id,
                    status: "ACTIVE",
                    expiresAt: { gt: new Date() },
                    checkout: { userId: consumer.id }
                },
                _sum: { quantity: true }
            }),
            prisma.listing.findUniqueOrThrow({
                where: { id: listing.id },
                select: { stockQuantity: true }
            })
        ])
        assert.equal(activeReservationQuantity._sum.quantity, 2)
        assert.equal(finalListing.stockQuantity, 5)
        assert.ok((activeReservationQuantity._sum.quantity ?? 0) <= finalListing.stockQuantity)
    } finally {
        const cleanupErrors: Error[] = []
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
            try {
                await operation()
            } catch (error) {
                cleanupErrors.push(new Error(`${label} failed`, { cause: error }))
            }
        }
        if (server?.listening) {
            await cleanup("HTTP server shutdown", () => new Promise<void>((resolve, reject) => {
                server!.close((error) => error ? reject(error) : resolve())
            }))
        }
        if (consumerId !== undefined) {
            await cleanup("Checkout fixture cleanup", async () => {
                const checkoutIds = (await prisma.checkout.findMany({
                    where: { userId: consumerId },
                    select: { id: true }
                })).map(({ id }) => id)
                if (checkoutIds.length > 0) {
                    await prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                    await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
                }
                await prisma.cartItem.deleteMany({ where: { cart: { userId: consumerId } } })
                await prisma.cart.deleteMany({ where: { userId: consumerId } })
            })
        }
        if (listingId !== undefined) {
            await cleanup("Fixture listing cleanup", () => prisma.listing.delete({ where: { id: listingId } }))
        }
        if (sellerId !== undefined) {
            await cleanup("Fixture seller cleanup", async () => {
                await prisma.sellerProfile.deleteMany({ where: { userId: sellerId } })
                await prisma.user.delete({ where: { id: sellerId } })
            })
        }
        if (consumerId !== undefined) {
            await cleanup("Fixture consumer cleanup", () => prisma.user.delete({ where: { id: consumerId } }))
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Checkout replacement test cleanup failed.")
        }
    }
})

test("rolls back checkout replacement when an order item insert fails", async () => {
    const suffix = randomUUID()
    const sqlSuffix = suffix.replaceAll("-", "")
    assert.match(sqlSuffix, /^[a-f0-9]{32}$/)
    const triggerName = `vendly_test_replacement_order_item_fail_${sqlSuffix}`
    const functionName = `vendly_test_replacement_order_item_fail_${sqlSuffix}`
    let consumerId: number | undefined
    let sellerId: number | undefined
    let listingId: number | undefined
    let server: Server | undefined
    let functionInstallAttempted = false
    let triggerInstallAttempted = false

    try {
        const consumer = await prisma.user.create({
            data: {
                name: "Checkout replacement rollback test consumer",
                email: `checkout-replacement-rollback-consumer-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "CONSUMER",
                cart: { create: {} }
            }
        })

        consumerId = consumer.id
        const seller = await prisma.user.create({
            data: {
                name: "Checkout replacement rollback test seller",
                email: `checkout-replacement-rollback-seller-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "SELLER",
                sellerProfile: {
                    create: {
                        businessName: "Checkout Replacement Rollback Test Shop",
                        state: "Lagos",
                        lga: "Ikeja",
                        location: "Ikeja, Lagos",
                        logoUrl: "https://example.test/logo.png",
                        slug: `checkout-replacement-rollback-${suffix}`,
                        shippingPolicy: "FREE",
                        shippingCost: null
                    }
                }
            }
        })
        sellerId = seller.id
        const listing = await prisma.listing.create({
            data: {
                title: "Checkout replacement rollback test listing",
                description: "Fixture for replacement transaction rollback coverage",
                price: 1500,
                stockQuantity: 5,
                category: "Electronics",
                imageUrl: "https://example.test/listing.png",
                userId: seller.id
            }
        })
        listingId = listing.id
        const cart = await prisma.cart.findUniqueOrThrow({
            where: { userId: consumer.id },
            select: { id: true }
        })
        const cartItem = await prisma.cartItem.create({
            data: {
                cartId: cart.id,
                listingId: listing.id,
                quantity: 1
            }
        })

        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
        const token = jwt.sign({ id: consumer.id }, jwtSecret)
        const app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use("/checkout", checkoutRoutes)
        server = createServer(app)
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        const baseUrl = `http://127.0.0.1:${address.port}`
        const headers = { cookie: `token=${token}` }
        const delivery = {
            fullName: "Test Consumer",
            phone: "08000000000",
            address: "1 Test Street",
            state: "Lagos",
            lga: "Ikeja"
        }

        const initialPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(initialPreviewResponse.status, 200)
        const initialPreview = await initialPreviewResponse.json() as { reviewToken?: unknown }
        assert.equal(typeof initialPreview.reviewToken, "string")
        const initialCheckoutResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: initialPreview.reviewToken, delivery })
        })
        assert.equal(initialCheckoutResponse.status, 201)
        const initialCheckoutBody = await initialCheckoutResponse.json() as {
            code?: unknown
            checkout?: { id?: unknown }
        }
        assert.equal(initialCheckoutBody.code, "CHECKOUT_CREATED")
        const oldCheckoutId = initialCheckoutBody.checkout?.id
        assert.ok(typeof oldCheckoutId === "number", "Initial checkout response must include its ID")

        await prisma.cartItem.update({
            where: { id: cartItem.id },
            data: { quantity: 2 }
        })
        const replacementPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(replacementPreviewResponse.status, 200)
        const replacementPreview = await replacementPreviewResponse.json() as { reviewToken?: unknown }
        assert.equal(typeof replacementPreview.reviewToken, "string")

        const fixtureListingId = listing.id
        const fixtureConsumerId = consumer.id
        assert.ok(Number.isSafeInteger(fixtureListingId) && fixtureListingId > 0)
        assert.ok(Number.isSafeInteger(fixtureConsumerId) && fixtureConsumerId > 0)
        assert.match(triggerName, /^vendly_test_replacement_order_item_fail_[a-f0-9]{32}$/)
        assert.match(functionName, /^vendly_test_replacement_order_item_fail_[a-f0-9]{32}$/)

        functionInstallAttempted = true
        await prisma.$executeRawUnsafe(`
            CREATE FUNCTION public."${functionName}"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $trigger$
            BEGIN
                IF NEW."listingId" = TG_ARGV[0]::integer
                    AND EXISTS (
                        SELECT 1
                        FROM public."Order" AS test_order
                        JOIN public."Checkout" AS test_checkout
                            ON test_checkout."id" = test_order."checkoutId"
                        WHERE test_order."id" = NEW."orderId"
                            AND test_checkout."userId" = TG_ARGV[1]::integer
                    )
                THEN
                    RAISE EXCEPTION 'integration test forced replacement OrderItem insert failure';
                END IF;
                RETURN NEW;
            END;
            $trigger$
        `)
        triggerInstallAttempted = true
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            BEFORE INSERT ON public."OrderItem"
            FOR EACH ROW
            EXECUTE FUNCTION public."${functionName}"('${fixtureListingId}', '${fixtureConsumerId}')
        `)

        const replacementResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: replacementPreview.reviewToken, delivery })
        })
        assert.equal(replacementResponse.status, 500)
        assert.deepEqual(await replacementResponse.json(), {
            message: "Sorry, there is an issue on our end"
        })

        const [oldCheckout, checkoutCount, checkoutItemCount, reservationCount, orderCount, orderItemCount, finalListing] =
            await Promise.all([
                prisma.checkout.findUniqueOrThrow({
                    where: { id: oldCheckoutId },
                    include: {
                        checkoutItems: true,
                        inventoryReservations: true,
                        orders: { include: { orderItems: true } }
                    }
                }),
                prisma.checkout.count({ where: { userId: consumer.id } }),
                prisma.checkoutItem.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.inventoryReservation.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.order.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.orderItem.count({ where: { order: { checkout: { userId: consumer.id } } } }),
                prisma.listing.findUniqueOrThrow({
                    where: { id: listing.id },
                    select: { stockQuantity: true }
                })
            ])

        assert.equal(oldCheckout.userId, consumer.id)
        assert.equal(oldCheckout.status, "PENDING")
        assert.deepEqual(oldCheckout.checkoutItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 1
        }])
        assert.deepEqual(oldCheckout.inventoryReservations.map(({ listingId: reservationListingId, quantity, status }) => ({
            listingId: reservationListingId,
            quantity,
            status
        })), [{ listingId: listing.id, quantity: 1, status: "ACTIVE" }])
        assert.equal(oldCheckout.orders.length, 1)
        assert.equal(oldCheckout.orders[0]?.status, "PENDING_PAYMENT")
        assert.deepEqual(oldCheckout.orders[0]?.orderItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 1
        }])

        assert.equal(checkoutCount, 1, "Failed replacement must not leave a second checkout")
        assert.equal(checkoutItemCount, 1, "Only the original checkout item should remain")
        assert.equal(reservationCount, 1, "Only the original reservation should remain")
        assert.equal(orderCount, 1, "Only the original order should remain")
        assert.equal(orderItemCount, 1, "Only the original order item should remain")
        assert.equal(finalListing.stockQuantity, 5)
    } finally {
        const cleanupErrors: Error[] = []
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
            try {
                await operation()
            } catch (error) {
                cleanupErrors.push(new Error(`${label} failed`, { cause: error }))
            }
        }
        if (server?.listening) {
            await cleanup("HTTP server shutdown", () => new Promise<void>((resolve, reject) => {
                server!.close((error) => error ? reject(error) : resolve())
            }))
        }
        if (triggerInstallAttempted && listingId !== undefined) {
            await cleanup("Test trigger removal", () => prisma.$executeRawUnsafe(
                `DROP TRIGGER IF EXISTS "${triggerName}" ON public."OrderItem"`
            ))
        }
        if (functionInstallAttempted) {
            await cleanup("Test trigger function removal", () => prisma.$executeRawUnsafe(
                `DROP FUNCTION IF EXISTS public."${functionName}"()`
            ))
        }
        if (consumerId !== undefined) {
            await cleanup("Checkout fixture cleanup", async () => {
                const checkoutIds = (await prisma.checkout.findMany({
                    where: { userId: consumerId },
                    select: { id: true }
                })).map(({ id }) => id)
                if (checkoutIds.length > 0) {
                    await prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                    await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
                }
                await prisma.cartItem.deleteMany({ where: { cart: { userId: consumerId } } })
                await prisma.cart.deleteMany({ where: { userId: consumerId } })
            })
        }
        if (listingId !== undefined) {
            await cleanup("Fixture listing cleanup", () => prisma.listing.delete({ where: { id: listingId } }))
        }
        if (sellerId !== undefined) {
            await cleanup("Fixture seller cleanup", async () => {
                await prisma.sellerProfile.deleteMany({ where: { userId: sellerId } })
                await prisma.user.delete({ where: { id: sellerId } })
            })
        }
        if (consumerId !== undefined) {
            await cleanup("Fixture consumer cleanup", () => prisma.user.delete({ where: { id: consumerId } }))
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Checkout replacement rollback test cleanup failed.")
        }
    }
})

test("rejects checkout replacement after payment activity", async () => {
    const suffix = randomUUID()
    const providerRef = `checkout-payment-activity-${suffix}`
    let consumerId: number | undefined
    let sellerId: number | undefined
    let listingId: number | undefined
    let server: Server | undefined

    try {
        const consumer = await prisma.user.create({
            data: {
                name: "Checkout payment activity test consumer",
                email: `checkout-payment-activity-consumer-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "CONSUMER",
                cart: { create: {} }
            }
        })

        consumerId = consumer.id
        const seller = await prisma.user.create({
            data: {
                name: "Checkout payment activity test seller",
                email: `checkout-payment-activity-seller-${suffix}@example.test`,
                passwordHash: "integration-test-not-a-password",
                role: "SELLER",
                sellerProfile: {
                    create: {
                        businessName: "Checkout Payment Activity Test Shop",
                        state: "Lagos",
                        lga: "Ikeja",
                        location: "Ikeja, Lagos",
                        logoUrl: "https://example.test/logo.png",
                        slug: `checkout-payment-activity-${suffix}`,
                        shippingPolicy: "FREE",
                        shippingCost: null
                    }
                }
            }
        })
        sellerId = seller.id
        const listing = await prisma.listing.create({
            data: {
                title: "Checkout payment activity test listing",
                description: "Fixture for payment-activity replacement rejection coverage",
                price: 1500,
                stockQuantity: 5,
                category: "Electronics",
                imageUrl: "https://example.test/listing.png",
                userId: seller.id
            }
        })
        listingId = listing.id
        const cart = await prisma.cart.findUniqueOrThrow({
            where: { userId: consumer.id },
            select: { id: true }
        })
        const cartItem = await prisma.cartItem.create({
            data: {
                cartId: cart.id,
                listingId: listing.id,
                quantity: 1
            }
        })

        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
        const token = jwt.sign({ id: consumer.id }, jwtSecret)
        const app = express()
        app.use(express.json())
        app.use(cookieParser())
        app.use("/checkout", checkoutRoutes)
        server = createServer(app)
        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject)
            server!.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        const baseUrl = `http://127.0.0.1:${address.port}`
        const headers = { cookie: `token=${token}` }
        const delivery = {
            fullName: "Test Consumer",
            phone: "08000000000",
            address: "1 Test Street",
            state: "Lagos",
            lga: "Ikeja"
        }

        const initialPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(initialPreviewResponse.status, 200)
        const initialPreview = await initialPreviewResponse.json() as { reviewToken?: unknown }
        assert.equal(typeof initialPreview.reviewToken, "string")
        const initialCheckoutResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: initialPreview.reviewToken, delivery })
        })
        assert.equal(initialCheckoutResponse.status, 201)
        const initialCheckoutBody = await initialCheckoutResponse.json() as {
            code?: unknown
            checkout?: { id?: unknown }
        }
        assert.equal(initialCheckoutBody.code, "CHECKOUT_CREATED")
        const checkoutId = initialCheckoutBody.checkout?.id
        assert.ok(typeof checkoutId === "number", "Initial checkout response must include its ID")

        const paymentAttempt = await prisma.paymentAttempt.create({
            data: {
                checkoutId,
                reference: `TEST-${randomUUID()}`,
                provider: "PAYSTACK",
                providerRef,
                amount: new Prisma.Decimal("1500.00"),
                currency: "NGN",
                status: "PENDING"
            }
        })
        await prisma.checkout.update({
            where: { id: checkoutId },
            data: { status: "PAYMENT_PENDING" }
        })

        await prisma.cartItem.update({
            where: { id: cartItem.id },
            data: { quantity: 2 }
        })
        const changedCartPreviewResponse = await fetch(`${baseUrl}/checkout/preview`, { headers })
        assert.equal(changedCartPreviewResponse.status, 200)
        const changedCartPreview = await changedCartPreviewResponse.json() as {
            reviewToken?: unknown
            sellers?: Array<{ items?: Array<{ listingId?: number; quantity?: number; availableQuantity?: number }> }>
        }
        assert.equal(typeof changedCartPreview.reviewToken, "string")
        assert.deepEqual(
            changedCartPreview.sellers?.flatMap((seller) => seller.items ?? []).map((item) => ({
                listingId: item.listingId,
                quantity: item.quantity,
                availableQuantity: item.availableQuantity
            })),
            [{ listingId: listing.id, quantity: 2, availableQuantity: listing.stockQuantity }]
        )

        const replacementResponse = await fetch(`${baseUrl}/checkout`, {
            method: "POST",
            headers: {
                ...headers,
                "content-type": "application/json"
            },
            body: JSON.stringify({ reviewToken: changedCartPreview.reviewToken, delivery })
        })
        assert.equal(replacementResponse.status, 409)
        const replacementBody = await replacementResponse.json() as {
            code?: unknown
            checkout?: { id?: unknown; status?: unknown; expiresAt?: unknown }
        }
        assert.equal(replacementBody.code, "CHECKOUT_LOCKED")
        assert.equal(replacementBody.checkout?.id, checkoutId)
        assert.equal(replacementBody.checkout?.status, "PAYMENT_PENDING")
        assert.equal(typeof replacementBody.checkout?.expiresAt, "string")

        const [originalCheckout, checkoutCount, checkoutItemCount, reservationCount, orderCount, orderItemCount, finalListing] =
            await Promise.all([
                prisma.checkout.findUniqueOrThrow({
                    where: { id: checkoutId },
                    include: {
                        checkoutItems: true,
                        inventoryReservations: true,
                        orders: { include: { orderItems: true } },
                        paymentAttempts: true
                    }
                }),
                prisma.checkout.count({ where: { userId: consumer.id } }),
                prisma.checkoutItem.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.inventoryReservation.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.order.count({ where: { checkout: { userId: consumer.id } } }),
                prisma.orderItem.count({ where: { order: { checkout: { userId: consumer.id } } } }),
                prisma.listing.findUniqueOrThrow({
                    where: { id: listing.id },
                    select: { stockQuantity: true }
                })
            ])

        assert.equal(originalCheckout.userId, consumer.id)
        assert.equal(originalCheckout.status, "PAYMENT_PENDING")
        assert.deepEqual(originalCheckout.checkoutItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 1
        }])
        assert.deepEqual(originalCheckout.paymentAttempts.map(({ id, provider, providerRef: savedProviderRef, amount, currency, status }) => ({
            id,
            provider,
            providerRef: savedProviderRef,
            amount: amount.toString(),
            currency,
            status
        })), [{
            id: paymentAttempt.id,
            provider: "PAYSTACK",
            providerRef,
            amount: "1500",
            currency: "NGN",
            status: "PENDING"
        }])
        assert.equal(originalCheckout.paymentAttempts.length, 1)
        assert.deepEqual(originalCheckout.inventoryReservations.map(({ listingId: reservationListingId, quantity, status }) => ({
            listingId: reservationListingId,
            quantity,
            status
        })), [{ listingId: listing.id, quantity: 1, status: "ACTIVE" }])
        assert.equal(originalCheckout.orders.length, 1)
        assert.equal(originalCheckout.orders[0]?.status, "PENDING_PAYMENT")
        assert.deepEqual(originalCheckout.orders[0]?.orderItems.map(({ listingId: itemListingId, title, unitPrice, quantity }) => ({
            listingId: itemListingId,
            title,
            unitPrice: unitPrice.toString(),
            quantity
        })), [{
            listingId: listing.id,
            title: listing.title,
            unitPrice: "1500",
            quantity: 1
        }])

        assert.equal(checkoutCount, 1, "Rejected replacement must not create another checkout")
        assert.equal(checkoutItemCount, 1, "Only the original checkout item should remain")
        assert.equal(reservationCount, 1, "Only the original reservation should remain")
        assert.equal(orderCount, 1, "Only the original order should remain")
        assert.equal(orderItemCount, 1, "Only the original order item should remain")
        assert.equal(finalListing.stockQuantity, 5)
    } finally {
        const cleanupErrors: Error[] = []
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
            try {
                await operation()
            } catch (error) {
                cleanupErrors.push(new Error(`${label} failed`, { cause: error }))
            }
        }
        if (server?.listening) {
            await cleanup("HTTP server shutdown", () => new Promise<void>((resolve, reject) => {
                server!.close((error) => error ? reject(error) : resolve())
            }))
        }
        if (consumerId !== undefined) {
            await cleanup("Checkout fixture cleanup", async () => {
                const checkoutIds = (await prisma.checkout.findMany({
                    where: { userId: consumerId },
                    select: { id: true }
                })).map(({ id }) => id)
                if (checkoutIds.length > 0) {
                    await prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                    await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                    await prisma.checkout.deleteMany({ where: { id: { in: checkoutIds } } })
                }
                await prisma.cartItem.deleteMany({ where: { cart: { userId: consumerId } } })
                await prisma.cart.deleteMany({ where: { userId: consumerId } })
            })
        }
        if (listingId !== undefined) {
            await cleanup("Fixture listing cleanup", () => prisma.listing.delete({ where: { id: listingId } }))
        }
        if (sellerId !== undefined) {
            await cleanup("Fixture seller cleanup", async () => {
                await prisma.sellerProfile.deleteMany({ where: { userId: sellerId } })
                await prisma.user.delete({ where: { id: sellerId } })
            })
        }
        if (consumerId !== undefined) {
            await cleanup("Fixture consumer cleanup", () => prisma.user.delete({ where: { id: consumerId } }))
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Checkout payment-activity test cleanup failed.")
        }
    }
})

test("expires an overdue checkout without payment attempts and releases its reservation", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-normal-expiration", 5, 2)

    try {
        const checkoutId = await fixture.createCheckout()
        const expiredAt = new Date(Date.now() - 60_000)
        await prisma.checkout.update({
            where: { id: checkoutId },
            data: { expiresAt: expiredAt }
        })
        await prisma.inventoryReservation.updateMany({
            where: { checkoutId },
            data: { expiresAt: expiredAt }
        })

        const response = await fetch(`${fixture.baseUrl}/checkout/preview`, {
            headers: { cookie: `token=${fixture.token}` }
        })
        assert.equal(response.status, 200)
        const preview = await response.json() as {
            sellers?: Array<{ items?: Array<{ availableQuantity?: number }> }>
        }
        assert.equal(preview.sellers?.[0]?.items?.[0]?.availableQuantity, 5)

        const checkout = await prisma.checkout.findUniqueOrThrow({
            where: { id: checkoutId },
            include: {
                inventoryReservations: true,
                orders: true
            }
        })
        assert.equal(checkout.status, "EXPIRED")
        assert.equal(checkout.inventoryReservations[0]?.status, "EXPIRED")
        assert.equal(checkout.orders[0]?.status, "CANCELLED")
    } finally {
        await fixture.cleanup()
    }
})

test("expires an overdue checkout but protects its reservation while payment is unresolved", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-unresolved-expiration", 3, 2)

    try {
        const checkoutId = await fixture.createCheckout()
        const expiredAt = new Date(Date.now() - 60_000)
        await prisma.paymentAttempt.create({
            data: {
                checkoutId,
                reference: `TEST-${randomUUID()}`,
                provider: "PAYSTACK",
                providerRef: `checkout-unresolved-${randomUUID()}`,
                amount: new Prisma.Decimal("3000.00"),
                currency: "NGN",
                status: "PENDING"
            }
        })
        await prisma.checkout.update({
            where: { id: checkoutId },
            data: { status: "PAYMENT_PENDING", expiresAt: expiredAt }
        })
        await prisma.inventoryReservation.updateMany({
            where: { checkoutId },
            data: { expiresAt: expiredAt }
        })

        const response = await fetch(`${fixture.baseUrl}/checkout/preview`, {
            headers: { cookie: `token=${fixture.token}` }
        })
        assert.equal(response.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(await response.json()),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )

        const checkout = await prisma.checkout.findUniqueOrThrow({
            where: { id: checkoutId },
            include: {
                inventoryReservations: true,
                orders: true,
                paymentAttempts: true
            }
        })
        assert.equal(checkout.status, "EXPIRED")
        assert.equal(checkout.paymentAttempts[0]?.status, "PENDING")
        assert.equal(checkout.inventoryReservations[0]?.status, "PROTECTED")
        assert.equal(checkout.orders[0]?.status, "PENDING_PAYMENT")
    } finally {
        await fixture.cleanup()
    }
})

test("protected expired-payment reservations remain unavailable across inventory endpoints", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-protected-inventory", 3, 2)

    try {
        const checkoutId = await fixture.createCheckout()
        const expiredAt = new Date(Date.now() - 60_000)
        await prisma.paymentAttempt.createMany({
            data: [
                {
                    checkoutId,
                    reference: `TEST-${randomUUID()}`,
                    provider: "PAYSTACK",
                    providerRef: `checkout-protected-failed-${randomUUID()}`,
                    amount: new Prisma.Decimal("3000.00"),
                    status: "FAILED"
                },
                {
                    checkoutId,
                    reference: `TEST-${randomUUID()}`,
                    provider: "FLUTTERWAVE",
                    providerRef: `checkout-protected-pending-${randomUUID()}`,
                    amount: new Prisma.Decimal("3000.00"),
                    status: "PENDING"
                }
            ]
        })
        await prisma.checkout.update({
            where: { id: checkoutId },
            data: { status: "PAYMENT_PENDING", expiresAt: expiredAt }
        })
        await prisma.inventoryReservation.updateMany({
            where: { checkoutId },
            data: { expiresAt: expiredAt }
        })

        const expireResponse = await fetch(`${fixture.baseUrl}/checkout/preview`, {
            headers: { cookie: `token=${fixture.token}` }
        })
        assert.equal(expireResponse.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(await expireResponse.json()),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )

        const otherConsumer = await fixture.addConsumer(2)
        const cartResponse = await fetch(`${fixture.baseUrl}/cart`, {
            headers: { cookie: `token=${otherConsumer.token}` }
        })
        assert.equal(cartResponse.status, 200)
        const cartBody = await cartResponse.json() as {
            cart?: { cartItems?: Array<{ availableQuantity?: number }> }
        }
        assert.equal(cartBody.cart?.cartItems?.[0]?.availableQuantity, 1)

        const otherConsumerPreview = await fetch(`${fixture.baseUrl}/checkout/preview`, {
            headers: { cookie: `token=${otherConsumer.token}` }
        })
        assert.equal(otherConsumerPreview.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(await otherConsumerPreview.json()),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )

        const stockUpdateResponse = await fetch(`${fixture.baseUrl}/listings/${fixture.listingId}`, {
            method: "PATCH",
            headers: {
                cookie: `token=${fixture.sellerToken}`,
                "content-type": "application/json"
            },
            body: JSON.stringify({ stockQuantity: 1 })
        })
        assert.equal(stockUpdateResponse.status, 409)
        assert.equal(
            (await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })).stockQuantity,
            3
        )
        const protectedReservation = await prisma.inventoryReservation.findFirstOrThrow({
            where: { checkoutId, status: "PROTECTED" }
        })
        assert.equal(protectedReservation.expiresAt.getTime(), expiredAt.getTime())
    } finally {
        await fixture.cleanup()
    }
})

test("replaces an eligible checkout when only delivery details change", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-delivery-change", 5, 2)

    try {
        const oldCheckoutId = await fixture.createCheckout()
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)

        const response = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: changedDelivery
        })
        assert.equal(response.status, 201)
        assert.equal(response.body.code, "CHECKOUT_REPLACED")
        const newCheckoutId = response.body.checkout?.id
        assert.ok(typeof newCheckoutId === "number")
        assert.notEqual(newCheckoutId, oldCheckoutId)
        assert.deepEqual(response.body.checkout?.delivery, changedDelivery)

        const checkouts = await loadConsumerCheckouts(fixture.consumerId)
        assert.deepEqual(checkouts.map(({ id }) => id), [oldCheckoutId, newCheckoutId])
        const [oldCheckout, newCheckout] = checkouts
        assert.equal(oldCheckout?.status, "EXPIRED")
        assert.equal(oldCheckout?.deliveryAddress, fixtureDelivery.address)
        assert.deepEqual(oldCheckout?.inventoryReservations.map(({ status }) => status), ["RELEASED"])
        assert.deepEqual(oldCheckout?.orders.map(({ status }) => status), ["CANCELLED"])
        assert.equal(newCheckout?.status, "PENDING")
        assert.deepEqual(
            {
                fullName: newCheckout?.deliveryName,
                phone: newCheckout?.deliveryPhone,
                address: newCheckout?.deliveryAddress,
                state: newCheckout?.deliveryState,
                lga: newCheckout?.deliveryLga,
                instructions: newCheckout?.deliveryInstructions
            },
            changedDelivery
        )
        assert.deepEqual(
            newCheckout?.inventoryReservations.map(({ listingId, quantity, status }) => ({ listingId, quantity, status })),
            [{ listingId: fixture.listingId, quantity: 2, status: "ACTIVE" }]
        )
        assert.deepEqual(
            newCheckout?.orders.map(({ status, deliveryAddress }) => ({ status, deliveryAddress })),
            [{ status: "PENDING_PAYMENT", deliveryAddress: changedDelivery.address }]
        )
        await assertReservedWithinStock(fixture.listingId, 2, 5)
    } finally {
        await fixture.cleanup()
    }
})

test("replaces an eligible checkout when the cart and delivery details change", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-cart-delivery-change", 5, 2)

    try {
        const oldCheckoutId = await fixture.createCheckout()
        await prisma.cartItem.updateMany({
            where: { cart: { userId: fixture.consumerId } },
            data: { quantity: 3 }
        })
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)

        const response = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: changedDelivery
        })
        assert.equal(response.status, 201)
        assert.equal(response.body.code, "CHECKOUT_REPLACED")

        const [oldCheckout, newCheckout, ...otherCheckouts] = await loadConsumerCheckouts(fixture.consumerId)
        assert.equal(otherCheckouts.length, 0)
        assert.equal(oldCheckout?.id, oldCheckoutId)
        assert.equal(oldCheckout?.status, "EXPIRED")
        assert.deepEqual(oldCheckout?.inventoryReservations.map(({ status }) => status), ["RELEASED"])
        assert.deepEqual(oldCheckout?.orders.map(({ status }) => status), ["CANCELLED"])
        assert.equal(newCheckout?.id, response.body.checkout?.id)
        assert.equal(newCheckout?.deliveryAddress, changedDelivery.address)
        assert.deepEqual(
            newCheckout?.inventoryReservations.map(({ quantity, status }) => ({ quantity, status })),
            [{ quantity: 3, status: "ACTIVE" }]
        )
        await assertReservedWithinStock(fixture.listingId, 3, 5)
    } finally {
        await fixture.cleanup()
    }
})

test("requires review before a delivery change with a stale review token", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-delivery-stale-review", 5, 2)

    try {
        const checkoutId = await fixture.createCheckout()
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)
        await prisma.listing.update({
            where: { id: fixture.listingId },
            data: { price: 1750 }
        })

        const response = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: changedDelivery
        })
        assert.equal(response.status, 409)
        assert.equal(response.body.code, "CHECKOUT_REVIEW_REQUIRED")
        assert.equal(typeof response.body.review?.reviewToken, "string")
        assert.notEqual(response.body.review?.reviewToken, preview.body.reviewToken)

        const checkouts = await loadConsumerCheckouts(fixture.consumerId)
        assert.deepEqual(checkouts.map(({ id, status, deliveryAddress }) => ({ id, status, deliveryAddress })), [
            { id: checkoutId, status: "PENDING", deliveryAddress: fixtureDelivery.address }
        ])
        assert.deepEqual(checkouts[0]?.inventoryReservations.map(({ status }) => status), ["ACTIVE"])
        assert.deepEqual(checkouts[0]?.orders.map(({ status }) => status), ["PENDING_PAYMENT"])
        await assertReservedWithinStock(fixture.listingId, 2, 5)
    } finally {
        await fixture.cleanup()
    }
})

test("locks delivery changes while an existing checkout has payment activity", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-delivery-locked", 5, 2)

    try {
        const checkoutId = await fixture.createCheckout()
        await prisma.paymentAttempt.create({
            data: {
                checkoutId,
                reference: `TEST-${randomUUID()}`,
                provider: "PAYSTACK",
                providerRef: `checkout-delivery-locked-${randomUUID()}`,
                amount: new Prisma.Decimal("3000.00"),
                currency: "NGN",
                status: "PENDING"
            }
        })
        await prisma.checkout.update({
            where: { id: checkoutId },
            data: { status: "PAYMENT_PENDING" }
        })
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)

        for (const reviewToken of [preview.body.reviewToken, "0".repeat(64), undefined]) {
            const response = await submitCheckout(fixture, {
                ...(reviewToken === undefined ? {} : { reviewToken }),
                delivery: changedDelivery
            })
            assert.equal(response.status, 409)
            assert.equal(response.body.code, "CHECKOUT_LOCKED")
            assert.equal(response.body.message, paymentActivityLockMessage)
            assert.equal(response.body.checkout?.id, checkoutId)
            assert.equal(response.body.checkout?.status, "PAYMENT_PENDING")
            assert.equal(typeof response.body.checkout?.expiresAt, "string")
        }

        const reuseResponse = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: fixtureDelivery
        })
        assert.equal(reuseResponse.status, 200)
        assert.equal(reuseResponse.body.code, "CHECKOUT_REUSED")
        assert.equal(reuseResponse.body.checkout?.id, checkoutId)

        const checkouts = await loadConsumerCheckouts(fixture.consumerId)
        assert.deepEqual(checkouts.map(({ id, status, deliveryAddress }) => ({ id, status, deliveryAddress })), [
            { id: checkoutId, status: "PAYMENT_PENDING", deliveryAddress: fixtureDelivery.address }
        ])
        assert.deepEqual(checkouts[0]?.inventoryReservations.map(({ status }) => status), ["ACTIVE"])
        assert.deepEqual(checkouts[0]?.orders.map(({ status }) => status), ["PENDING_PAYMENT"])
        await assertReservedWithinStock(fixture.listingId, 2, 5)
    } finally {
        await fixture.cleanup()
    }
})

test("reports insufficient stock as unavailable checkout items in preview and creation", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-items-stock", 1, 2)

    try {
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(preview.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )

        const response = await submitCheckout(fixture, { delivery: fixtureDelivery })
        assert.equal(response.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(response.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )
        assert.equal((await loadConsumerCheckouts(fixture.consumerId)).length, 0)
    } finally {
        await fixture.cleanup()
    }
})

test("reports unconfigured seller shipping as unavailable checkout items", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-items-shipping", 5, 2)

    try {
        await prisma.sellerProfile.update({
            where: { userId: fixture.sellerId },
            data: { shippingPolicy: "FIXED", shippingCost: null }
        })

        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(preview.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )

        const response = await submitCheckout(fixture, { delivery: fixtureDelivery })
        assert.equal(response.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(response.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )
        assert.equal((await loadConsumerCheckouts(fixture.consumerId)).length, 0)
    } finally {
        await fixture.cleanup()
    }
})

test("rejects checkout totals above the supported amount in preview and creation", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-items-maximum-total", 5, 2)

    try {
        await prisma.listing.update({
            where: { id: fixture.listingId },
            data: { price: 6_000_000_000 }
        })

        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(preview.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: undefined }
        )

        const response = await submitCheckout(fixture, { delivery: fixtureDelivery })
        assert.equal(response.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(response.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: undefined }
        )
        assert.equal((await loadConsumerCheckouts(fixture.consumerId)).length, 0)
    } finally {
        await fixture.cleanup()
    }
})

test("reports a missing seller storefront as unavailable checkout items", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-items-storefront", 5, 2)

    try {
        await prisma.sellerProfile.delete({ where: { userId: fixture.sellerId } })

        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(preview.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )

        const response = await submitCheckout(fixture, { delivery: fixtureDelivery })
        assert.equal(response.status, 409)
        assert.deepEqual(
            pickItemsUnavailable(response.body),
            { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
        )
        assert.equal((await loadConsumerCheckouts(fixture.consumerId)).length, 0)
    } finally {
        await fixture.cleanup()
    }
})

test("locks replacement when an existing checkout has only failed payment attempts", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-failed-payment-lock", 5, 2)

    try {
        const checkoutId = await fixture.createCheckout()
        await prisma.paymentAttempt.create({
            data: {
                checkoutId,
                reference: `TEST-${randomUUID()}`,
                provider: "PAYSTACK",
                providerRef: `checkout-failed-payment-lock-${randomUUID()}`,
                amount: new Prisma.Decimal("3000.00"),
                currency: "NGN",
                status: "FAILED"
            }
        })
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)

        const response = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: changedDelivery
        })
        assert.equal(response.status, 409)
        assert.equal(response.body.code, "CHECKOUT_LOCKED")
        assert.equal(response.body.message, paymentActivityLockMessage)
        assert.equal(response.body.checkout?.id, checkoutId)
        assert.equal(response.body.checkout?.status, "PENDING")
        await assertCheckoutUnchanged(fixture, checkoutId, "PENDING")
        await assertReservedWithinStock(fixture.listingId, 2, 5)
    } finally {
        await fixture.cleanup()
    }
})

test("describes non-payment lock conditions as a checkout being processed", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-processing-lock", 5, 2)

    try {
        const checkoutId = await fixture.createCheckout()
        await prisma.order.updateMany({
            where: { checkoutId },
            data: { status: "PAID" }
        })
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)

        const response = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: changedDelivery
        })
        assert.equal(response.status, 409)
        assert.equal(response.body.code, "CHECKOUT_LOCKED")
        assert.equal(response.body.message, processingLockMessage)
        assert.equal(response.body.checkout?.id, checkoutId)
        await assertCheckoutUnchanged(fixture, checkoutId, "PENDING", "PAID")
    } finally {
        await fixture.cleanup()
    }
})

test("keeps the original checkout when a delivery-only replacement fails", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-delivery-rollback", 5, 2)
    let removeTrigger: (() => Promise<void>) | undefined

    try {
        const checkoutId = await fixture.createCheckout()
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)
        removeTrigger = await installRowTrigger({
            table: "OrderItem",
            event: "INSERT",
            column: "listingId",
            targetId: fixture.listingId,
            matchedStatement: "RAISE EXCEPTION 'integration test forced delivery replacement failure';"
        })

        const response = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: changedDelivery
        })
        assert.equal(response.status, 500)
        assert.deepEqual(response.body, { message: "Sorry, there is an issue on our end" })
        await assertCheckoutUnchanged(fixture, checkoutId, "PENDING")
        await assertReservedWithinStock(fixture.listingId, 2, 5)
    } finally {
        await removeTrigger?.()
        await fixture.cleanup()
    }
})

test("reports a retryable conflict when the replaced checkout changes during replacement", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-replacement-conflict", 5, 2)
    let removeTrigger: (() => Promise<void>) | undefined

    try {
        const checkoutId = await fixture.createCheckout()
        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 200)
        removeTrigger = await installRowTrigger({
            table: "Checkout",
            event: "UPDATE",
            column: "id",
            targetId: checkoutId,
            matchedStatement: "RETURN NULL;"
        })

        const response = await submitCheckout(fixture, {
            reviewToken: preview.body.reviewToken,
            delivery: changedDelivery
        })
        assert.equal(response.status, 409)
        assert.deepEqual(response.body, {
            code: "CHECKOUT_CONFLICT",
            message: "Checkout state changed before replacement could complete"
        })
        await assertCheckoutUnchanged(fixture, checkoutId, "PENDING")
        await assertReservedWithinStock(fixture.listingId, 2, 5)
    } finally {
        await removeTrigger?.()
        await fixture.cleanup()
    }
})

test("reports a retryable conflict when checkout expiry hits a serialization failure", async () => {
    const fixture = await createCheckoutLifecycleFixture("checkout-expiry-conflict", 5, 2)
    let removeTrigger: (() => Promise<void>) | undefined

    try {
        const checkoutId = await fixture.createCheckout()
        const expiredAt = new Date(Date.now() - 60_000)
        await prisma.checkout.update({
            where: { id: checkoutId },
            data: { expiresAt: expiredAt }
        })
        await prisma.inventoryReservation.updateMany({
            where: { checkoutId },
            data: { expiresAt: expiredAt }
        })
        removeTrigger = await installRowTrigger({
            table: "Checkout",
            event: "UPDATE",
            column: "id",
            targetId: checkoutId,
            matchedStatement: "RAISE EXCEPTION 'integration test forced serialization failure' USING ERRCODE = '40001';"
        })

        const preview = await requestCheckoutPreview(fixture)
        assert.equal(preview.status, 409)
        assert.deepEqual(preview.body, {
            code: "CHECKOUT_CONFLICT",
            message: "Checkout state changed while loading your cart. Please try again."
        })

        const response = await submitCheckout(fixture, { delivery: fixtureDelivery })
        assert.equal(response.status, 409)
        assert.deepEqual(response.body, {
            code: "CHECKOUT_CONFLICT",
            message: "Checkout state changed while creating checkout. Please try again."
        })

        const [checkout] = await loadConsumerCheckouts(fixture.consumerId)
        assert.equal(checkout?.status, "PENDING")
        assert.deepEqual(checkout?.inventoryReservations.map(({ status }) => status), ["ACTIVE"])
        assert.deepEqual(checkout?.orders.map(({ status }) => status), ["PENDING_PAYMENT"])
    } finally {
        await removeTrigger?.()
        await fixture.cleanup()
    }
})

async function updateListingStock(fixture: CheckoutLifecycleFixture, stockQuantity: unknown) {
    const response = await fetch(`${fixture.baseUrl}/listings/${fixture.listingId}`, {
        method: "PATCH",
        headers: {
            cookie: `token=${fixture.sellerToken}`,
            "content-type": "application/json"
        },
        body: JSON.stringify({ stockQuantity })
    })
    return {
        status: response.status,
        body: await response.json() as { message?: unknown; stockQuantity?: unknown }
    }
}

async function loadListingStock(listingId: number) {
    const listing = await prisma.listing.findUniqueOrThrow({
        where: { id: listingId },
        select: { stockQuantity: true }
    })
    return listing.stockQuantity
}

test("updates listing stock at or above the active reserved quantity", async () => {
    const fixture = await createCheckoutLifecycleFixture("listing-stock-update", 5, 2)

    try {
        await fixture.createCheckout()

        for (const stockQuantity of [2, 4]) {
            const response = await updateListingStock(fixture, stockQuantity)
            assert.equal(response.status, 200)
            assert.equal(response.body.stockQuantity, stockQuantity)
            assert.equal(await loadListingStock(fixture.listingId), stockQuantity)
        }
    } finally {
        await fixture.cleanup()
    }
})

test("rejects listing stock below the active reserved quantity without logging an unexpected error", async (t) => {
    const fixture = await createCheckoutLifecycleFixture("listing-stock-reserved", 5, 2)

    try {
        await fixture.createCheckout()
        const consoleError = t.mock.method(console, "error", () => {})

        const response = await updateListingStock(fixture, 1)
        assert.equal(response.status, 409)
        assert.deepEqual(response.body, {
            message: "Stock quantity cannot be less than 2 units currently reserved"
        })
        assert.equal(consoleError.mock.callCount(), 0)
        assert.equal(await loadListingStock(fixture.listingId), 5)
    } finally {
        await fixture.cleanup()
    }
})

test("rejects invalid listing stock values", async () => {
    const fixture = await createCheckoutLifecycleFixture("listing-stock-invalid", 5, 2)

    try {
        for (const stockQuantity of [-1, 1.5, "3", null]) {
            const response = await updateListingStock(fixture, stockQuantity)
            assert.equal(response.status, 400, `Expected 400 for ${JSON.stringify(stockQuantity)}`)
            assert.deepEqual(response.body, {
                message: "Stock quantity must be a whole number greater than or equal to 0"
            })
        }
        assert.equal(await loadListingStock(fixture.listingId), 5)
    } finally {
        await fixture.cleanup()
    }
})

test("logs unexpected listing stock update failures and returns a generic error", async (t) => {
    const fixture = await createCheckoutLifecycleFixture("listing-stock-unexpected", 5, 2)
    let removeTrigger: (() => Promise<void>) | undefined

    try {
        removeTrigger = await installRowTrigger({
            table: "Listing",
            event: "UPDATE",
            column: "id",
            targetId: fixture.listingId,
            matchedStatement: "RAISE EXCEPTION 'integration test forced listing update failure';"
        })
        const consoleError = t.mock.method(console, "error", () => {})

        const response = await updateListingStock(fixture, 4)
        assert.equal(response.status, 500)
        assert.deepEqual(response.body, { message: "Sorry there is an issue on our end" })
        assert.equal(consoleError.mock.callCount(), 1)
        const [operation, context, loggedError] = consoleError.mock.calls[0]?.arguments ?? []
        assert.equal(operation, "updateListing failed unexpectedly")
        assert.deepEqual(context, { listingId: fixture.listingId })
        assert.ok(loggedError instanceof Error)
        assert.match(loggedError.message, /integration test forced listing update failure/)
        assert.equal(await loadListingStock(fixture.listingId), 5)
    } finally {
        await removeTrigger?.()
        await fixture.cleanup()
    }
})

// Moves a checkout past its expiry with the given payment attempts, without any request from
// its owner, so its reservation is still ACTIVE when other users' requests run.
async function expireCheckoutWithPaymentAttempts(
    checkoutId: number,
    attemptStatuses: Array<"PENDING" | "SUCCESS" | "FAILED">
) {
    const expiredAt = new Date(Date.now() - 60_000)

    for (const status of attemptStatuses) {
        await prisma.paymentAttempt.create({
            data: {
                checkoutId,
                reference: `TEST-${randomUUID()}`,
                provider: "PAYSTACK",
                providerRef: `checkout-expired-attempt-${randomUUID()}`,
                amount: new Prisma.Decimal("3000.00"),
                currency: "NGN",
                status
            }
        })
    }

    await prisma.checkout.update({
        where: { id: checkoutId },
        data: {
            expiresAt: expiredAt,
            ...(attemptStatuses.length > 0 ? { status: "PAYMENT_PENDING" as const } : {})
        }
    })
    await prisma.inventoryReservation.updateMany({
        where: { checkoutId },
        data: { expiresAt: expiredAt }
    })
}

async function fetchCartAvailability(fixture: CheckoutLifecycleFixture, token: string) {
    const response = await fetch(`${fixture.baseUrl}/cart`, {
        headers: { cookie: `token=${token}` }
    })
    assert.equal(response.status, 200)
    const body = await response.json() as {
        cart?: { cartItems?: Array<{ availableQuantity?: number }> }
    }
    return body.cart?.cartItems?.[0]?.availableQuantity
}

for (const attemptStatus of ["PENDING", "SUCCESS"] as const) {
    test(`holds stock for an expired checkout with a ${attemptStatus} payment before its owner returns`, async () => {
        const fixture = await createCheckoutLifecycleFixture(`checkout-expired-${attemptStatus.toLowerCase()}-hold`, 3, 2)

        try {
            const checkoutId = await fixture.createCheckout()
            await expireCheckoutWithPaymentAttempts(checkoutId, [attemptStatus])
            const otherConsumer = await fixture.addConsumer(2)

            assert.equal(await fetchCartAvailability(fixture, otherConsumer.token), 1)

            const preview = await requestCheckoutPreview(fixture, otherConsumer.token)
            assert.equal(preview.status, 409)
            assert.deepEqual(
                pickItemsUnavailable(preview.body),
                { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
            )

            const response = await submitCheckout(fixture, { delivery: fixtureDelivery }, otherConsumer.token)
            assert.equal(response.status, 409)
            assert.deepEqual(
                pickItemsUnavailable(response.body),
                { code: "CHECKOUT_ITEMS_UNAVAILABLE", listingId: fixture.listingId }
            )
            assert.equal((await loadConsumerCheckouts(otherConsumer.id)).length, 0)

            const stockUpdate = await updateListingStock(fixture, 1)
            assert.equal(stockUpdate.status, 409)
            assert.deepEqual(stockUpdate.body, {
                message: "Stock quantity cannot be less than 2 units currently reserved"
            })
            assert.equal(await loadListingStock(fixture.listingId), 3)

            const [ownerCheckout] = await loadConsumerCheckouts(fixture.consumerId)
            assert.equal(ownerCheckout?.status, "PAYMENT_PENDING")
            assert.deepEqual(ownerCheckout?.inventoryReservations.map(({ status }) => status), ["ACTIVE"])
            assert.deepEqual(ownerCheckout?.orders.map(({ status }) => status), ["PENDING_PAYMENT"])
        } finally {
            await fixture.cleanup()
        }
    })
}

for (const [label, attemptStatuses] of [
    ["only failed payment attempts", ["FAILED"]],
    ["no payment attempts", []]
] as const) {
    test(`releases stock from an expired checkout with ${label}`, async () => {
        const fixture = await createCheckoutLifecycleFixture(`checkout-expired-release-${attemptStatuses.length}`, 3, 2)

        try {
            const checkoutId = await fixture.createCheckout()
            await expireCheckoutWithPaymentAttempts(checkoutId, [...attemptStatuses])
            const otherConsumer = await fixture.addConsumer(2)

            assert.equal(await fetchCartAvailability(fixture, otherConsumer.token), 3)

            const preview = await requestCheckoutPreview(fixture, otherConsumer.token)
            assert.equal(preview.status, 200)

            const stockUpdate = await updateListingStock(fixture, 2)
            assert.equal(stockUpdate.status, 200)
            assert.equal(await loadListingStock(fixture.listingId), 2)
        } finally {
            await fixture.cleanup()
        }
    })
}

// Runs requests against the real application wiring from src/app.ts.
async function withAppServer(run: (baseUrl: string) => Promise<void>) {
    const server = createServer(app)
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
    })

    try {
        const address = server.address()
        assert.ok(address && typeof address !== "string")
        await run(`http://127.0.0.1:${address.port}`)
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve())
        })
    }
}

async function readJsonResponse(response: Response) {
    assert.match(response.headers.get("content-type") ?? "", /application\/json/)
    return response.json() as Promise<unknown>
}

test("returns validation errors instead of crashing when a request has no JSON body", async () => {
    await withAppServer(async (baseUrl) => {
        for (const path of ["/users/register", "/users/login"]) {
            const response = await fetch(`${baseUrl}${path}`, { method: "POST" })
            assert.equal(response.status, 400, `Expected 400 from ${path}`)
            assert.deepEqual(await readJsonResponse(response), { message: "All areas are required" })
        }
    })
})

test("rejects malformed and oversized JSON bodies with JSON errors", async () => {
    await withAppServer(async (baseUrl) => {
        const malformed = await fetch(`${baseUrl}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not valid json"
        })
        assert.equal(malformed.status, 400)
        assert.deepEqual(await readJsonResponse(malformed), { message: "Request body must be valid JSON" })

        const oversized = await fetch(`${baseUrl}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "a".repeat(200_000), password: "x" })
        })
        assert.equal(oversized.status, 413)
        assert.deepEqual(await readJsonResponse(oversized), { message: "Request body is too large" })
    })
})

test("answers unknown routes and missing login cookies with JSON errors", async () => {
    await withAppServer(async (baseUrl) => {
        const unknownRoute = await fetch(`${baseUrl}/no-such-route`)
        assert.equal(unknownRoute.status, 404)
        assert.deepEqual(await readJsonResponse(unknownRoute), { message: "Route not found" })

        const missingCookie = await fetch(`${baseUrl}/cart`)
        assert.equal(missingCookie.status, 401)
        assert.deepEqual(await readJsonResponse(missingCookie), { message: "Login first" })
    })
})

test("logs unexpected errors outside controller error handling and returns a generic JSON 500", async (t) => {
    await withAppServer(async (baseUrl) => {
        const consoleError = t.mock.method(console, "error", () => {})
        // The login handler has no error handling around its password check, so a failure there reaches the app's own handler.
        t.mock.method(bcrypt, "compare", async () => { throw new Error("simulated failure") })

        const response = await fetch(`${baseUrl}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "someone@example.test", password: "integration-test-not-a-password" })
        })
        assert.equal(response.status, 500)
        assert.deepEqual(await readJsonResponse(response), { message: "Sorry there is an issue on our end" })
        assert.equal(consoleError.mock.callCount(), 1)
        const [operation, context, loggedError] = consoleError.mock.calls[0]?.arguments ?? []
        assert.equal(operation, "Unhandled request error")
        assert.deepEqual(context, { method: "POST", path: "/users/login" })
        assert.ok(loggedError instanceof Error)
    })
})

test("rejects non-integer listing ids as invalid", async () => {
    await withAppServer(async (baseUrl) => {
        for (const id of ["1.5", "abc", "1e400"]) {
            const response = await fetch(`${baseUrl}/listings/${id}`)
            assert.equal(response.status, 400, `Expected 400 for listing id ${id}`)
            assert.deepEqual(await readJsonResponse(response), { message: "Id has to be a number" })
        }
    })
})

test("uses local-development defaults when deployment settings are not configured", () => {
    assert.deepEqual(loadConfig({}), {
        port: 3000,
        frontendUrl: "http://localhost:5173",
        publicApiUrl: "http://localhost:3000",
        cookieSameSite: "lax",
        cookieSecure: false,
        trustProxy: false,
        maximumOrderValue: 100000,
        sellerDebtLimit: 50000
    })
    assert.equal(loadConfig({ NODE_ENV: "production" }).cookieSecure, true)
    assert.equal(loadConfig({ MAX_ORDER_VALUE: "250000", SELLER_DEBT_LIMIT: " 0 " }).maximumOrderValue, 250000)
    assert.equal(loadConfig({ MAX_ORDER_VALUE: "250000", SELLER_DEBT_LIMIT: " 0 " }).sellerDebtLimit, null)
    assert.equal(loadConfig({ MAX_ORDER_VALUE: "0" }).maximumOrderValue, null)
    for (const bad of ["abc", "-5", "1.5", "100000000000"]) {
        assert.throws(() => loadConfig({ MAX_ORDER_VALUE: bad }), /MAX_ORDER_VALUE must be a whole number of naira/)
        assert.throws(() => loadConfig({ SELLER_DEBT_LIMIT: bad }), /SELLER_DEBT_LIMIT must be a whole number of naira/)
    }
})

test("reads valid deployment settings from the environment", () => {
    assert.deepEqual(loadConfig({
        PORT: " 8080 ",
        FRONTEND_URL: "https://vendly.example/",
        COOKIE_SAME_SITE: "Strict"
    }), {
        port: 8080,
        frontendUrl: "https://vendly.example",
        publicApiUrl: "http://localhost:8080",
        cookieSameSite: "strict",
        cookieSecure: false,
        trustProxy: false,
        maximumOrderValue: 100000,
        sellerDebtLimit: 50000
    })
    assert.deepEqual(loadConfig({ COOKIE_SAME_SITE: "none" }).cookieSecure, true)
})

test("rejects invalid deployment settings with clear messages", () => {
    for (const port of ["abc", "0", "65536", "80.5", "-1"]) {
        assert.throws(() => loadConfig({ PORT: port }), /PORT must be a whole number between 1 and 65535/)
    }
    for (const frontendUrl of ["not a url", "ftp://vendly.example", "https://vendly.example/shop", "https://vendly.example/?x=1"]) {
        assert.throws(() => loadConfig({ FRONTEND_URL: frontendUrl }), /FRONTEND_URL must be/)
    }
    assert.throws(() => loadConfig({ COOKIE_SAME_SITE: "maybe" }), /COOKIE_SAME_SITE must be lax, strict or none/)
})

test("requires the database URL and JWT secret before the server starts", () => {
    assert.throws(
        () => assertRequiredEnvironment({}),
        /Missing required environment variables: DATABASE_URL, JWT_SECRET/
    )
    assert.throws(
        () => assertRequiredEnvironment({ DATABASE_URL: "postgresql://localhost/vendly", JWT_SECRET: " " }),
        /Missing required environment variables: JWT_SECRET/
    )
    assert.doesNotThrow(() => assertRequiredEnvironment({
        DATABASE_URL: "postgresql://localhost/vendly",
        JWT_SECRET: "configured"
    }))
})

test("allows cross-origin requests only from the configured frontend", async () => {
    await withAppServer(async (baseUrl) => {
        const allowed = await fetch(`${baseUrl}/listings/abc`, {
            headers: { origin: "http://localhost:5173" }
        })
        assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173")
        assert.equal(allowed.headers.get("access-control-allow-credentials"), "true")

        // With a single configured origin the header is fixed, so browsers block any other site
        // because it does not match their own origin. The unknown origin must never be echoed.
        const other = await fetch(`${baseUrl}/listings/abc`, {
            headers: { origin: "https://unknown.example" }
        })
        assert.equal(other.headers.get("access-control-allow-origin"), "http://localhost:5173")
    })
})

test("sets and clears the login cookie with the configured attributes", async () => {
    const email = `cookie-attributes-${randomUUID()}@example.test`
    const password = "integration-test-password"
    const user = await prisma.user.create({
        data: {
            name: "Cookie attributes test consumer",
            email,
            passwordHash: await bcrypt.hash(password, 4),
            role: "CONSUMER",
            emailVerifiedAt: new Date()
        }
    })

    try {
        await withAppServer(async (baseUrl) => {
            const passwordStep = await postJson(baseUrl, "/users/login", { email, password })
            assert.equal(passwordStep.status, 200)
            const login = await postJson(baseUrl, "/users/login/verify", { email, code: codeSentTo(email) })
            assert.equal(login.status, 200)
            const trustedCookie = login.headers.getSetCookie().find((cookie) => cookie.startsWith("trustedDevice=")) ?? ""
            assert.match(trustedCookie, /Path=\/users/)
            assert.match(trustedCookie, /HttpOnly/)
            assert.match(trustedCookie, /Max-Age=259\d{4}\b/)
            assert.match(trustedCookie, /SameSite=Lax/)
            const loginCookie = login.headers.getSetCookie().find((cookie) => cookie.startsWith("token=")) ?? ""
            assert.match(loginCookie, /^token=[^;]+;/)
            assert.match(loginCookie, /Max-Age=900/)
            assert.match(loginCookie, /HttpOnly/)
            assert.match(loginCookie, /SameSite=Lax/)
            assert.doesNotMatch(loginCookie, /Secure/)
            const refreshCookie = login.headers.getSetCookie().find((cookie) => cookie.startsWith("refreshToken=")) ?? ""
            assert.match(refreshCookie, /Path=\/users/)
            assert.match(refreshCookie, /HttpOnly/)
            assert.match(refreshCookie, /SameSite=Lax/)
            assert.doesNotMatch(refreshCookie, /Secure/)

            const logout = await fetch(`${baseUrl}/users/logout`, { method: "POST" })
            assert.equal(logout.status, 200)
            const logoutCookie = logout.headers.getSetCookie().find((cookie) => cookie.startsWith("token=")) ?? ""
            assert.match(logoutCookie, /^token=;/)
            assert.match(logoutCookie, /Expires=Thu, 01 Jan 1970/)
            assert.match(logoutCookie, /HttpOnly/)
            assert.match(logoutCookie, /SameSite=Lax/)
            // Logout clears the refresh cookie on the same path it was set on.
            const logoutRefreshCookie = logout.headers.getSetCookie().find((cookie) => cookie.startsWith("refreshToken=;")) ?? ""
            assert.match(logoutRefreshCookie, /Path=\/users/)
            assert.match(logoutRefreshCookie, /Expires=Thu, 01 Jan 1970/)
        })
    } finally {
        await prisma.user.delete({ where: { id: user.id } })
    }
})

type FakeProviderBehavior = {
    resolve?: (input: ResolveAccountInput) => Promise<{ accountName: string }>
    create?: (input: CreateSubaccountInput) => Promise<ProviderSubaccount>
    update?: (subaccount: ProviderSubaccount, input: CreateSubaccountInput) => Promise<void>
    initialize?: (input: InitializePaymentInput) => Promise<{ authorizationUrl: string }>
    verify?: (reference: string) => Promise<PaymentVerification>
    createRefund?: (input: CreateRefundInput) => Promise<ProviderRefund>
    findRefunds?: (input: { transactionReference: string; transactionId: string | null; providerRefundId: string | null }) => Promise<ProviderRefund[]>
    balance?: () => Promise<number | null>
}

// A refund as a provider reports it. By default it has just been accepted and is processing.
function fakeProviderRefund(overrides: Partial<ProviderRefund> & { amountKobo: number }): ProviderRefund {
    return {
        providerRefundId: `REFUND-${randomUUID()}`,
        outcome: "processing",
        providerStatus: "pending",
        awaitingFunds: false,
        expectedAt: null,
        createdAt: new Date(),
        ...overrides
    }
}

// Flutterwave also returns a numeric ID, which it needs for updates.
function fakeSubaccount(provider: PaymentProvider): ProviderSubaccount {
    return {
        subaccountCode: `${provider}-SUB-${randomUUID()}`,
        providerAccountId: provider === "FLUTTERWAVE" ? String(Math.floor(Math.random() * 1_000_000)) : null
    }
}

function installFakePaymentProviders() {
    const calls = {
        resolve: [] as Array<{ provider: PaymentProvider; input: ResolveAccountInput }>,
        create: [] as Array<{ provider: PaymentProvider; input: CreateSubaccountInput }>,
        update: [] as Array<{ provider: PaymentProvider; subaccount: ProviderSubaccount; input: CreateSubaccountInput }>,
        initialize: [] as Array<{ provider: PaymentProvider; input: InitializePaymentInput }>,
        verify: [] as Array<{ provider: PaymentProvider; reference: string }>,
        createRefund: [] as Array<{ provider: PaymentProvider; input: CreateRefundInput }>,
        findRefunds: [] as Array<{ provider: PaymentProvider; providerRefundId: string | null }>
    }
    const behaviors: Record<PaymentProvider, FakeProviderBehavior> = { PAYSTACK: {}, FLUTTERWAVE: {} }
    // Webhook signatures and parsing use the real provider code, which needs no network.
    const realAdapters = { PAYSTACK: paystackAdapter, FLUTTERWAVE: flutterwaveAdapter }
    const fakeAdapter = (provider: PaymentProvider): PaymentProviderAdapter => ({
        provider,
        verifyWebhook: (rawBody, headers) => realAdapters[provider].verifyWebhook(rawBody, headers),
        parseWebhook: (rawBody) => realAdapters[provider].parseWebhook(rawBody),
        async initializePayment(input) {
            calls.initialize.push({ provider, input })
            return behaviors[provider].initialize?.(input) ?? { authorizationUrl: `https://checkout.example.test/${input.reference}` }
        },
        async verifyPayment(reference) {
            calls.verify.push({ provider, reference })
            return behaviors[provider].verify?.(reference) ?? { outcome: "not_found" }
        },
        async resolveAccount(input) {
            calls.resolve.push({ provider, input })
            return behaviors[provider].resolve?.(input) ?? { accountName: "ADA OKAFOR" }
        },
        async createSubaccount(input) {
            calls.create.push({ provider, input })
            return behaviors[provider].create?.(input) ?? fakeSubaccount(provider)
        },
        async updateSubaccount(subaccount, input) {
            calls.update.push({ provider, subaccount, input })
            await behaviors[provider].update?.(subaccount, input)
        },
        async createRefund(input) {
            calls.createRefund.push({ provider, input })
            return behaviors[provider].createRefund?.(input) ?? fakeProviderRefund({ amountKobo: input.amountKobo })
        },
        async findRefunds(input) {
            calls.findRefunds.push({ provider, providerRefundId: input.providerRefundId })
            return behaviors[provider].findRefunds?.(input) ?? []
        },
        async getBalanceKobo() {
            // Plenty of money unless a test says otherwise, so refunds are not held up by default.
            return behaviors[provider].balance ? behaviors[provider].balance!() : 100_000_000_00
        }
    })
    setPaymentProvidersForTesting({ PAYSTACK: fakeAdapter("PAYSTACK"), FLUTTERWAVE: fakeAdapter("FLUTTERWAVE") })
    return { calls, behaviors }
}

type PayoutTestContext = {
    sellerProfileId: number
    fakes: ReturnType<typeof installFakePaymentProviders>
    request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; body: any; text: string }>
}

const payoutTestPassword = "payout-test-password"

const validPayoutRequest = {
    bankId: "opay",
    accountNumber: "0123456789",
    businessPhone: "+234 801 234 5678",
    acceptFeeTerms: true,
    feeTermsVersion: payoutFeeTerms.version
}

async function withPayoutSeller(
    name: string,
    run: (context: PayoutTestContext) => Promise<void>,
    options: { role?: "SELLER" | "CONSUMER"; withProfile?: boolean } = {}
) {
    const jwtSecret = process.env.JWT_SECRET
    assert.ok(jwtSecret, "JWT_SECRET must be configured for route integration tests")
    const suffix = randomUUID()
    const role = options.role ?? "SELLER"
    const withProfile = role === "SELLER" && options.withProfile !== false
    const user = await prisma.user.create({
        data: {
            name: `${name} user`,
            email: `${name}-${suffix}@example.test`,
            passwordHash: await bcrypt.hash(payoutTestPassword, 4),
            role,
            ...(withProfile
                ? {
                    sellerProfile: {
                        create: {
                            businessName: `${name} Shop`,
                            state: "Lagos",
                            lga: "Ikeja",
                            location: "Ikeja, Lagos",
                            logoUrl: "https://example.test/logo.png",
                            slug: `${name}-${suffix}`,
                            shippingPolicy: "FREE",
                            shippingCost: null
                        }
                    }
                }
                : {})
        },
        include: { sellerProfile: true }
    })
    const token = jwt.sign({ id: user.id }, jwtSecret)
    const fakes = installFakePaymentProviders()

    try {
        await withAppServer(async (baseUrl) => {
            await run({
                sellerProfileId: user.sellerProfile?.id ?? 0,
                fakes,
                async request(method, path, body) {
                    const response = await fetch(`${baseUrl}${path}`, {
                        method,
                        headers: {
                            cookie: `token=${token}`,
                            ...(body !== undefined ? { "content-type": "application/json" } : {})
                        },
                        body: body !== undefined ? JSON.stringify(body) : null
                    })
                    const text = await response.text()
                    return { status: response.status, body: text ? JSON.parse(text) : null, text }
                }
            })
        })
    } finally {
        setPaymentProvidersForTesting(null)
        await prisma.sellerPayoutAccount.deleteMany({ where: { sellerProfile: { userId: user.id } } })
        await prisma.sellerProfile.deleteMany({ where: { userId: user.id } })
        await prisma.user.delete({ where: { id: user.id } })
    }
}

test("lists payout banks supported by both providers to sellers only", async () => {
    await withPayoutSeller("payout-banks", async ({ request }) => {
        const response = await request("GET", "/seller/payout/banks")
        assert.equal(response.status, 200)
        assert.ok(Array.isArray(response.body) && response.body.length > 100)
        assert.deepEqual(response.body.find((bank: { id: string }) => bank.id === "opay"), { id: "opay", name: "OPay" })
        assert.doesNotMatch(response.text, /paystackCode|flutterwaveCode/)
    })

    await withPayoutSeller("payout-banks-consumer", async ({ request }) => {
        const response = await request("GET", "/seller/payout/banks")
        assert.equal(response.status, 403)
    }, { role: "CONSUMER" })
})

test("resolves a payout account name through Paystack and reports provider failures", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {})

    await withPayoutSeller("payout-resolve", async ({ request, fakes }) => {
        const resolved = await request("POST", "/seller/payout/resolve", { bankId: "opay", accountNumber: "0123456789" })
        assert.equal(resolved.status, 200)
        assert.deepEqual(resolved.body, { accountName: "ADA OKAFOR" })
        assert.deepEqual(fakes.calls.resolve, [
            { provider: "PAYSTACK", input: { bankCode: "999992", accountNumber: "0123456789" } }
        ])

        const shortNumber = await request("POST", "/seller/payout/resolve", { bankId: "opay", accountNumber: "12345" })
        assert.equal(shortNumber.status, 400)
        assert.equal(shortNumber.body.message, "Account number must be exactly 10 digits")

        const unknownBank = await request("POST", "/seller/payout/resolve", { bankId: "not-a-bank", accountNumber: "0123456789" })
        assert.equal(unknownBank.status, 400)
        assert.equal(unknownBank.body.message, "Choose a supported bank")
        assert.equal(fakes.calls.resolve.length, 1)

        fakes.behaviors.PAYSTACK.resolve = async () => {
            throw new PaymentProviderError("rejected", "Paystack rejected the request", "HTTP 422: Could not resolve account name")
        }
        const rejected = await request("POST", "/seller/payout/resolve", { bankId: "opay", accountNumber: "0123456789" })
        assert.equal(rejected.status, 400)
        assert.deepEqual(rejected.body, { message: "Account details are invalid", code: "PAYOUT_ACCOUNT_INVALID" })
        assert.equal(consoleError.mock.callCount(), 0)

        fakes.behaviors.PAYSTACK.resolve = async () => {
            throw new PaymentProviderError("unavailable", "Paystack could not be reached", "TimeoutError")
        }
        const unavailable = await request("POST", "/seller/payout/resolve", { bankId: "opay", accountNumber: "0123456789" })
        assert.equal(unavailable.status, 502)
        assert.equal(unavailable.body.code, "PAYOUT_PROVIDER_UNAVAILABLE")
        assert.equal(consoleError.mock.callCount(), 1)
    })
})

test("creates payout accounts on both providers and stores only the last four account digits", async () => {
    await withPayoutSeller("payout-create", async ({ request, fakes, sellerProfileId }) => {
        const created = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(created.status, 201)
        assert.deepEqual(
            created.body.accounts.map((account: { provider: string; status: string; bankName: string; accountName: string; accountNumberLast4: string }) =>
                [account.provider, account.status, account.bankName, account.accountName, account.accountNumberLast4]),
            [
                ["PAYSTACK", "ACTIVE", "OPay", "ADA OKAFOR", "6789"],
                ["FLUTTERWAVE", "ACTIVE", "OPay", "ADA OKAFOR", "6789"]
            ]
        )
        assert.doesNotMatch(created.text, /0123456789/)
        assert.doesNotMatch(created.text, /subaccountCode/)

        // Each provider receives its own code for the same bank.
        assert.deepEqual(
            fakes.calls.create.map(({ provider, input }) => [provider, input.bankCode, input.accountNumber, input.businessPhone]).sort(),
            [
                ["FLUTTERWAVE", "100004", "0123456789", "08012345678"],
                ["PAYSTACK", "999992", "0123456789", "08012345678"]
            ]
        )
        assert.ok(fakes.calls.create.every(({ input }) => input.businessName === "payout-create Shop" && input.businessEmail.endsWith("@example.test")))

        const accounts = await prisma.sellerPayoutAccount.findMany({ where: { sellerProfileId } })
        assert.equal(accounts.length, 2)
        assert.ok(accounts.every((account) => account.status === "ACTIVE" && account.subaccountCode?.startsWith(`${account.provider}-SUB-`)))
        assert.equal(accounts.find((account) => account.provider === "PAYSTACK")?.providerAccountId, null)
        assert.match(accounts.find((account) => account.provider === "FLUTTERWAVE")?.providerAccountId ?? "", /^\d+$/)
        assert.doesNotMatch(JSON.stringify(accounts), /0123456789/)

        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerProfileId } })
        assert.equal(profile.businessPhone, "08012345678")
        assert.equal(profile.payoutTermsVersion, payoutFeeTerms.version)
        assert.ok(profile.payoutTermsAcceptedAt instanceof Date)

        const listed = await request("GET", "/seller/payout/accounts")
        assert.equal(listed.status, 200)
        assert.deepEqual(listed.body.feeTerms, payoutFeeTerms)
        assert.equal(listed.body.acceptedFeeTermsVersion, payoutFeeTerms.version)
        assert.equal(listed.body.businessPhone, "08012345678")
        assert.deepEqual(listed.body.accounts.map((account: { provider: string; status: string }) => [account.provider, account.status]), [
            ["PAYSTACK", "ACTIVE"],
            ["FLUTTERWAVE", "ACTIVE"]
        ])

        const repeated = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(repeated.status, 409)
        assert.equal(repeated.body.code, "PAYOUT_ACCOUNTS_ACTIVE")
        assert.equal(fakes.calls.create.length, 2)
    })
})

test("records a partial provider failure and retries only the failed provider", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {})

    await withPayoutSeller("payout-partial", async ({ request, fakes, sellerProfileId }) => {
        fakes.behaviors.FLUTTERWAVE.create = async () => {
            throw new PaymentProviderError("rejected", "Flutterwave rejected the request", "HTTP 400: Account 0123456789 is invalid")
        }

        const partial = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(partial.status, 502)
        assert.equal(partial.body.code, "PAYOUT_SETUP_INCOMPLETE")
        assert.equal(partial.body.message, "Payout setup failed for Flutterwave. Try again.")
        assert.deepEqual(
            partial.body.accounts.map((account: { provider: string; status: string; failureReason: string | null }) =>
                [account.provider, account.status, account.failureReason]),
            [
                ["PAYSTACK", "ACTIVE", null],
                ["FLUTTERWAVE", "FAILED", "Flutterwave rejected these account details"]
            ]
        )
        assert.equal(consoleError.mock.callCount(), 1)
        assert.doesNotMatch(JSON.stringify(consoleError.mock.calls.map((call) => call.arguments)), /0123456789/)

        const paystackAccount = await prisma.sellerPayoutAccount.findUniqueOrThrow({
            where: { sellerProfileId_provider: { sellerProfileId, provider: "PAYSTACK" } }
        })

        delete fakes.behaviors.FLUTTERWAVE.create
        fakes.calls.create.length = 0

        const retried = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(retried.status, 201)
        assert.deepEqual(fakes.calls.create.map(({ provider }) => provider), ["FLUTTERWAVE"])
        assert.deepEqual(retried.body.accounts.map((account: { status: string }) => account.status), ["ACTIVE", "ACTIVE"])

        const paystackAfterRetry = await prisma.sellerPayoutAccount.findUniqueOrThrow({
            where: { sellerProfileId_provider: { sellerProfileId, provider: "PAYSTACK" } }
        })
        assert.equal(paystackAfterRetry.subaccountCode, paystackAccount.subaccountCode)
    })
})

test("refuses a payout retry with a different bank account than the active one", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPayoutSeller("payout-mismatch", async ({ request, fakes }) => {
        fakes.behaviors.FLUTTERWAVE.create = async () => {
            throw new PaymentProviderError("unavailable", "Flutterwave could not be reached", "TimeoutError")
        }
        const partial = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(partial.status, 502)
        assert.equal(partial.body.accounts[1].failureReason, "Flutterwave could not be reached. Try again.")

        delete fakes.behaviors.FLUTTERWAVE.create
        fakes.calls.create.length = 0

        const otherAccount = await request("POST", "/seller/payout/accounts", { ...validPayoutRequest, accountNumber: "0123450000" })
        assert.equal(otherAccount.status, 409)
        assert.equal(otherAccount.body.code, "PAYOUT_ACCOUNT_MISMATCH")

        const otherBank = await request("POST", "/seller/payout/accounts", { ...validPayoutRequest, bankId: "access-bank" })
        assert.equal(otherBank.status, 409)
        assert.equal(otherBank.body.code, "PAYOUT_ACCOUNT_MISMATCH")
        assert.equal(fakes.calls.create.length, 0)
    })
})

test("validates payout setup requests before calling any provider", async () => {
    await withPayoutSeller("payout-validate", async ({ request, fakes }) => {
        const cases: Array<[Record<string, unknown>, number, string]> = [
            [{ ...validPayoutRequest, acceptFeeTerms: undefined }, 400, "You must accept the payout fee terms"],
            [{ ...validPayoutRequest, feeTermsVersion: "2000-01-01" }, 409, "The payout fee terms have changed. Review them and try again."],
            [{ ...validPayoutRequest, businessPhone: "12345" }, 400, "Business phone must be a valid Nigerian mobile number"],
            [{ ...validPayoutRequest, bankId: "unknown-bank" }, 400, "Choose a supported bank"],
            [{ ...validPayoutRequest, accountNumber: "01234 56789" }, 400, "Account number must be exactly 10 digits"]
        ]

        for (const [body, status, message] of cases) {
            const response = await request("POST", "/seller/payout/accounts", body)
            assert.equal(response.status, status, message)
            assert.equal(response.body.message, message)
        }

        assert.equal(fakes.calls.resolve.length, 0)
        assert.equal(fakes.calls.create.length, 0)
    })

    await withPayoutSeller("payout-no-profile", async ({ request, fakes }) => {
        const response = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(response.status, 404)
        assert.equal(response.body.message, "Store profile not found")
        assert.equal(fakes.calls.create.length, 0)
    }, { withProfile: false })
})

test("refuses payout setup while another setup is in progress and recovers a stale one", async () => {
    await withPayoutSeller("payout-in-progress", async ({ request, fakes, sellerProfileId }) => {
        const pending = await prisma.sellerPayoutAccount.create({
            data: {
                sellerProfileId,
                provider: "FLUTTERWAVE",
                bankId: "opay",
                bankName: "OPay",
                accountName: "ADA OKAFOR",
                accountNumberLast4: "6789"
            }
        })

        const busy = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(busy.status, 409)
        assert.equal(busy.body.code, "PAYOUT_SETUP_IN_PROGRESS")
        assert.equal(fakes.calls.create.length, 0)

        await prisma.$executeRaw`
            UPDATE "SellerPayoutAccount" SET "updatedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '5 minutes' WHERE id = ${pending.id}
        `

        const recovered = await request("POST", "/seller/payout/accounts", validPayoutRequest)
        assert.equal(recovered.status, 201)
        assert.equal(fakes.calls.create.length, 2)
    })
})

test("lets only one of two concurrent payout setups call the providers", async () => {
    await withPayoutSeller("payout-concurrent", async ({ request, fakes }) => {
        for (const provider of ["PAYSTACK", "FLUTTERWAVE"] as const) {
            fakes.behaviors[provider].create = async () => {
                await new Promise((resolve) => setTimeout(resolve, 300))
                return fakeSubaccount(provider)
            }
        }

        const responses = await Promise.all([
            request("POST", "/seller/payout/accounts", validPayoutRequest),
            request("POST", "/seller/payout/accounts", validPayoutRequest)
        ])

        assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409])
        assert.equal(responses.find(({ status }) => status === 409)?.body.code, "PAYOUT_SETUP_IN_PROGRESS")
        assert.equal(fakes.calls.create.length, 2)
    })
})

async function setUpPayoutAccounts(context: PayoutTestContext) {
    const created = await context.request("POST", "/seller/payout/accounts", validPayoutRequest)
    assert.equal(created.status, 201)
    context.fakes.calls.create.length = 0
    return prisma.sellerPayoutAccount.findMany({
        where: { sellerProfileId: context.sellerProfileId },
        orderBy: { provider: "asc" }
    })
}

const changeBankRequest = { bankId: "access-bank", accountNumber: "9876543210", password: payoutTestPassword }

test("changes the payout bank account on both providers without creating new subaccounts", async () => {
    await withPayoutSeller("payout-change", async (context) => {
        const { request, fakes, sellerProfileId } = context
        const before = await setUpPayoutAccounts(context)
        fakes.behaviors.PAYSTACK.resolve = async () => ({ accountName: "ADA OKAFOR-BELLO" })

        const changed = await request("PUT", "/seller/payout/accounts", changeBankRequest)
        assert.equal(changed.status, 200)
        assert.deepEqual(
            changed.body.accounts.map((account: { provider: string; status: string; bankName: string; accountName: string; accountNumberLast4: string }) =>
                [account.provider, account.status, account.bankName, account.accountName, account.accountNumberLast4]),
            [
                ["PAYSTACK", "ACTIVE", "Access Bank", "ADA OKAFOR-BELLO", "3210"],
                ["FLUTTERWAVE", "ACTIVE", "Access Bank", "ADA OKAFOR-BELLO", "3210"]
            ]
        )
        assert.doesNotMatch(changed.text, /9876543210/)
        assert.equal(fakes.calls.create.length, 0)
        assert.deepEqual(
            fakes.calls.update.map(({ provider, subaccount, input }) =>
                [provider, subaccount.subaccountCode, subaccount.providerAccountId, input.bankCode, input.accountNumber]).sort(),
            before.map((account) => [account.provider, account.subaccountCode, account.providerAccountId, "044", "9876543210"]).sort()
        )

        const after = await prisma.sellerPayoutAccount.findMany({ where: { sellerProfileId }, orderBy: { provider: "asc" } })
        assert.deepEqual(after.map((account) => account.subaccountCode), before.map((account) => account.subaccountCode))
        assert.doesNotMatch(JSON.stringify(after), /9876543210/)

        const unchanged = await request("PUT", "/seller/payout/accounts", changeBankRequest)
        assert.equal(unchanged.status, 409)
        assert.equal(unchanged.body.code, "PAYOUT_ACCOUNT_UNCHANGED")
        assert.equal(fakes.calls.update.length, 2)
    })
})

test("requires the current password and completed setup to change the payout bank account", async () => {
    await withPayoutSeller("payout-change-guard", async (context) => {
        const { request, fakes } = context

        const notSetUp = await request("PUT", "/seller/payout/accounts", changeBankRequest)
        assert.equal(notSetUp.status, 409)
        assert.equal(notSetUp.body.code, "PAYOUT_ACCOUNTS_NOT_SET_UP")

        await setUpPayoutAccounts(context)

        const missingPassword = await request("PUT", "/seller/payout/accounts", { ...changeBankRequest, password: undefined })
        assert.equal(missingPassword.status, 400)
        assert.equal(missingPassword.body.message, "Enter your current password to change your bank account")

        const wrongPassword = await request("PUT", "/seller/payout/accounts", { ...changeBankRequest, password: "not-the-password" })
        assert.equal(wrongPassword.status, 403)
        assert.deepEqual(wrongPassword.body, { message: "Password is incorrect", code: "PAYOUT_PASSWORD_INCORRECT" })

        const invalidAccount = await request("PUT", "/seller/payout/accounts", { ...changeBankRequest, accountNumber: "98765" })
        assert.equal(invalidAccount.status, 400)

        assert.equal(fakes.calls.update.length, 0)
        assert.equal(fakes.calls.create.length, 0)
    })
})

test("keeps a failed bank change unusable and retries only the failed provider", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {})

    await withPayoutSeller("payout-change-partial", async (context) => {
        const { request, fakes, sellerProfileId } = context
        const before = await setUpPayoutAccounts(context)
        fakes.behaviors.FLUTTERWAVE.update = async () => {
            throw new PaymentProviderError("unavailable", "Flutterwave could not be reached", "HTTP 503: account 9876543210")
        }

        const partial = await request("PUT", "/seller/payout/accounts", changeBankRequest)
        assert.equal(partial.status, 502)
        assert.equal(partial.body.code, "PAYOUT_SETUP_INCOMPLETE")
        assert.equal(partial.body.message, "Changing your bank account failed for Flutterwave. Try again.")
        assert.deepEqual(
            partial.body.accounts.map((account: { provider: string; status: string; accountNumberLast4: string }) =>
                [account.provider, account.status, account.accountNumberLast4]),
            [["PAYSTACK", "ACTIVE", "3210"], ["FLUTTERWAVE", "FAILED", "3210"]]
        )
        assert.doesNotMatch(JSON.stringify(consoleError.mock.calls.map((call) => call.arguments)), /9876543210/)

        // The failed account keeps its subaccount code so the retry updates the same subaccount.
        const flutterwaveAccount = await prisma.sellerPayoutAccount.findUniqueOrThrow({
            where: { sellerProfileId_provider: { sellerProfileId, provider: "FLUTTERWAVE" } }
        })
        assert.equal(flutterwaveAccount.subaccountCode, before.find((account) => account.provider === "FLUTTERWAVE")?.subaccountCode)

        delete fakes.behaviors.FLUTTERWAVE.update
        fakes.calls.update.length = 0

        const retried = await request("PUT", "/seller/payout/accounts", changeBankRequest)
        assert.equal(retried.status, 200)
        assert.deepEqual(fakes.calls.update.map(({ provider }) => provider), ["FLUTTERWAVE"])
        assert.equal(fakes.calls.create.length, 0)
        assert.deepEqual(retried.body.accounts.map((account: { status: string }) => account.status), ["ACTIVE", "ACTIVE"])
    })
})

type PaymentTestContext = {
    fixture: CheckoutLifecycleFixture
    baseUrl: string
    checkoutId: number
    adminToken: string
    fakes: ReturnType<typeof installFakePaymentProviders>
    request(method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>
    startPayment(token?: string): Promise<{ status: number; body: any }>
}

// A consumer checkout of 2 × ₦1,500 (₦3,000, free shipping) from one seller who has an active
// payout account for each of payoutProviders (Paystack only by default), or none when
// withPayoutAccount is false.
async function withPaymentCheckout(
    name: string,
    run: (context: PaymentTestContext) => Promise<void>,
    options: { withPayoutAccount?: boolean; payoutProviders?: PaymentProvider[] } = {}
) {
    const fixture = await createCheckoutLifecycleFixture(name, 5, 2)
    const fakes = installFakePaymentProviders()
    const admin = await prisma.user.create({
        data: {
            name: `${name} admin`,
            email: `${name}-admin-${randomUUID()}@example.test`,
            passwordHash: "integration-test-not-a-password",
            role: "CONSUMER",
            isAdmin: true
        }
    })

    try {
        if (options.withPayoutAccount !== false) {
            const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })

            for (const provider of options.payoutProviders ?? ["PAYSTACK"]) {
                await prisma.sellerPayoutAccount.create({
                    data: {
                        sellerProfileId: profile.id,
                        provider,
                        status: "ACTIVE",
                        subaccountCode: provider === "PAYSTACK" ? `ACCT_test_${name}` : `RS_test_${name}`,
                        providerAccountId: provider === "FLUTTERWAVE" ? "1" : null,
                        bankId: "opay",
                        bankName: "OPay",
                        accountName: "TEST SELLER",
                        accountNumberLast4: "6789"
                    }
                })
            }
        }

        const checkoutId = await fixture.createCheckout()

        await withAppServer(async (baseUrl) => {
            const request: PaymentTestContext["request"] = async (method, path, body, token = fixture.token) => {
                const response = await fetch(`${baseUrl}${path}`, {
                    method,
                    headers: {
                        cookie: `token=${token}`,
                        ...(body !== undefined ? { "content-type": "application/json" } : {})
                    },
                    body: body !== undefined ? JSON.stringify(body) : null
                })
                const text = await response.text()
                return { status: response.status, body: text ? JSON.parse(text) : null }
            }

            await run({
                fixture,
                baseUrl,
                checkoutId,
                adminToken: jwt.sign({ id: admin.id }, process.env.JWT_SECRET!),
                fakes,
                request,
                startPayment: (token) => request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" }, token)
            })
        })
    } finally {
        setPaymentProvidersForTesting(null)
        await prisma.sellerPayoutAccount.deleteMany({ where: { sellerProfile: { userId: fixture.sellerId } } })
        await fixture.cleanup()
        await prisma.user.delete({ where: { id: admin.id } })
    }
}

function paystackVerification(
    outcome: "success" | "failed" | "pending",
    reference: string,
    overrides: Partial<{ amountKobo: number; currency: string; providerStatus: string }> = {}
): PaymentVerification {
    return {
        outcome,
        providerStatus: overrides.providerStatus ?? outcome,
        reference,
        amountKobo: overrides.amountKobo ?? 300000,
        currency: overrides.currency ?? "NGN",
        transactionId: "5550001"
    }
}

test("starts a Paystack payment with each seller's share and extends the checkout hold", async () => {
    await withPaymentCheckout("payment-start", async ({ checkoutId, fakes, startPayment }) => {
        const startedAt = Date.now()
        const started = await startPayment()
        assert.equal(started.status, 201)
        assert.equal(started.body.code, "PAYMENT_STARTED")
        const payment = started.body.payment
        assert.match(payment.reference, new RegExp(`^VND-${checkoutId}-[0-9a-f]{12}$`))
        assert.equal(payment.provider, "PAYSTACK")
        assert.equal(payment.status, "PENDING")
        assert.equal(payment.amount, "3000.00")
        assert.equal(payment.authorizationUrl, `https://checkout.example.test/${payment.reference}`)

        assert.equal(fakes.calls.initialize.length, 1)
        const initialization = fakes.calls.initialize[0]!.input
        assert.equal(initialization.reference, payment.reference)
        assert.equal(initialization.amountKobo, 300000)
        assert.deepEqual(initialization.splits, [{ subaccountCode: "ACCT_test_payment-start", amountKobo: 300000, retainedKobo: 0 }])
        assert.match(initialization.email, /payment-start-consumer-.*@example\.test/)
        assert.equal(initialization.callbackUrl, `${config.frontendUrl}/checkout/payment-return`)

        const checkout = await prisma.checkout.findUniqueOrThrow({
            where: { id: checkoutId },
            include: { inventoryReservations: true, paymentAttempts: true }
        })
        assert.equal(checkout.status, "PAYMENT_PENDING")
        assert.ok(checkout.expiresAt.getTime() >= startedAt + 29 * 60 * 1000)
        assert.ok(checkout.inventoryReservations.every((reservation) =>
            reservation.status === "ACTIVE" && reservation.expiresAt.getTime() === checkout.expiresAt.getTime()))
        assert.equal(checkout.paymentAttempts.length, 1)
        assert.equal(checkout.paymentAttempts[0]!.authorizationUrl, payment.authorizationUrl)

        const repeated = await startPayment()
        assert.equal(repeated.status, 200)
        assert.equal(repeated.body.code, "PAYMENT_REUSED")
        assert.equal(repeated.body.payment.reference, payment.reference)
        assert.equal(fakes.calls.initialize.length, 1)
    })
})

test("refuses payment while a seller has no active payout account for the provider", async () => {
    await withPaymentCheckout("payment-seller-not-ready", async ({ checkoutId, fakes, startPayment }) => {
        const response = await startPayment()
        assert.equal(response.status, 409)
        assert.equal(response.body.code, "PAYMENT_SELLER_NOT_READY")
        assert.deepEqual(response.body.sellers, ["payment-seller-not-ready Shop"])
        assert.equal(fakes.calls.initialize.length, 0)

        const checkout = await prisma.checkout.findUniqueOrThrow({ where: { id: checkoutId }, include: { paymentAttempts: true } })
        assert.equal(checkout.status, "PENDING")
        assert.equal(checkout.paymentAttempts.length, 0)
    }, { withPayoutAccount: false })
})

test("refuses payment for other consumers' checkouts, unavailable providers and invalid input", async () => {
    await withPaymentCheckout("payment-guards", async ({ fixture, checkoutId, fakes, request }) => {
        const other = await fixture.addConsumer(1)
        const otherConsumer = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" }, other.token)
        assert.equal(otherConsumer.status, 404)

        // This seller only has a Paystack payout account.
        const flutterwave = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "FLUTTERWAVE" })
        assert.equal(flutterwave.status, 409)
        assert.equal(flutterwave.body.code, "PAYMENT_SELLER_NOT_READY")

        const unknownProvider = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "CASH" })
        assert.equal(unknownProvider.status, 400)

        const badId = await request("POST", "/checkout/abc/payments", { provider: "PAYSTACK" })
        assert.equal(badId.status, 400)

        // Sellers can shop too, but not pay for someone else's checkout.
        const sellerToken = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" }, fixture.sellerToken)
        assert.equal(sellerToken.status, 404)
        assert.equal(fakes.calls.initialize.length, 0)
    })
})

test("refuses payment on an expired checkout", async () => {
    await withPaymentCheckout("payment-expired", async ({ checkoutId, fakes, startPayment }) => {
        await prisma.checkout.update({ where: { id: checkoutId }, data: { expiresAt: new Date(Date.now() - 1000) } })

        const response = await startPayment()
        assert.equal(response.status, 409)
        assert.equal(response.body.code, "CHECKOUT_EXPIRED")
        assert.equal(fakes.calls.initialize.length, 0)
    })
})

test("records a verified payment only when the reference, amount and currency match", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {})

    await withPaymentCheckout("payment-verify", async ({ checkoutId, fakes, request, startPayment }) => {
        const started = await startPayment()
        const reference = started.body.payment.reference as string

        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference, { amountKobo: 100 })
        const mismatched = await request("GET", `/payments/${reference}`)
        assert.equal(mismatched.status, 200)
        assert.equal(mismatched.body.payment.status, "PENDING")
        assert.equal(mismatched.body.payment.failureReason, "The payment details did not match and need review")
        assert.equal(consoleError.mock.callCount(), 1)

        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference, { currency: "USD" })
        assert.equal((await request("GET", `/payments/${reference}`)).body.payment.status, "PENDING")

        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)
        const verified = await request("GET", `/payments/${reference}`)
        assert.equal(verified.body.payment.status, "SUCCESS")
        assert.equal(verified.body.payment.failureReason, null)
        assert.equal(verified.body.payment.authorizationUrl, null)

        const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference } })
        assert.equal(attempt.providerTransactionId, "5550001")
        assert.equal(attempt.providerStatus, "success")
        assert.ok(attempt.verifiedAt instanceof Date)

        // A verified payment is settled straight away.
        assert.equal((await prisma.checkout.findUniqueOrThrow({ where: { id: checkoutId } })).status, "COMPLETED")

        fakes.calls.verify.length = 0
        const again = await request("GET", `/payments/${reference}`)
        assert.equal(again.body.payment.status, "SUCCESS")
        assert.equal(fakes.calls.verify.length, 0)

        const restart = await startPayment()
        assert.equal(restart.status, 409)
        assert.equal(restart.body.code, "PAYMENT_ALREADY_COMPLETED")
    })
})

test("records a failed payment and lets the consumer retry with a new reference", async () => {
    await withPaymentCheckout("payment-failed", async ({ fakes, request, startPayment }) => {
        const first = await startPayment()
        const firstReference = first.body.payment.reference as string

        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("pending", firstReference, { providerStatus: "abandoned" })
        const stillPending = await request("GET", `/payments/${firstReference}`)
        assert.equal(stillPending.body.payment.status, "PENDING")
        assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference: firstReference } })).providerStatus, "abandoned")

        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("failed", firstReference)
        const failed = await request("GET", `/payments/${firstReference}`)
        assert.equal(failed.body.payment.status, "FAILED")
        assert.equal(failed.body.payment.failureReason, "The payment was not completed")

        const retry = await startPayment()
        assert.equal(retry.status, 201)
        assert.notEqual(retry.body.payment.reference, firstReference)
        assert.equal(fakes.calls.initialize.length, 2)
    })
})

test("keeps a timed-out initialization pending and reconciles it before starting again", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("payment-timeout", async ({ checkoutId, fakes, startPayment }) => {
        fakes.behaviors.PAYSTACK.initialize = async () => {
            throw new PaymentProviderError("unavailable", "Paystack could not be reached", "TimeoutError")
        }

        const timedOut = await startPayment()
        assert.equal(timedOut.status, 502)
        assert.equal(timedOut.body.code, "PAYMENT_PROVIDER_UNAVAILABLE")
        const [attempt] = await prisma.paymentAttempt.findMany({ where: { checkoutId } })
        assert.equal(attempt?.status, "PENDING")
        assert.equal(attempt?.authorizationUrl, null)

        const tooSoon = await startPayment()
        assert.equal(tooSoon.status, 409)
        assert.equal(tooSoon.body.code, "PAYMENT_INITIALIZING")

        await prisma.$executeRaw`
            UPDATE "PaymentAttempt" SET "createdAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 minutes' WHERE id = ${attempt!.id}
        `
        delete fakes.behaviors.PAYSTACK.initialize
        fakes.behaviors.PAYSTACK.verify = async () => ({ outcome: "not_found" })

        const restarted = await startPayment()
        assert.equal(restarted.status, 201)
        assert.deepEqual(fakes.calls.verify.map(({ reference }) => reference), [attempt!.reference])

        const closed = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt!.id } })
        assert.equal(closed.status, "FAILED")
        assert.equal(closed.failureReason, "The payment was never started")
    })
})

test("closes an attempt the provider rejected and reports it", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("payment-rejected", async ({ checkoutId, fakes, startPayment }) => {
        fakes.behaviors.PAYSTACK.initialize = async () => {
            throw new PaymentProviderError("rejected", "Paystack rejected the request", "HTTP 400: Invalid split")
        }

        const rejected = await startPayment()
        assert.equal(rejected.status, 502)
        assert.equal(rejected.body.code, "PAYMENT_PROVIDER_REJECTED")
        const [attempt] = await prisma.paymentAttempt.findMany({ where: { checkoutId } })
        assert.equal(attempt?.status, "FAILED")
        assert.equal(attempt?.failureReason, "Paystack rejected the payment request")
    })
})

test("returns the saved payment status when the provider cannot be reached and hides other consumers' payments", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("payment-status", async ({ fixture, fakes, request, startPayment }) => {
        const started = await startPayment()
        const reference = started.body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => {
            throw new PaymentProviderError("unavailable", "Paystack could not be reached", "TimeoutError")
        }

        const status = await request("GET", `/payments/${reference}`)
        assert.equal(status.status, 200)
        assert.equal(status.body.payment.status, "PENDING")
        assert.equal(status.body.payment.authorizationUrl, started.body.payment.authorizationUrl)

        const other = await fixture.addConsumer(1)
        const hidden = await request("GET", `/payments/${reference}`, undefined, other.token)
        assert.equal(hidden.status, 404)
        assert.equal((await request("GET", "/payments/VND-unknown")).status, 404)
    })
})

async function loadSettlementState(fixture: CheckoutLifecycleFixture, checkoutId: number) {
    const checkout = await prisma.checkout.findUniqueOrThrow({
        where: { id: checkoutId },
        include: { inventoryReservations: true, orders: true }
    })
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
    const cartItem = await prisma.cartItem.findFirst({ where: { cart: { userId: fixture.consumerId }, listingId: fixture.listingId } })
    return {
        checkoutStatus: checkout.status,
        reservationStatuses: checkout.inventoryReservations.map(({ status }) => status),
        orderStatuses: checkout.orders.map(({ status }) => status),
        stockQuantity: listing.stockQuantity,
        cartQuantity: cartItem?.quantity ?? 0
    }
}

const settledState = {
    checkoutStatus: "COMPLETED",
    reservationStatuses: ["CONSUMED"],
    orderStatuses: ["PAID"],
    stockQuantity: 3
}

test("settles a verified payment once and removes only the paid quantity from the cart", async () => {
    await withPaymentCheckout("settle-status", async ({ fixture, checkoutId, fakes, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        // The consumer adds one more of the same item after checking out.
        await prisma.cartItem.updateMany({
            where: { cart: { userId: fixture.consumerId }, listingId: fixture.listingId },
            data: { quantity: 3 }
        })
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)

        const status = await request("GET", `/payments/${reference}`)
        assert.equal(status.body.payment.status, "SUCCESS")
        assert.equal(status.body.payment.checkout.status, "COMPLETED")
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 1 })

        const again = await request("GET", `/payments/${reference}`)
        assert.equal(again.body.payment.checkout.status, "COMPLETED")
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 1 })
    })
})

function paystackWebhookBody(reference: string, event = "charge.success", eventId = 987654) {
    return JSON.stringify({ event, data: { id: eventId, reference, status: "success", amount: 300000, currency: "NGN" } })
}

async function postPaystackWebhook(baseUrl: string, body: string, signature = signPaystackWebhook(body)) {
    const response = await fetch(`${baseUrl}/payments/webhooks/paystack`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-paystack-signature": signature },
        body
    })
    return { status: response.status, body: await response.json() as { message?: string } }
}

function signPaystackWebhook(body: string) {
    const secret = process.env.PAYSTACK_SECRET_KEY
    assert.ok(secret, "PAYSTACK_SECRET_KEY must be set for webhook signature tests")
    return createHmac("sha512", secret).update(body).digest("hex")
}

test("settles a payment from a signed Paystack webhook exactly once", async (t) => {
    process.env.PAYSTACK_SECRET_KEY ||= "sk_test_integration_webhook_secret"
    const consoleWarn = t.mock.method(console, "warn", () => {})

    await withPaymentCheckout("settle-webhook", async ({ fixture, checkoutId, fakes, baseUrl, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)
        const body = paystackWebhookBody(reference)

        const forged = await postPaystackWebhook(baseUrl, body, "0".repeat(128))
        assert.equal(forged.status, 401)
        assert.equal(consoleWarn.mock.callCount(), 1)
        assert.equal(fakes.calls.verify.length, 0)
        assert.equal(await prisma.paymentEvent.count({ where: { reference } }), 0)

        const delivered = await postPaystackWebhook(baseUrl, body)
        assert.equal(delivered.status, 200)
        assert.equal(delivered.body.message, "Event received")
        assert.equal(fakes.calls.verify.length, 1)
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 0 })

        const event = await prisma.paymentEvent.findFirstOrThrow({ where: { reference } })
        assert.equal(event.eventKey, "charge.success:987654")
        assert.ok(event.processedAt instanceof Date)

        const redelivered = await postPaystackWebhook(baseUrl, body)
        assert.equal(redelivered.status, 200)
        assert.equal(redelivered.body.message, "Event already processed")
        assert.equal(fakes.calls.verify.length, 1)
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 0 })

        const otherEvent = await postPaystackWebhook(baseUrl, paystackWebhookBody(reference, "transfer.success", 111))
        assert.equal(otherEvent.body.message, "Event ignored")

        const notJson = "not json"
        const malformed = await postPaystackWebhook(baseUrl, notJson)
        assert.equal(malformed.status, 400)
    })

    await prisma.paymentEvent.deleteMany({ where: { eventKey: "charge.success:987654" } })
})

test("asks Paystack to redeliver a webhook when verification fails, then settles", async (t) => {
    process.env.PAYSTACK_SECRET_KEY ||= "sk_test_integration_webhook_secret"
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("settle-webhook-retry", async ({ fixture, checkoutId, fakes, baseUrl, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        const body = paystackWebhookBody(reference, "charge.success", 987655)
        fakes.behaviors.PAYSTACK.verify = async () => {
            throw new PaymentProviderError("unavailable", "Paystack could not be reached", "TimeoutError")
        }

        const failed = await postPaystackWebhook(baseUrl, body)
        assert.equal(failed.status, 500)
        assert.equal((await prisma.paymentEvent.findFirstOrThrow({ where: { reference } })).processedAt, null)
        assert.equal((await loadSettlementState(fixture, checkoutId)).checkoutStatus, "PAYMENT_PENDING")

        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)
        const redelivered = await postPaystackWebhook(baseUrl, body)
        assert.equal(redelivered.status, 200)
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 0 })
    })

    await prisma.paymentEvent.deleteMany({ where: { eventKey: "charge.success:987655" } })
})

test("settles once when a webhook and a status check arrive together", async () => {
    process.env.PAYSTACK_SECRET_KEY ||= "sk_test_integration_webhook_secret"

    await withPaymentCheckout("settle-concurrent", async ({ fixture, checkoutId, fakes, baseUrl, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)

        const [webhook, status] = await Promise.all([
            postPaystackWebhook(baseUrl, paystackWebhookBody(reference, "charge.success", 987656)),
            request("GET", `/payments/${reference}`)
        ])
        assert.equal(webhook.status, 200)
        assert.equal(status.status, 200)
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 0 })
    })

    await prisma.paymentEvent.deleteMany({ where: { eventKey: "charge.success:987656" } })
})

test("settles a verified payment that arrives after the checkout expired while stock was protected", async () => {
    await withPaymentCheckout("settle-late", async ({ fixture, checkoutId, fakes, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        await prisma.checkout.update({ where: { id: checkoutId }, data: { status: "EXPIRED", expiresAt: new Date(Date.now() - 1000) } })
        await prisma.inventoryReservation.updateMany({ where: { checkoutId }, data: { status: "PROTECTED" } })
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)

        const status = await request("GET", `/payments/${reference}`)
        assert.equal(status.body.payment.status, "SUCCESS")
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 0 })
    })
})

test("does not settle a verified payment whose stock is no longer held and flags it for review", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {})

    await withPaymentCheckout("settle-review", async ({ fixture, checkoutId, fakes, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        await prisma.inventoryReservation.updateMany({ where: { checkoutId }, data: { status: "RELEASED" } })
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)

        const status = await request("GET", `/payments/${reference}`)
        assert.equal(status.body.payment.status, "SUCCESS")
        assert.equal(status.body.payment.checkout.status, "PAYMENT_PENDING")
        const state = await loadSettlementState(fixture, checkoutId)
        assert.equal(state.stockQuantity, 5)
        assert.deepEqual(state.orderStatuses, ["PENDING_PAYMENT"])
        assert.equal(state.cartQuantity, 2)
        assert.ok(consoleError.mock.calls.some((call) => call.arguments[0] === "Payment settlement needs review"))
    })
})

async function backdatePaymentAttempt(reference: string, minutes: number) {
    await prisma.$executeRaw`
        UPDATE "PaymentAttempt"
        SET "createdAt" = (NOW() AT TIME ZONE 'UTC') - make_interval(mins => ${minutes}::integer)
        WHERE reference = ${reference}
    `
}

async function expireCheckoutAt(checkoutId: number, minutesAgo: number) {
    const expiresAt = new Date(Date.now() - minutesAgo * 60 * 1000)
    await prisma.checkout.update({ where: { id: checkoutId }, data: { expiresAt } })
    await prisma.inventoryReservation.updateMany({ where: { checkoutId }, data: { expiresAt } })
}

test("the stuck-payment checker settles old pending payments and skips recent ones", async () => {
    await withPaymentCheckout("checker-settle", async ({ fixture, checkoutId, fakes, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)

        await checkStuckPayments()
        assert.equal(fakes.calls.verify.filter((call) => call.reference === reference).length, 0)

        await backdatePaymentAttempt(reference, 15)
        await checkStuckPayments()
        assert.equal(fakes.calls.verify.filter((call) => call.reference === reference).length, 1)
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 0 })

        // A payment checked moments ago is not checked again.
        await checkStuckPayments()
        assert.equal(fakes.calls.verify.filter((call) => call.reference === reference).length, 1)
    })
})

test("closes a payment abandoned 30 minutes after its checkout expired and releases the stock", async () => {
    await withPaymentCheckout("checker-abandoned", async ({ fixture, checkoutId, fakes, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("pending", reference, { providerStatus: "abandoned" })

        await expireCheckoutAt(checkoutId, 5)
        const recent = await request("GET", `/payments/${reference}`)
        assert.equal(recent.body.payment.status, "PENDING")

        await expireCheckoutAt(checkoutId, 31)
        const closed = await request("GET", `/payments/${reference}`)
        assert.equal(closed.body.payment.status, "FAILED")
        assert.equal(closed.body.payment.failureReason, "The payment was not completed in time")

        const state = await loadSettlementState(fixture, checkoutId)
        assert.equal(state.checkoutStatus, "EXPIRED")
        assert.deepEqual(state.reservationStatuses, ["EXPIRED"])
        assert.deepEqual(state.orderStatuses, ["CANCELLED"])
        assert.equal(state.stockQuantity, 5)
    })
})

test("a verified failure after expiry releases the stock and does not reopen the checkout", async () => {
    await withPaymentCheckout("checker-failed-late", async ({ fixture, checkoutId, fakes, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        await expireCheckoutAt(checkoutId, 1)
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("failed", reference)

        const failed = await request("GET", `/payments/${reference}`)
        assert.equal(failed.body.payment.status, "FAILED")
        assert.equal(failed.body.payment.checkout.status, "EXPIRED")

        const state = await loadSettlementState(fixture, checkoutId)
        assert.deepEqual(state.reservationStatuses, ["EXPIRED"])
        assert.deepEqual(state.orderStatuses, ["CANCELLED"])

        const retry = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" })
        assert.equal(retry.status, 409)
        assert.equal(retry.body.code, "CHECKOUT_EXPIRED")
    })
})

test("opens one recovery case for a verified payment that cannot be settled", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {})

    await withPaymentCheckout("checker-recovery", async ({ checkoutId, fakes, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        await prisma.inventoryReservation.updateMany({ where: { checkoutId }, data: { status: "RELEASED" } })
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)

        await request("GET", `/payments/${reference}`)
        await request("GET", `/payments/${reference}`)
        await backdatePaymentAttempt(reference, 15)
        await prisma.paymentAttempt.update({ where: { reference }, data: { lastCheckedAt: null } })
        await checkStuckPayments()

        const cases = await prisma.paymentRecoveryCase.findMany({ where: { paymentAttempt: { reference } } })
        assert.equal(cases.length, 1)
        assert.equal(cases[0]!.status, "OPEN")
        assert.match(cases[0]!.reason, /stock is no longer held/)
        assert.equal(
            consoleError.mock.calls.filter((call) => call.arguments[0] === "Payment settlement needs review").length,
            1
        )
    })
})

const bothProviders: PaymentProvider[] = ["PAYSTACK", "FLUTTERWAVE"]

function flutterwaveVerification(
    outcome: "success" | "failed" | "pending",
    reference: string,
    providerStatus = outcome === "success" ? "successful" : outcome
): PaymentVerification {
    return { outcome, providerStatus, reference, amountKobo: 300000, currency: "NGN", transactionId: "8880001" }
}

async function postFlutterwaveWebhook(baseUrl: string, body: string, hash: string | null) {
    const response = await fetch(`${baseUrl}/payments/webhooks/flutterwave`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(hash !== null ? { "verif-hash": hash } : {}) },
        body
    })
    return { status: response.status, body: await response.json() as { message?: string } }
}

function flutterwaveWebhookBody(reference: string, eventId: number, status = "successful") {
    return JSON.stringify({ event: "charge.completed", data: { id: eventId, tx_ref: reference, status, amount: 3000, currency: "NGN" } })
}

test("starts a Flutterwave payment and refuses a second provider while one is pending", async () => {
    await withPaymentCheckout("flutterwave-start", async ({ checkoutId, fakes, request }) => {
        const started = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "FLUTTERWAVE" })
        assert.equal(started.status, 201)
        assert.equal(started.body.payment.provider, "FLUTTERWAVE")
        assert.deepEqual(fakes.calls.initialize.map(({ provider }) => provider), ["FLUTTERWAVE"])
        assert.deepEqual(fakes.calls.initialize[0]!.input.splits, [{ subaccountCode: "RS_test_flutterwave-start", amountKobo: 300000, retainedKobo: 0 }])

        const otherProvider = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" })
        assert.equal(otherProvider.status, 409)
        assert.equal(otherProvider.body.code, "PAYMENT_IN_PROGRESS")
        assert.equal(otherProvider.body.message, "A Flutterwave payment is already in progress for this checkout")
    }, { payoutProviders: bothProviders })
})

test("settles a Flutterwave payment from a webhook with the right secret hash", async (t) => {
    process.env.FLUTTERWAVE_WEBHOOK_SECRET ||= "integration-flutterwave-hash"
    t.mock.method(console, "warn", () => {})

    await withPaymentCheckout("flutterwave-webhook", async ({ fixture, checkoutId, fakes, baseUrl, request }) => {
        const reference = (await request("POST", `/checkout/${checkoutId}/payments`, { provider: "FLUTTERWAVE" })).body.payment.reference as string
        fakes.behaviors.FLUTTERWAVE.verify = async () => flutterwaveVerification("success", reference)
        const body = flutterwaveWebhookBody(reference, 777001)

        assert.equal((await postFlutterwaveWebhook(baseUrl, body, null)).status, 401)
        assert.equal((await postFlutterwaveWebhook(baseUrl, body, "wrong-hash")).status, 401)
        assert.equal(fakes.calls.verify.length, 0)

        const delivered = await postFlutterwaveWebhook(baseUrl, body, process.env.FLUTTERWAVE_WEBHOOK_SECRET!)
        assert.equal(delivered.status, 200)
        assert.equal(delivered.body.message, "Event received")
        assert.deepEqual(await loadSettlementState(fixture, checkoutId), { ...settledState, cartQuantity: 0 })
    }, { payoutProviders: bothProviders })

    await prisma.paymentEvent.deleteMany({ where: { provider: "FLUTTERWAVE", eventKey: "charge.completed:777001" } })
})

test("records a failed Flutterwave payment reported by webhook and lets the consumer retry", async () => {
    process.env.FLUTTERWAVE_WEBHOOK_SECRET ||= "integration-flutterwave-hash"

    await withPaymentCheckout("flutterwave-failed", async ({ fixture, checkoutId, fakes, baseUrl, request }) => {
        const reference = (await request("POST", `/checkout/${checkoutId}/payments`, { provider: "FLUTTERWAVE" })).body.payment.reference as string
        fakes.behaviors.FLUTTERWAVE.verify = async () => flutterwaveVerification("failed", reference)

        const delivered = await postFlutterwaveWebhook(baseUrl, flutterwaveWebhookBody(reference, 777002, "failed"), process.env.FLUTTERWAVE_WEBHOOK_SECRET!)
        assert.equal(delivered.status, 200)
        assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference } })).status, "FAILED")
        assert.equal((await loadSettlementState(fixture, checkoutId)).checkoutStatus, "PAYMENT_PENDING")

        const retry = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" })
        assert.equal(retry.status, 201)
    }, { payoutProviders: bothProviders })

    await prisma.paymentEvent.deleteMany({ where: { provider: "FLUTTERWAVE", eventKey: "charge.completed:777002" } })
})

test("closes a Flutterwave payment that was never paid 30 minutes after its checkout expired", async () => {
    await withPaymentCheckout("flutterwave-unpaid", async ({ fixture, checkoutId, fakes, request }) => {
        const reference = (await request("POST", `/checkout/${checkoutId}/payments`, { provider: "FLUTTERWAVE" })).body.payment.reference as string
        fakes.behaviors.FLUTTERWAVE.verify = async () => ({ outcome: "not_found" })

        assert.equal((await request("GET", `/payments/${reference}`)).body.payment.status, "PENDING")

        await expireCheckoutAt(checkoutId, 31)
        const closed = await request("GET", `/payments/${reference}`)
        assert.equal(closed.body.payment.status, "FAILED")
        assert.equal(closed.body.payment.failureReason, "The payment was not completed in time")
        assert.deepEqual((await loadSettlementState(fixture, checkoutId)).reservationStatuses, ["EXPIRED"])
    }, { payoutProviders: bothProviders })
})

test("the real adapters send each provider its own amount format and split", async (t) => {
    process.env.PAYSTACK_SECRET_KEY ||= "sk_test_integration"
    process.env.FLUTTERWAVE_SECRET_KEY ||= "FLWSECK_TEST-integration"
    const requests: Array<{ url: string; body: any }> = []
    let nextResponse: unknown = {}
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(JSON.stringify(nextResponse), { status: 200, headers: { "content-type": "application/json" } })
    })
    const initialization = {
        reference: "VND-1-abc",
        amountKobo: 3000000,
        email: "buyer@example.test",
        callbackUrl: "http://localhost:5173/checkout/payment-return",
        splits: [{ subaccountCode: "SUB_A", amountKobo: 2000000, retainedKobo: 0 }, { subaccountCode: "SUB_B", amountKobo: 1000000, retainedKobo: 0 }]
    }

    nextResponse = { status: true, data: { authorization_url: "https://checkout.paystack.com/x" } }
    await paystackAdapter.initializePayment(initialization)
    assert.equal(requests[0]!.url, "https://api.paystack.co/transaction/initialize")
    assert.equal(requests[0]!.body.amount, 3000000)
    assert.deepEqual(requests[0]!.body.split, {
        type: "flat",
        bearer_type: "all-proportional",
        subaccounts: [{ subaccount: "SUB_A", share: 2000000 }, { subaccount: "SUB_B", share: 1000000 }]
    })

    nextResponse = { status: "success", data: { link: "https://checkout.flutterwave.com/x" } }
    const flutterwave = await flutterwaveAdapter.initializePayment(initialization)
    assert.equal(flutterwave.authorizationUrl, "https://checkout.flutterwave.com/x")
    assert.equal(requests[1]!.url, "https://api.flutterwave.com/v3/payments")
    assert.equal(requests[1]!.body.amount, 30000)
    assert.equal(requests[1]!.body.tx_ref, "VND-1-abc")
    assert.equal(requests[1]!.body.redirect_url, initialization.callbackUrl)
    assert.deepEqual(requests[1]!.body.subaccounts, [
        { id: "SUB_A", transaction_split_ratio: 2, transaction_charge_type: "flat", transaction_charge: 0 },
        { id: "SUB_B", transaction_split_ratio: 1, transaction_charge_type: "flat", transaction_charge: 0 }
    ])

    nextResponse = { status: "success", data: { id: 42, tx_ref: "VND-1-abc", status: "successful", amount: 30000.5, currency: "NGN" } }
    assert.deepEqual(await flutterwaveAdapter.verifyPayment("VND-1-abc"), {
        outcome: "success",
        providerStatus: "successful",
        reference: "VND-1-abc",
        amountKobo: 3000050,
        currency: "NGN",
        transactionId: "42",
        sellerShares: null,
        vendlyShareKobo: null
    })
    assert.equal(requests[2]!.url, "https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=VND-1-abc")
})

test("records each seller's provider fee and payout on their order when a payment settles", async () => {
    await withPaymentCheckout("order-fees-paystack", async ({ checkoutId, fakes, request, startPayment }) => {
        const reference = (await startPayment()).body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => ({
            ...paystackVerification("success", reference),
            sellerShares: [{ subaccountCode: "ACCT_test_order-fees-paystack", receivedKobo: 294500, feeKobo: 5500 }]
        })

        await request("GET", `/payments/${reference}`)
        const [order] = await prisma.order.findMany({ where: { checkoutId } })
        assert.equal(order?.providerFee?.toFixed(2), "55.00")
        assert.equal(order?.sellerReceives?.toFixed(2), "2945.00")
    })

    // Flutterwave reports only the payout, so the fee is the order total minus the payout.
    await withPaymentCheckout("order-fees-flutterwave", async ({ checkoutId, fakes, request }) => {
        const reference = (await request("POST", `/checkout/${checkoutId}/payments`, { provider: "FLUTTERWAVE" })).body.payment.reference as string
        fakes.behaviors.FLUTTERWAVE.verify = async () => ({
            ...flutterwaveVerification("success", reference),
            sellerShares: [{ subaccountCode: "RS_test_order-fees-flutterwave", receivedKobo: 295800, feeKobo: null }]
        })

        await request("GET", `/payments/${reference}`)
        const [order] = await prisma.order.findMany({ where: { checkoutId } })
        assert.equal(order?.providerFee?.toFixed(2), "42.00")
        assert.equal(order?.sellerReceives?.toFixed(2), "2958.00")
    }, { payoutProviders: bothProviders })
})

test("shows customers their paid orders only", async () => {
    await withPaymentCheckout("order-history", async ({ fixture, checkoutId, fakes, request, startPayment }) => {
        const beforePayment = await request("GET", "/orders")
        assert.equal(beforePayment.status, 200)
        assert.equal(beforePayment.body.total, 0)
        assert.equal((await request("GET", `/orders/${checkoutId}`)).status, 404)

        const reference = (await startPayment()).body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)
        await request("GET", `/payments/${reference}`)

        const history = await request("GET", "/orders")
        assert.equal(history.body.total, 1)
        const [summary] = history.body.orders
        assert.equal(summary.id, checkoutId)
        assert.equal(summary.status, "COMPLETED")
        assert.equal(summary.total, "3000.00")
        assert.equal(summary.payment.reference, reference)
        assert.equal(summary.payment.provider, "PAYSTACK")
        assert.deepEqual(summary.sellerOrders.map((order: { status: string; itemCount: number; seller: { businessName: string } }) =>
            [order.status, order.itemCount, order.seller.businessName]), [["PAID", 2, "order-history Shop"]])
        assert.deepEqual(summary.sellerOrders[0].items.map((item: { title: string; quantity: number; unitPrice: string; lineTotal: string }) =>
            [item.title, item.quantity, item.unitPrice, item.lineTotal]), [["order-history listing", 2, "1500.00", "3000.00"]])

        const detail = await request("GET", `/orders/${checkoutId}`)
        assert.equal(detail.status, 200)
        assert.equal(detail.body.delivery.address, "1 Test Street")
        assert.deepEqual(detail.body.sellerOrders[0].items.map((item: { title: string; quantity: number; unitPrice: string }) =>
            [item.title, item.quantity, item.unitPrice]), [["order-history listing", 2, "1500.00"]])

        const other = await fixture.addConsumer(1)
        assert.equal((await request("GET", `/orders/${checkoutId}`, undefined, other.token)).status, 404)
        assert.equal((await request("GET", "/orders", undefined, other.token)).body.total, 0)
        assert.equal((await request("GET", "/orders?page=0")).status, 400)
        assert.equal((await request("GET", "/orders", undefined, fixture.sellerToken)).body.total, 0)
    })
})

test("shows sellers their paid orders with fees and the buyer's delivery details", async () => {
    await withPaymentCheckout("seller-orders", async ({ fixture, checkoutId, fakes, request, startPayment }) => {
        const [order] = await prisma.order.findMany({ where: { checkoutId } })
        assert.equal((await request("GET", "/seller/orders", undefined, fixture.sellerToken)).body.total, 0)
        assert.equal((await request("GET", `/seller/orders/${order!.id}`, undefined, fixture.sellerToken)).status, 404)

        const reference = (await startPayment()).body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => ({
            ...paystackVerification("success", reference),
            sellerShares: [{ subaccountCode: "ACCT_test_seller-orders", receivedKobo: 294500, feeKobo: 5500 }]
        })
        await request("GET", `/payments/${reference}`)

        const list = await request("GET", "/seller/orders", undefined, fixture.sellerToken)
        assert.equal(list.status, 200)
        assert.equal(list.body.total, 1)
        const [summary] = list.body.orders
        assert.equal(summary.id, order!.id)
        assert.equal(summary.status, "PAID")
        assert.equal(summary.provider, "PAYSTACK")
        assert.equal(summary.total, "3000.00")
        assert.equal(summary.providerFee, "55.00")
        assert.equal(summary.sellerReceives, "2945.00")
        assert.equal(summary.delivery.fullName, "Test Consumer")
        assert.equal(summary.delivery.phone, "08000000000")
        assert.ok(summary.delivery.address)
        assert.equal(summary.itemCount, 2)
        assert.equal(summary.items[0].quantity, 2)
        assert.ok(summary.items[0].title)
        assert.ok(summary.paidAt)

        const detail = await request("GET", `/seller/orders/${order!.id}`, undefined, fixture.sellerToken)
        assert.equal(detail.status, 200)
        assert.equal(detail.body.delivery.phone, "08000000000")
        assert.equal(detail.body.items[0].quantity, 2)

        assert.equal((await request("GET", "/seller/orders?status=SHIPPED", undefined, fixture.sellerToken)).body.total, 0)
        assert.equal((await request("GET", "/seller/orders?status=PAID", undefined, fixture.sellerToken)).body.total, 1)
        assert.equal((await request("GET", "/seller/orders?status=PENDING_PAYMENT", undefined, fixture.sellerToken)).status, 400)
        assert.equal((await request("GET", "/seller/orders")).status, 403)
    })
})

test("the real adapters read each seller's payout from the provider's verification", async (t) => {
    process.env.PAYSTACK_SECRET_KEY ||= "sk_test_integration"
    process.env.FLUTTERWAVE_SECRET_KEY ||= "FLWSECK_TEST-integration"
    let nextResponse: unknown = {}
    t.mock.method(globalThis, "fetch", async () =>
        new Response(JSON.stringify(nextResponse), { status: 200, headers: { "content-type": "application/json" } }))

    nextResponse = {
        status: true,
        data: {
            id: 1, reference: "VND-2-abc", status: "success", amount: 3000000, currency: "NGN",
            split: { shares: { subaccounts: [
                { subaccount_code: "ACCT_A", amount: 1963333, fees: 36667 },
                { subaccount_code: "ACCT_B", amount: 981667, fees: 18333 }
            ] } }
        }
    }
    const paystack = await paystackAdapter.verifyPayment("VND-2-abc")
    assert.ok(paystack.outcome !== "not_found")
    assert.deepEqual(paystack.sellerShares, [
        { subaccountCode: "ACCT_A", receivedKobo: 1963333, feeKobo: 36667 },
        { subaccountCode: "ACCT_B", receivedKobo: 981667, feeKobo: 18333 }
    ])

    nextResponse = {
        status: "success",
        data: {
            id: 2, tx_ref: "VND-2-abc", status: "successful", amount: 30000, currency: "NGN",
            meta: { split_settlement_info: JSON.stringify({
                RS_A: { merchant_commission: 0, subaccount_earning: 19720 },
                total_merchant_commission: 0,
                RS_B: { merchant_commission: 0, subaccount_earning: 9860 }
            }) }
        }
    }
    const flutterwave = await flutterwaveAdapter.verifyPayment("VND-2-abc")
    assert.ok(flutterwave.outcome !== "not_found")
    assert.deepEqual(flutterwave.sellerShares, [
        { subaccountCode: "RS_A", receivedKobo: 1972000, feeKobo: null, retainedKobo: 0 },
        { subaccountCode: "RS_B", receivedKobo: 986000, feeKobo: null, retainedKobo: 0 }
    ])
    assert.equal(flutterwave.vendlyShareKobo, 0)
})

// Pays for the fixture's checkout through the fake provider and returns the seller order's ID.
async function payForCheckout({ checkoutId, fakes, request, startPayment }: PaymentTestContext) {
    const reference = (await startPayment()).body.payment.reference as string
    fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)
    await request("GET", `/payments/${reference}`)
    const [order] = await prisma.order.findMany({ where: { checkoutId } })
    assert.equal(order?.status, "PAID")
    return order!.id
}

test("a seller can ship a paid order with a note, once, and only their own order", async () => {
    await withPaymentCheckout("fulfil-ship", async (context) => {
        const { fixture, checkoutId, request } = context
        const [unpaid] = await prisma.order.findMany({ where: { checkoutId } })
        assert.equal((await request("POST", `/seller/orders/${unpaid!.id}/ship`, {}, fixture.sellerToken)).status, 404)

        const orderId = await payForCheckout(context)
        const ship = (body: unknown = {}, token = fixture.sellerToken) => request("POST", `/seller/orders/${orderId}/ship`, body, token)

        assert.equal((await ship({ note: "x".repeat(201) })).status, 400)
        assert.equal((await ship({ note: 42 })).status, 400)
        assert.equal((await ship({}, fixture.token)).status, 403)

        const stranger = await prisma.user.create({
            data: { name: "Other seller", email: `fulfil-ship-stranger-${randomUUID()}@example.test`, passwordHash: "integration-test-not-a-password", role: "SELLER" }
        })
        try {
            const strangerToken = jwt.sign({ id: stranger.id }, process.env.JWT_SECRET!)
            assert.equal((await ship({}, strangerToken)).status, 404)
        } finally {
            await prisma.user.delete({ where: { id: stranger.id } })
        }

        const shipped = await ship({ note: "  GIG Logistics, tracking 12345  " })
        assert.equal(shipped.status, 200)
        assert.equal(shipped.body.status, "SHIPPED")
        assert.equal(shipped.body.shippingNote, "GIG Logistics, tracking 12345")
        assert.ok(shipped.body.shippedAt)
        assert.equal(shipped.body.deliveryReportedAt, null)

        const again = await ship({ note: "a different note" })
        assert.equal(again.status, 200)
        assert.equal(again.body.shippingNote, "GIG Logistics, tracking 12345")
        assert.equal(again.body.shippedAt, shipped.body.shippedAt)
    })
})

test("a seller's delivered report is not final: the buyer is asked to confirm and only their confirmation delivers the order", async () => {
    await withPaymentCheckout("fulfil-confirm", async (context) => {
        const { fixture, checkoutId, request } = context
        const orderId = await payForCheckout(context)
        const confirmPath = `/orders/${checkoutId}/seller-orders/${orderId}/confirm-delivery`
        const awaiting = async () => (await request("GET", "/orders/awaiting-confirmation")).body.count as number

        assert.equal(await awaiting(), 0)

        const tooEarly = await request("POST", confirmPath)
        assert.equal(tooEarly.status, 409)
        assert.equal(tooEarly.body.code, "ORDER_STATUS_INVALID")

        await request("POST", `/seller/orders/${orderId}/ship`, {}, fixture.sellerToken)
        const notReported = await request("POST", confirmPath)
        assert.equal(notReported.status, 409)
        assert.equal(notReported.body.code, "DELIVERY_NOT_REPORTED")

        const reported = await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        assert.equal(reported.status, 200)
        assert.equal(reported.body.status, "SHIPPED")
        assert.ok(reported.body.deliveryReportedAt)
        assert.equal(reported.body.deliveryConfirmedAt, null)

        assert.equal(await awaiting(), 1)
        const list = await request("GET", "/orders")
        assert.ok(list.body.orders[0].sellerOrders[0].deliveryReportedAt)
        assert.equal(list.body.orders[0].sellerOrders[0].status, "SHIPPED")

        assert.equal((await request("POST", confirmPath, undefined, fixture.sellerToken)).status, 404)
        const other = await fixture.addConsumer(1)
        assert.equal((await request("POST", confirmPath, undefined, other.token)).status, 404)
        assert.equal((await request("POST", `/orders/${checkoutId + 1000}/seller-orders/${orderId}/confirm-delivery`)).status, 404)
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status, "SHIPPED")

        const confirmed = await request("POST", confirmPath)
        assert.equal(confirmed.status, 200)
        assert.equal(confirmed.body.sellerOrders[0].status, "DELIVERED")
        assert.ok(confirmed.body.sellerOrders[0].deliveryConfirmedAt)
        assert.equal(await awaiting(), 0)

        const repeated = await request("POST", confirmPath)
        assert.equal(repeated.status, 200)
        assert.equal(repeated.body.sellerOrders[0].deliveryConfirmedAt, confirmed.body.sellerOrders[0].deliveryConfirmedAt)

        const sellerView = await request("GET", `/seller/orders/${orderId}`, undefined, fixture.sellerToken)
        assert.equal(sellerView.body.status, "DELIVERED")
        assert.equal((await request("GET", "/seller/orders?status=DELIVERED", undefined, fixture.sellerToken)).body.total, 1)
        assert.equal((await request("GET", "/seller/orders?status=SHIPPED", undefined, fixture.sellerToken)).body.total, 0)

        // Once delivered, the seller's requests change nothing.
        const afterDelivered = await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        assert.equal(afterDelivered.body.status, "DELIVERED")
    })
})

test("a seller can report delivery straight from paid, which also marks it shipped", async () => {
    await withPaymentCheckout("fulfil-direct", async (context) => {
        const { fixture, request } = context
        const orderId = await payForCheckout(context)

        const reported = await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        assert.equal(reported.status, 200)
        assert.equal(reported.body.status, "SHIPPED")
        assert.ok(reported.body.shippedAt)
        assert.ok(reported.body.deliveryReportedAt)
        assert.equal((await request("GET", "/seller/orders?status=SHIPPED", undefined, fixture.sellerToken)).body.total, 1)

        const repeated = await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        assert.equal(repeated.body.deliveryReportedAt, reported.body.deliveryReportedAt)
    })
})

test("refunded orders cannot be shipped or reported delivered", async () => {
    await withPaymentCheckout("fulfil-refunded", async (context) => {
        const { fixture, request } = context
        const orderId = await payForCheckout(context)
        await prisma.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } })

        for (const action of ["ship", "delivered"]) {
            const response = await request("POST", `/seller/orders/${orderId}/${action}`, {}, fixture.sellerToken)
            assert.equal(response.status, 409)
            assert.equal(response.body.code, "ORDER_STATUS_INVALID")
        }
    })
})

// ---- Refunds, seller liabilities and recovery from later payments ----

function refundOrder(context: PaymentTestContext, orderId: number, body: Record<string, unknown> = {}, token = context.adminToken) {
    return context.request("POST", `/admin/orders/${orderId}/refunds`, { reason: "Buyer returned the item", ...body }, token)
}

// Makes the fake provider report one refund, as the provider would after it was issued.
function providerReports(context: PaymentTestContext, refund: { providerRefundId: string | null }, amountKobo: number, outcome: ProviderRefund["outcome"], providerStatus: string, extra: Partial<ProviderRefund> = {}) {
    context.fakes.behaviors.PAYSTACK.findRefunds = async () => [
        fakeProviderRefund({ providerRefundId: refund.providerRefundId!, amountKobo, outcome, providerStatus, ...extra })
    ]
}

async function loadStock(listingId: number) {
    return (await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).stockQuantity
}

// Puts the fixture's consumer back to a ready checkout of 2 × ₦1,500, after an earlier order was paid.
async function createNextCheckout(context: PaymentTestContext) {
    const cart = await prisma.cart.findUniqueOrThrow({ where: { userId: context.fixture.consumerId } })
    await prisma.cartItem.create({ data: { cartId: cart.id, listingId: context.fixture.listingId, quantity: 2 } })
    return context.fixture.createCheckout()
}

async function acceptCurrentPayoutTerms(sellerId: number) {
    await prisma.sellerProfile.update({
        where: { userId: sellerId },
        data: { payoutTermsVersion: payoutFeeTerms.version, payoutTermsAcceptedAt: new Date() }
    })
}

test("an admin refunds a paid order in full, and it completes only when the provider says so", async () => {
    await withPaymentCheckout("refund-full", async (context) => {
        const { fixture, checkoutId, fakes, request } = context
        const orderId = await payForCheckout(context)
        const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { checkoutId, status: "SUCCESS" } })
        assert.equal(await loadStock(fixture.listingId), 3)

        const issued = await refundOrder(context, orderId, { customerNote: "Your refund is on its way" })
        assert.equal(issued.status, 201)
        const refund = issued.body.refund
        assert.equal(refund.status, "PROCESSING")
        assert.equal(refund.amount, "3000.00")
        assert.equal(refund.orderId, orderId)
        assert.equal(refund.paymentReference, attempt.reference)
        assert.equal(refund.restock, true)
        assert.equal(refund.chargeSeller, true)
        assert.deepEqual(refund.liability && { amount: refund.liability.amount, recovered: refund.liability.recovered, status: refund.liability.status },
            { amount: "3000.00", recovered: "0.00", status: "OPEN" })

        assert.equal(fakes.calls.createRefund.length, 1)
        const providerCall = fakes.calls.createRefund[0]!.input
        assert.equal(providerCall.transactionReference, attempt.reference)
        assert.equal(providerCall.transactionId, "5550001")
        assert.equal(providerCall.amountKobo, 300000)
        assert.equal(providerCall.customerNote, "Your refund is on its way")

        // Accepted by the provider is not completed: the order and the stock have not moved yet.
        const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        assert.equal(before.status, "PAID")
        assert.equal(before.refundedAmount.toFixed(2), "0.00")
        assert.equal(await loadStock(fixture.listingId), 3)

        providerReports(context, refund, 300000, "succeeded", "processed")
        const synced = await request("POST", `/admin/refunds/${refund.id}/sync`, undefined, context.adminToken)
        assert.equal(synced.status, 200)
        assert.equal(synced.body.refund.status, "SUCCEEDED")
        assert.ok(synced.body.refund.completedAt)

        const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        assert.equal(after.status, "REFUNDED")
        assert.equal(after.refundedAmount.toFixed(2), "3000.00")
        assert.equal(await loadStock(fixture.listingId), 5)
        assert.ok(synced.body.refund.restockedAt)

        // Checking again repeats nothing.
        await request("POST", `/admin/refunds/${refund.id}/sync`, undefined, context.adminToken)
        assert.equal(await loadStock(fixture.listingId), 5)
        assert.equal(await prisma.sellerLiability.count({ where: { refundId: refund.id } }), 1)

        const buyerView = await request("GET", `/orders/${checkoutId}`)
        assert.equal(buyerView.body.sellerOrders[0].status, "REFUNDED")
        assert.equal(buyerView.body.sellerOrders[0].refundedAmount, "3000.00")
        assert.deepEqual(
            buyerView.body.sellerOrders[0].refunds.map((item: { status: string; note: string; amount: string }) => [item.status, item.note, item.amount]),
            [["SUCCEEDED", "Your refund is on its way", "3000.00"]]
        )
        assert.equal(JSON.stringify(buyerView.body).includes("Buyer returned the item"), false)

        const sellerView = await request("GET", `/seller/orders/${orderId}`, undefined, fixture.sellerToken)
        assert.equal(sellerView.body.refunds[0].reason, "Buyer returned the item")
        assert.equal(sellerView.body.refundedAmount, "3000.00")
    })
})

test("partial refunds are limited to what is left, one at a time, and never restock", async () => {
    await withPaymentCheckout("refund-partial", async (context) => {
        const { fixture, request } = context
        const orderId = await payForCheckout(context)

        const restockPartial = await refundOrder(context, orderId, { amount: "1000", restock: true })
        assert.equal(restockPartial.status, 400)
        assert.equal(restockPartial.body.code, "REFUND_RESTOCK_NOT_ALLOWED")

        const first = await refundOrder(context, orderId, { amount: 1000 })
        assert.equal(first.status, 201)
        assert.equal(first.body.refund.restock, false)

        const overlapping = await refundOrder(context, orderId, { amount: 500 })
        assert.equal(overlapping.status, 409)
        assert.equal(overlapping.body.code, "REFUND_IN_PROGRESS")

        providerReports(context, first.body.refund, 100000, "succeeded", "processed")
        await request("POST", `/admin/refunds/${first.body.refund.id}/sync`, undefined, context.adminToken)
        const midway = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        assert.equal(midway.status, "PAID")
        assert.equal(midway.refundedAmount.toFixed(2), "1000.00")

        const tooMuch = await refundOrder(context, orderId, { amount: "2500" })
        assert.equal(tooMuch.status, 400)
        assert.equal(tooMuch.body.code, "REFUND_AMOUNT_INVALID")
        assert.equal(tooMuch.body.maximum, "2000.00")

        const rest = await refundOrder(context, orderId)
        assert.equal(rest.status, 201)
        assert.equal(rest.body.refund.amount, "2000.00")
        providerReports(context, rest.body.refund, 200000, "succeeded", "processed")
        await request("POST", `/admin/refunds/${rest.body.refund.id}/sync`, undefined, context.adminToken)

        const done = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        assert.equal(done.status, "REFUNDED")
        assert.equal(done.refundedAmount.toFixed(2), "3000.00")
        assert.equal(await loadStock(fixture.listingId), 3)
        assert.equal((await refundOrder(context, orderId)).status, 409)
    })
})

test("only administrators can refund, and invalid refund requests are refused before the provider is called", async () => {
    await withPaymentCheckout("refund-guards", async (context) => {
        const { fixture, checkoutId, fakes } = context
        const [unpaid] = await prisma.order.findMany({ where: { checkoutId } })
        assert.equal((await refundOrder(context, unpaid!.id)).status, 409)

        const orderId = await payForCheckout(context)

        assert.equal((await refundOrder(context, orderId, {}, fixture.token)).status, 403)
        assert.equal((await refundOrder(context, orderId, {}, fixture.sellerToken)).status, 403)
        assert.equal((await context.request("POST", `/admin/orders/${orderId}/refunds`, { reason: "x" }, "not-a-token")).status, 401)
        assert.equal((await context.request("GET", "/admin/refunds", undefined, fixture.token)).status, 403)

        const bad: Array<[Record<string, unknown>, number]> = [
            [{ reason: undefined }, 400],
            [{ reason: "  " }, 400],
            [{ reason: "x".repeat(301) }, 400],
            [{ amount: "12.345" }, 400],
            [{ amount: -5 }, 400],
            [{ amount: "abc" }, 400],
            [{ amount: 0 }, 400],
            [{ customerNote: "x".repeat(301) }, 400],
            [{ restock: "yes" }, 400],
            [{ chargeSeller: 1 }, 400]
        ]

        for (const [body, status] of bad) {
            const response = await refundOrder(context, orderId, body)
            assert.equal(response.status, status, JSON.stringify(body))
        }

        assert.equal((await context.request("POST", "/admin/orders/999999/refunds", { reason: "Test" }, context.adminToken)).status, 404)
        assert.equal((await context.request("POST", "/admin/orders/abc/refunds", { reason: "Test" }, context.adminToken)).status, 404)
        assert.equal(fakes.calls.createRefund.length, 0)
        assert.equal(await prisma.refund.count({ where: { orderId } }), 0)
    })
})

test("warns before a refund the provider balance cannot cover, unless the admin confirms", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {})

    await withPaymentCheckout("refund-balance", async (context) => {
        const { fakes } = context
        const orderId = await payForCheckout(context)

        fakes.behaviors.PAYSTACK.balance = async () => 100000
        const warned = await refundOrder(context, orderId)
        assert.equal(warned.status, 409)
        assert.equal(warned.body.code, "REFUND_BALANCE_LOW")
        assert.equal(warned.body.availableBalance, "1000.00")
        assert.equal(warned.body.required, "3000.00")
        assert.equal(fakes.calls.createRefund.length, 0)
        assert.equal(await prisma.refund.count({ where: { orderId } }), 0)

        const confirmed = await refundOrder(context, orderId, { acknowledgeLowBalance: true })
        assert.equal(confirmed.status, 201)
        assert.equal(fakes.calls.createRefund.length, 1)
    })

    await withPaymentCheckout("refund-balance-unknown", async (context) => {
        const orderId = await payForCheckout(context)
        context.fakes.behaviors.PAYSTACK.balance = async () => { throw new PaymentProviderError("unavailable", "Paystack could not be reached") }
        assert.equal((await refundOrder(context, orderId)).status, 201)
        assert.ok(consoleError.mock.calls.some((call) => call.arguments[0] === "Could not read the provider balance before a refund"))
    })

    await withPaymentCheckout("refund-balance-null", async (context) => {
        const orderId = await payForCheckout(context)
        context.fakes.behaviors.PAYSTACK.balance = async () => null
        assert.equal((await refundOrder(context, orderId)).status, 201)
    })
})

test("a rejected refund is closed and can be issued again, and an unknown outcome is never retried", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("refund-outcomes", async (context) => {
        const { fakes, request } = context
        const orderId = await payForCheckout(context)

        fakes.behaviors.PAYSTACK.createRefund = async () => {
            throw new PaymentProviderError("rejected", "Paystack rejected the request", "HTTP 400: Invalid transaction")
        }
        const rejected = await refundOrder(context, orderId)
        assert.equal(rejected.status, 502)
        assert.equal(rejected.body.code, "REFUND_PROVIDER_REJECTED")
        const [closed] = await prisma.refund.findMany({ where: { orderId } })
        assert.equal(closed?.status, "FAILED")
        assert.equal(await prisma.sellerLiability.count({ where: { sellerId: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).sellerId } }), 0)

        // The provider could not be reached: nobody knows whether it refunded, so it is not retried.
        fakes.behaviors.PAYSTACK.createRefund = async () => {
            throw new PaymentProviderError("unavailable", "Paystack could not be reached", "TimeoutError")
        }
        const unknown = await refundOrder(context, orderId)
        assert.equal(unknown.status, 502)
        assert.equal(unknown.body.code, "REFUND_PROVIDER_UNAVAILABLE")
        const unknownRefund = await prisma.refund.findUniqueOrThrow({ where: { reference: unknown.body.refundReference } })
        assert.equal(unknownRefund.status, "PENDING")
        assert.equal(unknownRefund.providerRefundId, null)
        assert.equal(await prisma.sellerLiability.count({ where: { refundId: unknownRefund.id } }), 0)

        const blocked = await refundOrder(context, orderId)
        assert.equal(blocked.status, 409)
        assert.equal(blocked.body.code, "REFUND_IN_PROGRESS")
        assert.equal(fakes.calls.createRefund.length, 2)

        // Checking: nothing at the provider yet, and not long enough to give up, so it stays pending.
        await request("POST", `/admin/refunds/${unknownRefund.id}/sync`, undefined, context.adminToken)
        assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: unknownRefund.id } })).status, "PENDING")

        // The provider did make it: it is found by amount and time, then followed like any refund.
        const found = fakeProviderRefund({ amountKobo: 300000 })
        fakes.behaviors.PAYSTACK.findRefunds = async () => [found]
        const adopted = await request("POST", `/admin/refunds/${unknownRefund.id}/sync`, undefined, context.adminToken)
        assert.equal(adopted.body.refund.status, "PROCESSING")
        assert.equal(adopted.body.refund.providerRefundId, found.providerRefundId)
        assert.equal(await prisma.sellerLiability.count({ where: { refundId: unknownRefund.id } }), 1)
    })

    await withPaymentCheckout("refund-no-record", async (context) => {
        const { fakes, request } = context
        const orderId = await payForCheckout(context)
        fakes.behaviors.PAYSTACK.createRefund = async () => {
            throw new PaymentProviderError("unavailable", "Paystack could not be reached", "TimeoutError")
        }
        const unknown = await refundOrder(context, orderId)
        const refund = await prisma.refund.findUniqueOrThrow({ where: { reference: unknown.body.refundReference } })
        await prisma.$executeRaw`UPDATE "Refund" SET "createdAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 minutes' WHERE id = ${refund.id}`

        // A refund the provider has never heard of is closed after a while, so it can be issued again.
        const closed = await request("POST", `/admin/refunds/${refund.id}/sync`, undefined, context.adminToken)
        assert.equal(closed.body.refund.status, "FAILED")
        assert.equal(closed.body.refund.failureReason, "The payment provider has no record of this refund")

        delete fakes.behaviors.PAYSTACK.createRefund
        assert.equal((await refundOrder(context, orderId)).status, 201)
    })
})

test("a refund that fails at the provider voids the seller's liability and leaves the order alone", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("refund-failed", async (context) => {
        const { fixture, request } = context
        const orderId = await payForCheckout(context)
        const issued = await refundOrder(context, orderId)
        assert.equal(issued.body.refund.liability.status, "OPEN")

        providerReports(context, issued.body.refund, 300000, "failed", "failed")
        const failed = await request("POST", `/admin/refunds/${issued.body.refund.id}/sync`, undefined, context.adminToken)
        assert.equal(failed.body.refund.status, "FAILED")
        assert.equal(failed.body.refund.liability.status, "VOID")

        const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        assert.equal(order.status, "PAID")
        assert.equal(order.refundedAmount.toFixed(2), "0.00")
        assert.equal(await loadStock(fixture.listingId), 3)
        assert.equal((await refundOrder(context, orderId)).status, 201)
    })
})

test("records needs-attention and waiting-for-funds states from the provider", async () => {
    await withPaymentCheckout("refund-states", async (context) => {
        const { request } = context
        const orderId = await payForCheckout(context)
        const issued = await refundOrder(context, orderId)
        const refundId = issued.body.refund.id as number

        providerReports(context, issued.body.refund, 300000, "processing", "pending", { awaitingFunds: true, expectedAt: new Date("2026-11-01T00:00:00Z") })
        const waiting = await request("POST", `/admin/refunds/${refundId}/sync`, undefined, context.adminToken)
        assert.equal(waiting.body.refund.status, "PROCESSING")
        assert.equal(waiting.body.refund.awaitingFunds, true)
        assert.equal(waiting.body.refund.expectedAt, "2026-11-01T00:00:00.000Z")

        providerReports(context, issued.body.refund, 300000, "needs_attention", "needs-attention")
        const attention = await request("POST", `/admin/refunds/${refundId}/sync`, undefined, context.adminToken)
        assert.equal(attention.body.refund.status, "NEEDS_ATTENTION")
        assert.equal(attention.body.refund.awaitingFunds, false)

        providerReports(context, issued.body.refund, 300000, "succeeded", "processed")
        assert.equal((await request("POST", `/admin/refunds/${refundId}/sync`, undefined, context.adminToken)).body.refund.status, "SUCCEEDED")

        const list = await request("GET", "/admin/refunds?status=SUCCEEDED", undefined, context.adminToken)
        assert.equal(list.status, 200)
        assert.equal(list.body.refunds.some((refund: { id: number }) => refund.id === refundId), true)
        assert.equal((await request("GET", "/admin/refunds?status=NOPE", undefined, context.adminToken)).status, 400)
        assert.equal((await request("GET", `/admin/refunds/${refundId}`, undefined, context.adminToken)).body.refund.reference, issued.body.refund.reference)
        assert.equal((await request("GET", "/admin/refunds/999999", undefined, context.adminToken)).status, 404)
    })
})

test("a signed refund webhook makes StoreHatch check the provider, and a failure asks for redelivery", async (t) => {
    process.env.PAYSTACK_SECRET_KEY ||= "sk_test_integration_webhook_secret"
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("refund-webhook", async (context) => {
        const { baseUrl, fakes } = context
        const orderId = await payForCheckout(context)
        const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { checkoutId: context.checkoutId, status: "SUCCESS" } })
        const issued = await refundOrder(context, orderId)
        const event = JSON.stringify({
            event: "refund.processed",
            data: { status: "processed", transaction_reference: attempt.reference, refund_reference: null, amount: "300000", currency: "NGN" }
        })

        fakes.behaviors.PAYSTACK.findRefunds = async () => { throw new PaymentProviderError("unavailable", "Paystack could not be reached") }
        assert.equal((await postPaystackWebhook(baseUrl, event)).status, 500)
        assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: issued.body.refund.id } })).status, "PROCESSING")

        providerReports(context, issued.body.refund, 300000, "succeeded", "processed")
        assert.equal((await postPaystackWebhook(baseUrl, event)).status, 200)
        assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: issued.body.refund.id } })).status, "SUCCEEDED")

        assert.equal((await postPaystackWebhook(baseUrl, event)).status, 200)
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).refundedAmount.toFixed(2), "3000.00")

        assert.equal((await postPaystackWebhook(baseUrl, event, "0".repeat(128))).status, 401)
        const unknownPayment = JSON.stringify({ event: "refund.processed", data: { transaction_reference: "VND-nothing" } })
        assert.equal((await postPaystackWebhook(baseUrl, unknownPayment)).status, 200)
    })
})

test("the periodic refund check follows open refunds and does nothing when none are open", async () => {
    await withPaymentCheckout("refund-checker", async (context) => {
        const { fakes } = context
        const orderId = await payForCheckout(context)

        const callsBefore = fakes.calls.findRefunds.length
        assert.equal(await checkOpenRefunds(), 0)
        assert.equal(fakes.calls.findRefunds.length, callsBefore)

        const issued = await refundOrder(context, orderId)
        const refundId = issued.body.refund.id as number
        providerReports(context, issued.body.refund, 300000, "succeeded", "processed")

        // Just checked by issuing it, so it is left alone for now.
        assert.equal(await checkOpenRefunds(), 0)

        await prisma.refund.update({ where: { id: refundId }, data: { lastCheckedAt: null } })
        assert.equal(await checkOpenRefunds(), 1)
        assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status, "SUCCEEDED")
        assert.equal(await checkOpenRefunds(), 0)
    })
})

test("a seller's liability is recovered from later payments, never more than half of an order", async () => {
    await withPaymentCheckout("liability-cap", async (context) => {
        const { fixture, fakes, request } = context
        await acceptCurrentPayoutTerms(fixture.sellerId)
        const orderId = await payForCheckout(context)
        const issued = await refundOrder(context, orderId)
        assert.equal(issued.body.refund.liability.amount, "3000.00")

        const nextCheckoutId = await createNextCheckout(context)
        const started = await request("POST", `/checkout/${nextCheckoutId}/payments`, { provider: "PAYSTACK" })
        assert.equal(started.status, 201)
        assert.deepEqual(fakes.calls.initialize.at(-1)!.input.splits, [
            { subaccountCode: "ACCT_test_liability-cap", amountKobo: 150000, retainedKobo: 150000 }
        ])
        const [nextOrder] = await prisma.order.findMany({ where: { checkoutId: nextCheckoutId } })
        assert.equal(nextOrder!.liabilityDeduction.toFixed(2), "1500.00")

        // Paystack reports StoreHatch's share as one lump, after StoreHatch's part of the fee.
        const reference = started.body.payment.reference as string
        fakes.behaviors.PAYSTACK.verify = async () => ({
            ...paystackVerification("success", reference),
            sellerShares: [{ subaccountCode: "ACCT_test_liability-cap", receivedKobo: 148500, feeKobo: 1500 }],
            vendlyShareKobo: 147000
        })
        await request("GET", `/payments/${reference}`)

        const settled = await prisma.order.findUniqueOrThrow({ where: { id: nextOrder!.id } })
        assert.equal(settled.status, "PAID")
        assert.equal(settled.liabilityDeduction.toFixed(2), "1470.00")
        assert.equal(settled.sellerReceives?.toFixed(2), "1485.00")
        assert.equal(settled.providerFee?.toFixed(2), "15.00")

        const liability = await prisma.sellerLiability.findUniqueOrThrow({ where: { refundId: issued.body.refund.id }, include: { recoveries: true } })
        assert.equal(liability.recovered.toFixed(2), "1470.00")
        assert.equal(liability.status, "OPEN")
        assert.deepEqual(liability.recoveries.map((recovery) => [recovery.orderId, recovery.amount.toFixed(2)]), [[nextOrder!.id, "1470.00"]])

        const sellerList = await request("GET", "/seller/orders", undefined, fixture.sellerToken)
        const listed = sellerList.body.orders.find((order: { id: number }) => order.id === nextOrder!.id)
        assert.equal(listed.liabilityDeduction, "1470.00")

        // Paying again repeats nothing: the settlement already ran.
        await request("GET", `/payments/${reference}`)
        assert.equal((await prisma.sellerLiability.findUniqueOrThrow({ where: { id: liability.id } })).recovered.toFixed(2), "1470.00")
    })
})

test("a seller who has not accepted the current terms is never charged", async () => {
    await withPaymentCheckout("liability-terms", async (context) => {
        const { fakes, request } = context
        const orderId = await payForCheckout(context)
        await refundOrder(context, orderId, { amount: 1000 })

        const nextCheckoutId = await createNextCheckout(context)
        await request("POST", `/checkout/${nextCheckoutId}/payments`, { provider: "PAYSTACK" })
        assert.deepEqual(fakes.calls.initialize.at(-1)!.input.splits.map((split) => split.retainedKobo), [0])
        const [nextOrder] = await prisma.order.findMany({ where: { checkoutId: nextCheckoutId } })
        assert.equal(nextOrder!.liabilityDeduction.toFixed(2), "0.00")
    })
})

test("a liability smaller than the cap is cleared in one payment, with Flutterwave's per-seller figure", async () => {
    await withPaymentCheckout("liability-flutterwave", async (context) => {
        const { fixture, fakes, request } = context
        await acceptCurrentPayoutTerms(fixture.sellerId)
        const orderId = await payForCheckout(context)
        const issued = await refundOrder(context, orderId, { amount: 1000 })

        const nextCheckoutId = await createNextCheckout(context)
        const started = await request("POST", `/checkout/${nextCheckoutId}/payments`, { provider: "FLUTTERWAVE" })
        assert.equal(started.status, 201)
        assert.deepEqual(fakes.calls.initialize.at(-1)!.input.splits, [
            { subaccountCode: "RS_test_liability-flutterwave", amountKobo: 200000, retainedKobo: 100000 }
        ])

        const reference = started.body.payment.reference as string
        fakes.behaviors.FLUTTERWAVE.verify = async () => ({
            ...flutterwaveVerification("success", reference),
            sellerShares: [{ subaccountCode: "RS_test_liability-flutterwave", receivedKobo: 198000, feeKobo: null, retainedKobo: 100000 }],
            vendlyShareKobo: 100000
        })
        await request("GET", `/payments/${reference}`)

        const [nextOrder] = await prisma.order.findMany({ where: { checkoutId: nextCheckoutId } })
        assert.equal(nextOrder!.liabilityDeduction.toFixed(2), "1000.00")
        assert.equal(nextOrder!.sellerReceives?.toFixed(2), "1980.00")
        // Flutterwave reports no fee, so it is what is left after the seller's payout and StoreHatch's part.
        assert.equal(nextOrder!.providerFee?.toFixed(2), "20.00")

        const liability = await prisma.sellerLiability.findUniqueOrThrow({ where: { refundId: issued.body.refund.id } })
        assert.equal(liability.recovered.toFixed(2), "1000.00")
        assert.equal(liability.status, "CLEARED")
        assert.ok(liability.closedAt)
    }, { payoutProviders: ["PAYSTACK", "FLUTTERWAVE"] })
})

test("two unpaid checkouts never plan to collect the same liability", async () => {
    await withPaymentCheckout("liability-reserve", async (context) => {
        const { fixture, fakes, request } = context
        await acceptCurrentPayoutTerms(fixture.sellerId)
        const orderId = await payForCheckout(context)
        await refundOrder(context, orderId, { amount: 1000 })

        const firstCheckoutId = await createNextCheckout(context)
        await request("POST", `/checkout/${firstCheckoutId}/payments`, { provider: "PAYSTACK" })
        assert.deepEqual(fakes.calls.initialize.at(-1)!.input.splits.map((split) => split.retainedKobo), [100000])

        // Another shopper pays the same seller while the first payment is still open.
        const other = await fixture.addConsumer(1)
        const otherCheckoutId = await fixture.createCheckout(other.token)
        const otherStart = await request("POST", `/checkout/${otherCheckoutId}/payments`, { provider: "PAYSTACK" }, other.token)
        assert.equal(otherStart.status, 201)
        assert.deepEqual(fakes.calls.initialize.at(-1)!.input.splits.map((split) => split.retainedKobo), [0])
    })
})

test("sellers see what they owe and accept the terms that allow recovery", async () => {
    await withPaymentCheckout("liability-seller", async (context) => {
        const { fixture, request } = context
        const view = () => request("GET", "/seller/liabilities", undefined, fixture.sellerToken)

        const fresh = await view()
        assert.equal(fresh.status, 200)
        assert.equal(fresh.body.termsAccepted, false)
        assert.equal(fresh.body.outstanding, "0.00")
        assert.equal(fresh.body.deductionCapPercent, 50)
        assert.deepEqual(fresh.body.liabilities, [])
        assert.equal((await request("GET", "/seller/liabilities")).status, 403)

        const stale = await request("POST", "/seller/payout/terms", { feeTermsVersion: "2000-01-01" }, fixture.sellerToken)
        assert.equal(stale.status, 409)
        assert.equal(stale.body.code, "PAYOUT_FEE_TERMS_OUTDATED")
        assert.equal((await request("POST", "/seller/payout/terms", { feeTermsVersion: payoutFeeTerms.version })).status, 403)

        const accepted = await request("POST", "/seller/payout/terms", { feeTermsVersion: payoutFeeTerms.version }, fixture.sellerToken)
        assert.equal(accepted.status, 200)
        assert.equal((await view()).body.termsAccepted, true)

        const orderId = await payForCheckout(context)
        await refundOrder(context, orderId, { amount: "1250.50", reason: "Item arrived damaged" })

        const owing = await view()
        assert.equal(owing.body.outstanding, "1250.50")
        assert.deepEqual(
            owing.body.liabilities.map((item: { orderId: number; reason: string; amount: string; remaining: string; status: string }) =>
                [item.orderId, item.reason, item.amount, item.remaining, item.status]),
            [[orderId, "Item arrived damaged", "1250.50", "1250.50", "OPEN"]]
        )
        assert.match(owing.body.feeTerms.text, /Refunds:/)
    })
})

test("an admin records money collected by hand and can write off what cannot be collected", async () => {
    await withPaymentCheckout("liability-admin", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payForCheckout(context)
        const first = await refundOrder(context, orderId, { amount: 1000 })
        providerReports(context, first.body.refund, 100000, "succeeded", "processed")
        await request("POST", `/admin/refunds/${first.body.refund.id}/sync`, undefined, adminToken)
        const second = await refundOrder(context, orderId, { amount: 2000 })
        const firstLiabilityId = first.body.refund.liability.id as number
        const secondLiabilityId = second.body.refund.liability.id as number

        const open = await request("GET", "/admin/liabilities", undefined, adminToken)
        assert.equal(open.status, 200)
        assert.deepEqual(open.body.liabilities.map((item: { id: number }) => item.id).sort(), [firstLiabilityId, secondLiabilityId].sort())
        assert.equal(open.body.liabilities[0].seller.email.includes("liability-admin-seller"), true)
        assert.equal((await request("GET", "/admin/liabilities?status=NOPE", undefined, adminToken)).status, 400)
        assert.equal((await request("GET", "/admin/liabilities", undefined, fixture.sellerToken)).status, 403)

        const record = (id: number, body: Record<string, unknown>) => request("POST", `/admin/liabilities/${id}/manual-recovery`, body, adminToken)
        assert.equal((await record(firstLiabilityId, { amount: "abc", note: "Bank transfer" })).status, 400)
        assert.equal((await record(firstLiabilityId, { amount: 100 })).status, 400)
        const tooMuch = await record(firstLiabilityId, { amount: 4000, note: "Bank transfer" })
        assert.equal(tooMuch.status, 409)
        assert.equal(tooMuch.body.code, "LIABILITY_NOT_OPEN")
        assert.equal((await record(999999, { amount: 100, note: "Bank transfer" })).status, 404)

        const partial = await record(firstLiabilityId, { amount: 400, note: "Bank transfer" })
        assert.equal(partial.status, 200)
        assert.equal(partial.body.liability.recovered, "400.00")
        assert.equal(partial.body.liability.remaining, "600.00")
        assert.equal(partial.body.liability.recoveries[0].orderId, null)
        assert.equal(partial.body.liability.recoveries[0].note, "Bank transfer")

        const cleared = await record(firstLiabilityId, { amount: "600.00", note: "Second transfer" })
        assert.equal(cleared.body.liability.status, "CLEARED")
        assert.equal((await record(firstLiabilityId, { amount: 1, note: "Too late" })).status, 409)

        const writeOff = (id: number, body: Record<string, unknown>) => request("POST", `/admin/liabilities/${id}/write-off`, body, adminToken)
        assert.equal((await writeOff(secondLiabilityId, {})).status, 400)
        const written = await writeOff(secondLiabilityId, { note: "Seller has closed their shop" })
        assert.equal(written.status, 200)
        assert.equal(written.body.liability.status, "WRITTEN_OFF")
        assert.equal((await writeOff(secondLiabilityId, { note: "Again" })).status, 409)
        assert.equal((await writeOff(firstLiabilityId, { note: "Already cleared" })).status, 409)
        assert.equal((await writeOff(999999, { note: "Nothing there" })).status, 404)
        assert.equal((await request("GET", "/admin/liabilities?status=WRITTEN_OFF", undefined, adminToken)).body.liabilities.length >= 1, true)
    })
})

// Verifies a payment whose stock was already released, which opens a recovery case.
async function openRecoveryCase(context: PaymentTestContext) {
    const reference = (await context.startPayment()).body.payment.reference as string
    await prisma.inventoryReservation.updateMany({ where: { checkoutId: context.checkoutId }, data: { status: "RELEASED" } })
    context.fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)
    await context.request("GET", `/payments/${reference}`)
    return prisma.paymentRecoveryCase.findFirstOrThrow({ where: { paymentAttempt: { reference } } })
}

test("an admin clears a recovery case by refunding the whole payment", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("recovery-refund", async (context) => {
        const { fixture, checkoutId, request, adminToken } = context
        const recoveryCase = await openRecoveryCase(context)

        const list = await request("GET", "/admin/recovery-cases", undefined, adminToken)
        assert.equal(list.status, 200)
        const listed = list.body.cases.find((item: { id: number }) => item.id === recoveryCase.id)
        assert.equal(listed.payment.amount, "3000.00")
        assert.equal(listed.payment.checkoutId, checkoutId)
        assert.match(listed.payment.buyer.email, /recovery-refund-consumer/)
        assert.equal((await request("GET", "/admin/recovery-cases", undefined, fixture.token)).status, 403)
        assert.equal((await request("GET", "/admin/recovery-cases?status=NOPE", undefined, adminToken)).status, 400)

        const partial = await request("POST", `/admin/recovery-cases/${recoveryCase.id}/refund`, { amount: 100 }, adminToken)
        assert.equal(partial.status, 400)
        assert.equal(partial.body.code, "REFUND_AMOUNT_INVALID")

        const refunded = await request("POST", `/admin/recovery-cases/${recoveryCase.id}/refund`, { customerNote: "We could not complete your order" }, adminToken)
        assert.equal(refunded.status, 201)
        assert.equal(refunded.body.refund.orderId, null)
        assert.equal(refunded.body.refund.amount, "3000.00")
        assert.equal(refunded.body.refund.chargeSeller, false)
        assert.equal(refunded.body.refund.restock, false)
        assert.equal(refunded.body.refund.liability, null)
        assert.equal((await prisma.paymentRecoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } })).status, "OPEN")

        providerReports(context, refunded.body.refund, 300000, "succeeded", "processed")
        await request("POST", `/admin/refunds/${refunded.body.refund.id}/sync`, undefined, adminToken)

        const closed = await prisma.paymentRecoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } })
        assert.equal(closed.status, "RESOLVED")
        assert.match(closed.resolutionNote ?? "", /Refunded in full \(RFD-/)
        const [order] = await prisma.order.findMany({ where: { checkoutId } })
        assert.equal(order!.status, "CANCELLED")
        assert.equal(await prisma.sellerLiability.count({ where: { refundId: refunded.body.refund.id } }), 0)

        const again = await request("POST", `/admin/recovery-cases/${recoveryCase.id}/refund`, {}, adminToken)
        assert.equal(again.status, 409)
    })
})

test("an admin can close a recovery case that was handled another way", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("recovery-resolve", async (context) => {
        const { request, adminToken } = context
        const recoveryCase = await openRecoveryCase(context)
        const resolve = (id: number, body: Record<string, unknown>) => request("POST", `/admin/recovery-cases/${id}/resolve`, body, adminToken)

        assert.equal((await resolve(recoveryCase.id, {})).status, 400)
        assert.equal((await resolve(999999, { note: "Nothing there" })).status, 404)

        const resolved = await resolve(recoveryCase.id, { note: "Fulfilled by hand and delivered" })
        assert.equal(resolved.status, 200)
        assert.equal(resolved.body.case.status, "RESOLVED")
        assert.equal(resolved.body.case.resolutionNote, "Fulfilled by hand and delivered")
        assert.equal((await resolve(recoveryCase.id, { note: "Again" })).status, 409)
        assert.equal((await request("GET", "/admin/recovery-cases", undefined, adminToken)).body.cases.length, 0)
        assert.equal((await request("GET", "/admin/recovery-cases?status=RESOLVED", undefined, adminToken)).body.cases.length >= 1, true)
    })
})

test("the real adapters send refunds, balance checks and retained shares the way each provider expects", async (t) => {
    process.env.PAYSTACK_SECRET_KEY ||= "sk_test_integration"
    process.env.FLUTTERWAVE_SECRET_KEY ||= "FLWSECK_TEST-integration"
    const requests: Array<{ url: string; method: string; body: any }> = []
    let nextResponse: unknown = {}
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(JSON.stringify(nextResponse), { status: 200, headers: { "content-type": "application/json" } })
    })

    // Paystack: refund, list, balance
    nextResponse = { status: true, data: { id: 3018284, status: "pending", amount: 150000, fully_deducted: false, expected_at: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-20T10:00:00.000Z" } }
    const created = await paystackAdapter.createRefund({ transactionReference: "VND-9-abc", transactionId: "555", amountKobo: 150000, customerNote: "Sorry", merchantNote: "StoreHatch refund RFD-1" })
    assert.deepEqual(requests.at(-1), {
        url: "https://api.paystack.co/refund",
        method: "POST",
        body: { transaction: "VND-9-abc", amount: 150000, currency: "NGN", customer_note: "Sorry", merchant_note: "StoreHatch refund RFD-1" }
    })
    assert.equal(created.providerRefundId, "3018284")
    assert.equal(created.outcome, "processing")
    // A create response does not claim the refund is waiting for funds.
    assert.equal(created.awaitingFunds, false)

    nextResponse = {
        status: true,
        data: [
            { id: 1, status: "pending", amount: 100, fully_deducted: 0 },
            { id: 2, status: "processed", amount: 200, fully_deducted: 1 },
            { id: 3, status: "needs-attention", amount: 300 },
            { id: 4, status: "failed", amount: 400 },
            { id: 5, status: "processing", amount: 500, fully_deducted: 1 }
        ]
    }
    const listed = await paystackAdapter.findRefunds({ transactionReference: "VND-9-abc", transactionId: "555", providerRefundId: null })
    assert.equal(requests.at(-1)!.url, "https://api.paystack.co/refund?transaction=555&perPage=100")
    assert.deepEqual(listed.map((refund) => [refund.providerRefundId, refund.outcome, refund.awaitingFunds]), [
        ["1", "processing", true],
        ["2", "succeeded", false],
        ["3", "needs_attention", false],
        ["4", "failed", false],
        ["5", "processing", false]
    ])
    await assert.rejects(() => paystackAdapter.findRefunds({ transactionReference: "VND-9-abc", transactionId: null, providerRefundId: null }), PaymentProviderError)

    nextResponse = { status: true, data: [{ currency: "GHS", balance: 5 }, { currency: "NGN", balance: 23446800 }] }
    assert.equal(await paystackAdapter.getBalanceKobo(), 23446800)

    // Paystack: a retained share is whatever the sellers' shares leave over, and StoreHatch's share is read back.
    nextResponse = { status: true, data: { authorization_url: "https://checkout.paystack.com/x" } }
    await paystackAdapter.initializePayment({
        reference: "VND-9-abc", amountKobo: 3000000, email: "buyer@example.test", callbackUrl: "http://localhost:5173/checkout/payment-return",
        splits: [{ subaccountCode: "SUB_A", amountKobo: 1800000, retainedKobo: 200000 }, { subaccountCode: "SUB_B", amountKobo: 1000000, retainedKobo: 0 }]
    })
    assert.deepEqual(requests.at(-1)!.body.split.subaccounts, [
        { subaccount: "SUB_A", share: 1800000 },
        { subaccount: "SUB_B", share: 1000000 }
    ])
    nextResponse = {
        status: true,
        data: { id: 7, reference: "VND-9-abc", status: "success", amount: 3000000, currency: "NGN",
            split: { shares: { integration: 196333, subaccounts: [{ subaccount_code: "ACCT_A", amount: 1767000, fees: 33000 }] } } }
    }
    const verified = await paystackAdapter.verifyPayment("VND-9-abc")
    assert.ok(verified.outcome !== "not_found")
    assert.equal(verified.vendlyShareKobo, 196333)

    // Paystack webhooks for refunds carry no ID of their own.
    const refundEvent = paystackAdapter.parseWebhook(Buffer.from(JSON.stringify({ event: "refund.processed", data: { transaction_reference: "VND-9-abc", amount: "100" } })))
    assert.deepEqual(refundEvent, { eventKey: "refund.processed:VND-9-abc", eventType: "refund.processed", reference: "VND-9-abc", isPaymentEvent: false, isRefundEvent: true })

    // Flutterwave: refund by transaction ID, in naira
    nextResponse = { status: "success", data: { id: 8612, amount_refunded: 1500, status: "completed", created_at: "2026-10-20T10:00:00.000Z" } }
    const flwRefund = await flutterwaveAdapter.createRefund({ transactionReference: "VND-9-abc", transactionId: "908790", amountKobo: 150000, customerNote: null, merchantNote: "StoreHatch refund RFD-2" })
    assert.deepEqual(requests.at(-1), {
        url: "https://api.flutterwave.com/v3/transactions/908790/refund",
        method: "POST",
        body: { amount: 1500, comments: "StoreHatch refund RFD-2" }
    })
    assert.equal(flwRefund.outcome, "succeeded")
    assert.equal(flwRefund.amountKobo, 150000)
    await assert.rejects(() => flutterwaveAdapter.createRefund({ transactionReference: "x", transactionId: null, amountKobo: 100, customerNote: null, merchantNote: "n" }), PaymentProviderError)

    nextResponse = { status: "success", data: { id: 469462, amount_refunded: 101.4, status: "completed-mpgs", created_at: "2021-05-12T23:19:11.000Z" } }
    const flwFound = await flutterwaveAdapter.findRefunds({ transactionReference: "VND-9-abc", transactionId: "908790", providerRefundId: "469462" })
    assert.equal(requests.at(-1)!.url, "https://api.flutterwave.com/v3/refunds/469462")
    assert.deepEqual(flwFound.map((refund) => [refund.providerRefundId, refund.outcome, refund.amountKobo]), [["469462", "succeeded", 10140]])

    nextResponse = { status: "success", data: { available_balance: 2500.5 } }
    assert.equal(await flutterwaveAdapter.getBalanceKobo(), 250050)

    // Flutterwave: a retained share is a flat commission on that seller's order, with the rest split by ratio.
    nextResponse = { status: "success", data: { link: "https://checkout.flutterwave.com/x" } }
    await flutterwaveAdapter.initializePayment({
        reference: "VND-9-abc", amountKobo: 3000000, email: "buyer@example.test", callbackUrl: "http://localhost:5173/checkout/payment-return",
        splits: [{ subaccountCode: "RS_A", amountKobo: 1800000, retainedKobo: 200000 }, { subaccountCode: "RS_B", amountKobo: 1000000, retainedKobo: 0 }]
    })
    assert.deepEqual(requests.at(-1)!.body.subaccounts, [
        { id: "RS_A", transaction_split_ratio: 9, transaction_charge_type: "flat", transaction_charge: 2000 },
        { id: "RS_B", transaction_split_ratio: 5, transaction_charge_type: "flat", transaction_charge: 0 }
    ])
    nextResponse = {
        status: "success",
        data: { id: 9, tx_ref: "VND-9-abc", status: "successful", amount: 30000, currency: "NGN",
            meta: { split_settlement_info: JSON.stringify({
                RS_A: { merchant_commission: 2000, subaccount_earning: 17730 },
                total_merchant_commission: 2000,
                RS_B: { merchant_commission: 0, subaccount_earning: 9850 }
            }) } }
    }
    const flwVerified = await flutterwaveAdapter.verifyPayment("VND-9-abc")
    assert.ok(flwVerified.outcome !== "not_found")
    assert.equal(flwVerified.vendlyShareKobo, 200000)
    assert.deepEqual(flwVerified.sellerShares, [
        { subaccountCode: "RS_A", receivedKobo: 1773000, feeKobo: null, retainedKobo: 200000 },
        { subaccountCode: "RS_B", receivedKobo: 985000, feeKobo: null, retainedKobo: 0 }
    ])
})

test("the session check reports whether the user is an administrator", async () => {
    await withPaymentCheckout("session-admin", async ({ fixture, adminToken, request }) => {
        const admin = await request("GET", "/users/check", undefined, adminToken)
        assert.equal(admin.status, 200)
        assert.equal(admin.body.isAdmin, true)

        const consumer = await request("GET", "/users/check", undefined, fixture.token)
        assert.equal(consumer.body.isAdmin, false)
        assert.equal(consumer.body.role, "CONSUMER")

        const consumerName = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.consumerId }, select: { name: true } })).name
        assert.equal(consumer.body.name, consumerName)
    })
})

// ---- Complaints (disputes) and refund requests ----

const damagedMessage = "The charger arrived with a cracked casing and does not work."

function complain(context: PaymentTestContext, orderId: number, body: Record<string, unknown> = {}, token = context.fixture.token) {
    return context.request(
        "POST",
        `/orders/${context.checkoutId}/seller-orders/${orderId}/disputes`,
        { reason: "DAMAGED", message: damagedMessage, ...body },
        token
    )
}

async function shipPaidOrder(context: PaymentTestContext, orderId: number) {
    const shipped = await context.request("POST", `/seller/orders/${orderId}/ship`, {}, context.fixture.sellerToken)
    assert.equal(shipped.status, 200)
}

// A paid, shipped order, which is when a buyer can complain about the item.
async function payAndShip(context: PaymentTestContext) {
    const orderId = await payForCheckout(context)
    await shipPaidOrder(context, orderId)
    return orderId
}

async function backdatePayment(checkoutId: number, days: number) {
    await prisma.paymentAttempt.updateMany({
        where: { checkoutId, status: "SUCCESS" },
        data: { verifiedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
    })
}

// A seller who has no connection to the fixture's orders.
async function withStrangerSeller(run: (token: string) => Promise<void>) {
    const stranger = await prisma.user.create({
        data: { name: "Other seller", email: `dispute-stranger-${randomUUID()}@example.test`, passwordHash: "integration-test-not-a-password", role: "SELLER" }
    })

    try {
        await run(jwt.sign({ id: stranger.id }, process.env.JWT_SECRET!))
    } finally {
        await prisma.user.delete({ where: { id: stranger.id } })
    }
}

test("a buyer opens a complaint about a shipped order, and the buyer and seller both see it", async () => {
    await withPaymentCheckout("dispute-open", async (context) => {
        const { fixture, checkoutId, request, adminToken } = context
        const orderId = await payAndShip(context)

        const opened = await complain(context, orderId, { evidenceUrls: ["https://images.example.test/crack.jpg"] })
        assert.equal(opened.status, 201)
        const dispute = opened.body.dispute
        assert.equal(dispute.status, "OPEN")
        assert.equal(dispute.openedBy, "BUYER")
        assert.equal(dispute.reason, "DAMAGED")
        assert.equal(dispute.reasonLabel, "Item damaged")
        assert.equal(dispute.requestedAmount, "3000.00")
        assert.equal(dispute.orderId, orderId)
        assert.equal(dispute.order.seller.businessName, "dispute-open Shop")
        assert.deepEqual(dispute.messages.map((message: { author: string; evidenceUrls: string[] }) => [message.author, message.evidenceUrls]), [
            ["BUYER", ["https://images.example.test/crack.jpg"]]
        ])
        const dueInHours = (new Date(dispute.responseDueAt).getTime() - Date.now()) / 3_600_000
        assert.ok(dueInHours > 71.9 && dueInHours <= 72)
        assert.equal(JSON.stringify(dispute).includes("@example.test"), false)

        // One open complaint per order.
        const again = await complain(context, orderId)
        assert.equal(again.status, 409)
        assert.equal(again.body.code, "DISPUTE_EXISTS")
        assert.equal(again.body.disputeId, dispute.id)

        const mine = await request("GET", "/disputes")
        assert.equal(mine.body.total, 1)
        assert.equal(mine.body.disputes[0].id, dispute.id)
        assert.equal((await request("GET", "/disputes?status=RESOLVED")).body.total, 0)
        assert.equal((await request("GET", "/disputes?status=NOPE")).status, 400)
        assert.equal((await request("GET", `/disputes/${dispute.id}`)).body.dispute.status, "OPEN")

        const sellerList = await request("GET", "/seller/disputes", undefined, fixture.sellerToken)
        assert.equal(sellerList.body.total, 1)
        assert.equal(sellerList.body.disputes[0].buyerName, "Test Consumer")
        assert.equal((await request("GET", "/seller/disputes/awaiting-response", undefined, fixture.sellerToken)).body.count, 1)
        const sellerView = await request("GET", `/seller/disputes/${dispute.id}`, undefined, fixture.sellerToken)
        assert.equal(sellerView.status, 200)
        assert.equal(JSON.stringify(sellerView.body).includes("@example.test"), false)

        // Order pages point to the complaint.
        const buyerOrder = await request("GET", `/orders/${checkoutId}`)
        const { requestedAmount, responseDueAt, createdAt, ...orderDispute } = buyerOrder.body.sellerOrders[0].dispute
        assert.deepEqual(orderDispute, { id: dispute.id, status: "OPEN", outcome: null, reason: "DAMAGED" })
        assert.deepEqual([requestedAmount, typeof responseDueAt, typeof createdAt], ["3000.00", "string", "string"])
        const sellerOrder = await request("GET", `/seller/orders/${orderId}`, undefined, fixture.sellerToken)
        assert.equal(sellerOrder.body.dispute.id, dispute.id)

        // Not yet for an administrator to decide, but visible to them.
        assert.equal((await request("GET", "/admin/disputes", undefined, adminToken)).body.total, 0)
        const adminView = await request("GET", `/admin/disputes/${dispute.id}`, undefined, adminToken)
        assert.match(adminView.body.dispute.buyer.email, /dispute-open-consumer/)
        assert.match(adminView.body.dispute.sellerContact.email, /dispute-open-seller/)
        assert.equal((await request("GET", "/admin/disputes?status=OPEN", undefined, adminToken)).body.total, 1)

        // Only the people it concerns can see it.
        const other = await fixture.addConsumer(1)
        assert.equal((await request("GET", `/disputes/${dispute.id}`, undefined, other.token)).status, 404)
        assert.equal((await request("GET", "/disputes", undefined, other.token)).body.total, 0)
        assert.equal((await request("GET", `/disputes/${dispute.id}`, undefined, fixture.sellerToken)).status, 404)
        assert.equal((await request("GET", "/seller/disputes", undefined, fixture.token)).status, 403)
        await withStrangerSeller(async (strangerToken) => {
            assert.equal((await request("GET", `/seller/disputes/${dispute.id}`, undefined, strangerToken)).status, 404)
        })
    })
})

test("complaints are refused when the order is not in a state that allows them", async () => {
    await withPaymentCheckout("dispute-rules", async (context) => {
        const { checkoutId, request } = context
        const [unpaid] = await prisma.order.findMany({ where: { checkoutId } })
        assert.equal((await complain(context, unpaid!.id)).status, 409)

        const orderId = await payForCheckout(context)

        // Not shipped yet: a damaged item is impossible, and "not received" has to wait.
        const early = await complain(context, orderId)
        assert.equal(early.status, 409)
        assert.equal(early.body.code, "DISPUTE_NOT_ALLOWED")
        const notReceivedEarly = await complain(context, orderId, { reason: "NOT_RECEIVED", message: "Nothing has arrived at all." })
        assert.equal(notReceivedEarly.status, 409)
        assert.match(notReceivedEarly.body.message, /7 days/)

        await backdatePayment(checkoutId, 8)
        const unshipped = await complain(context, orderId, { reason: "NOT_RECEIVED", message: "Nothing has arrived at all." })
        assert.equal(unshipped.status, 201)
        assert.equal((await request("POST", `/disputes/${unshipped.body.dispute.id}/withdraw`)).status, 200)

        // Past the complaint period.
        await shipPaidOrder(context, orderId)
        await backdatePayment(checkoutId, 31)
        const late = await complain(context, orderId)
        assert.equal(late.status, 409)
        assert.match(late.body.message, /30-day/)
        await backdatePayment(checkoutId, 1)

        // Once the buyer confirmed receipt, "not received" is no longer true; other complaints still are.
        await request("POST", `/seller/orders/${orderId}/delivered`, {}, context.fixture.sellerToken)
        const confirm = await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/confirm-delivery`)
        assert.equal(confirm.status, 200)
        const afterReceipt = await complain(context, orderId, { reason: "NOT_RECEIVED", message: "Nothing has arrived at all." })
        assert.equal(afterReceipt.status, 409)
        assert.match(afterReceipt.body.message, /confirmed/)
        assert.equal((await complain(context, orderId)).status, 201)
    })

    await withPaymentCheckout("dispute-rules-refunded", async (context) => {
        const orderId = await payAndShip(context)
        await prisma.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } })
        assert.equal((await complain(context, orderId)).status, 409)
    })
})

test("complaint requests are validated, and the amount cannot exceed what is left to refund", async () => {
    await withPaymentCheckout("dispute-validate", async (context) => {
        const { checkoutId, request } = context
        const orderId = await payAndShip(context)
        const path = `/orders/${checkoutId}/seller-orders/${orderId}/disputes`
        const bad: Array<[Record<string, unknown>, number]> = [
            [{ reason: "NOPE" }, 400],
            [{ reason: "SELLER_REFUND_OFFER" }, 400],
            [{ reason: undefined }, 400],
            [{ message: "Too short" }, 400],
            [{ message: "x".repeat(2001) }, 400],
            [{ message: undefined }, 400],
            [{ evidenceUrls: ["http://insecure.example.test/a.jpg"] }, 400],
            [{ evidenceUrls: ["not a link"] }, 400],
            [{ evidenceUrls: "https://images.example.test/a.jpg" }, 400],
            [{ evidenceUrls: Array.from({ length: 6 }, (_, index) => `https://images.example.test/${index}.jpg`) }, 400],
            [{ amount: "12.345" }, 400],
            [{ amount: -1 }, 400],
            [{ amount: 9000 }, 400]
        ]

        for (const [body, status] of bad) {
            const response = await request("POST", path, { reason: "DAMAGED", message: damagedMessage, ...body })
            assert.equal(response.status, status, JSON.stringify(body))
        }

        const tooMuch = await complain(context, orderId, { amount: 9000 })
        assert.equal(tooMuch.body.code, "DISPUTE_AMOUNT_INVALID")
        assert.equal(tooMuch.body.maximum, "3000.00")
        assert.equal((await request("POST", `/orders/${checkoutId + 1000}/seller-orders/${orderId}/disputes`, { reason: "DAMAGED", message: damagedMessage })).status, 404)
        assert.equal((await request("POST", `/orders/${checkoutId}/seller-orders/999999/disputes`, { reason: "DAMAGED", message: damagedMessage })).status, 404)
        assert.equal(await prisma.dispute.count({ where: { orderId } }), 0)

        const partial = await complain(context, orderId, { amount: "1250.50" })
        assert.equal(partial.status, 201)
        assert.equal(partial.body.dispute.requestedAmount, "1250.50")
    })
})

test("a seller agrees to a refund or disagrees, and either way an administrator decides", async () => {
    await withPaymentCheckout("dispute-respond", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payAndShip(context)
        const opened = await complain(context, orderId)
        const id = opened.body.dispute.id as number
        const respond = (body: Record<string, unknown>, token = fixture.sellerToken) =>
            request("POST", `/seller/disputes/${id}/respond`, body, token)

        assert.equal((await respond({ action: "MAYBE", message: "I will think about it." })).status, 400)
        assert.equal((await respond({ action: "AGREE_TO_REFUND", message: "Too short" })).status, 400)
        assert.equal((await respond({ action: "AGREE_TO_REFUND", message: "I agree to refund." }, fixture.token)).status, 403)
        await withStrangerSeller(async (strangerToken) => {
            assert.equal((await respond({ action: "AGREE_TO_REFUND", message: "I agree to refund." }, strangerToken)).status, 404)
        })
        assert.equal((await prisma.dispute.findUniqueOrThrow({ where: { id } })).status, "OPEN")

        const agreed = await respond({ action: "AGREE_TO_REFUND", message: "I am sorry about that, please refund the buyer." })
        assert.equal(agreed.status, 200)
        assert.equal(agreed.body.dispute.status, "SELLER_AGREED")
        assert.ok(agreed.body.dispute.sellerRespondedAt)
        assert.deepEqual(agreed.body.dispute.messages.map((message: { author: string }) => message.author), ["BUYER", "SELLER"])
        assert.equal((await request("GET", "/seller/disputes/awaiting-response", undefined, fixture.sellerToken)).body.count, 0)

        const repeated = await respond({ action: "DISAGREE", message: "Actually, I do not agree." })
        assert.equal(repeated.status, 409)
        assert.equal(repeated.body.code, "DISPUTE_NOT_OPEN")

        const queue = await request("GET", "/admin/disputes", undefined, adminToken)
        assert.deepEqual(queue.body.disputes.map((item: { id: number }) => item.id), [id])
    })

    await withPaymentCheckout("dispute-disagree", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number

        const disagreed = await request("POST", `/seller/disputes/${id}/respond`, {
            action: "DISAGREE",
            message: "The item was packed carefully and photographed before dispatch.",
            evidenceUrls: ["https://images.example.test/packed.jpg"]
        }, fixture.sellerToken)
        assert.equal(disagreed.body.dispute.status, "UNDER_REVIEW")
        assert.ok(disagreed.body.dispute.escalatedAt)
        assert.equal((await request("GET", "/admin/disputes", undefined, adminToken)).body.total, 1)
    })
})

test("the buyer, seller and administrator share one thread, which closes with the complaint", async () => {
    await withPaymentCheckout("dispute-thread", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        const post = (path: string, token: string, message = "Here is some more detail for you.", extra: Record<string, unknown> = {}) =>
            request("POST", path, { message, ...extra }, token)

        assert.equal((await post(`/disputes/${id}/messages`, fixture.token, "Here is the second photo.", { evidenceUrls: ["https://images.example.test/two.jpg"] })).status, 201)
        assert.equal((await post(`/seller/disputes/${id}/messages`, fixture.sellerToken)).status, 201)
        assert.equal((await post(`/admin/disputes/${id}/messages`, adminToken, "Please send the order packaging photo.")).status, 201)
        const thread = await request("GET", `/disputes/${id}`)
        assert.deepEqual(thread.body.dispute.messages.map((message: { author: string }) => message.author), ["BUYER", "BUYER", "SELLER", "ADMIN"])

        assert.equal((await post(`/disputes/${id}/messages`, fixture.token, "short")).status, 400)
        assert.equal((await post(`/disputes/${id}/messages`, fixture.token, undefined, { evidenceUrls: ["ftp://nope.example.test/a"] })).status, 400)
        assert.equal((await post(`/disputes/${id}/messages`, fixture.sellerToken)).status, 404)
        assert.equal((await post(`/admin/disputes/${id}/messages`, fixture.token)).status, 403)
        const other = await fixture.addConsumer(1)
        assert.equal((await post(`/disputes/${id}/messages`, other.token)).status, 404)
        await withStrangerSeller(async (strangerToken) => {
            assert.equal((await post(`/seller/disputes/${id}/messages`, strangerToken)).status, 404)
        })

        // A thread has a size limit.
        const existing = await prisma.disputeMessage.count({ where: { disputeId: id } })
        await prisma.disputeMessage.createMany({
            data: Array.from({ length: 50 - existing }, () => ({ disputeId: id, author: "SYSTEM" as const, body: "Filler message for the limit test." }))
        })
        const full = await post(`/disputes/${id}/messages`, fixture.token)
        assert.equal(full.status, 409)
        assert.equal(full.body.code, "DISPUTE_MESSAGE_LIMIT")
    })
})

test("a buyer can withdraw a complaint and open a new one, but not take back someone else's", async () => {
    await withPaymentCheckout("dispute-withdraw", async (context) => {
        const { fixture, request } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number

        assert.equal((await request("POST", `/seller/disputes/${id}/withdraw`, {}, fixture.sellerToken)).status, 404)
        const withdrawn = await request("POST", `/disputes/${id}/withdraw`)
        assert.equal(withdrawn.status, 200)
        assert.equal(withdrawn.body.dispute.status, "WITHDRAWN")
        assert.equal(withdrawn.body.dispute.messages.at(-1).author, "SYSTEM")

        const closed = await request("POST", `/disputes/${id}/messages`, { message: "Can I still write here?" })
        assert.equal(closed.status, 409)
        assert.equal(closed.body.code, "DISPUTE_CLOSED")
        assert.equal((await request("POST", `/disputes/${id}/withdraw`)).status, 409)

        const fresh = await complain(context, orderId, { message: "On reflection the item really is faulty." })
        assert.equal(fresh.status, 201)
        const order = await request("GET", `/orders/${context.checkoutId}`)
        assert.equal(order.body.sellerOrders[0].dispute.id, fresh.body.dispute.id)
    })
})

test("a seller can offer a refund without the buyer asking, and take the offer back", async () => {
    await withPaymentCheckout("dispute-offer", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payForCheckout(context)
        const offer = (body: Record<string, unknown>, token = fixture.sellerToken) =>
            request("POST", `/seller/orders/${orderId}/refund-offer`, body, token)

        assert.equal((await offer({ message: "Too short" })).status, 400)
        assert.equal((await offer({ message: "I cannot supply this item any more.", amount: 9000 })).status, 400)
        assert.equal((await offer({ message: "I cannot supply this item any more." }, fixture.token)).status, 403)
        await withStrangerSeller(async (strangerToken) => {
            assert.equal((await offer({ message: "I cannot supply this item any more." }, strangerToken)).status, 404)
        })

        // The order has not even shipped, which is fine for an offer.
        const offered = await offer({ message: "I cannot supply this item any more.", amount: "1000" })
        assert.equal(offered.status, 201)
        const dispute = offered.body.dispute
        assert.equal(dispute.openedBy, "SELLER")
        assert.equal(dispute.reason, "SELLER_REFUND_OFFER")
        assert.equal(dispute.status, "SELLER_AGREED")
        assert.equal(dispute.requestedAmount, "1000.00")
        assert.equal((await offer({ message: "I cannot supply this item any more." })).body.code, "DISPUTE_EXISTS")

        const buyerView = await request("GET", `/disputes/${dispute.id}`)
        assert.equal(buyerView.status, 200)
        assert.equal((await request("GET", "/admin/disputes", undefined, adminToken)).body.total, 1)
        assert.equal((await request("POST", `/disputes/${dispute.id}/withdraw`)).status, 404)

        const withdrawn = await request("POST", `/seller/disputes/${dispute.id}/withdraw`, {}, fixture.sellerToken)
        assert.equal(withdrawn.body.dispute.status, "WITHDRAWN")
        assert.equal(withdrawn.body.dispute.messages.at(-1).body, "The seller withdrew this refund offer.")
    })
})

test("complaints the seller has not answered in time are passed to an administrator", async () => {
    await withPaymentCheckout("dispute-overdue", async (context) => {
        const { request, adminToken } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number

        assert.equal(await escalateOverdueDisputes(), 0)
        await prisma.dispute.update({ where: { id }, data: { responseDueAt: new Date(Date.now() - 1000) } })
        assert.equal(await escalateOverdueDisputes(), 1)

        const escalated = await prisma.dispute.findUniqueOrThrow({ where: { id }, include: { messages: true } })
        assert.equal(escalated.status, "UNDER_REVIEW")
        assert.ok(escalated.escalatedAt)
        assert.equal(escalated.messages.at(-1)?.author, "SYSTEM")
        assert.match(escalated.messages.at(-1)?.body ?? "", /did not answer in time/)
        assert.equal(await escalateOverdueDisputes(), 0)
        assert.equal((await request("GET", "/admin/disputes", undefined, adminToken)).body.total, 1)
    })

    // A complaint the seller already answered is left as it is.
    await withPaymentCheckout("dispute-overdue-answered", async (context) => {
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        await context.request("POST", `/seller/disputes/${id}/respond`, { action: "AGREE_TO_REFUND", message: "Please refund the buyer." }, context.fixture.sellerToken)
        await prisma.dispute.update({ where: { id }, data: { responseDueAt: new Date(Date.now() - 1000) } })
        assert.equal(await escalateOverdueDisputes(), 0)
        assert.equal((await prisma.dispute.findUniqueOrThrow({ where: { id } })).status, "SELLER_AGREED")
    })
})

test("an administrator approves a complaint by refunding the order, which closes it", async () => {
    await withPaymentCheckout("dispute-approve", async (context) => {
        const { fixture, checkoutId, request, adminToken, fakes } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        await request("POST", `/seller/disputes/${id}/respond`, { action: "DISAGREE", message: "The item was fine when it left me." }, fixture.sellerToken)

        const approve = (body: Record<string, unknown>, token = adminToken) => request("POST", `/admin/disputes/${id}/approve`, body, token)
        assert.equal((await approve({ note: "Approved after review." }, fixture.token)).status, 403)
        assert.equal((await approve({})).status, 400)
        assert.equal((await approve({ note: "Short" })).status, 400)
        assert.equal((await approve({ note: "Approved after review.", amount: "abc" })).status, 400)
        assert.equal((await approve({ note: "Approved after review.", restock: "yes" })).status, 400)
        assert.equal((await request("POST", "/admin/disputes/999999/approve", { note: "Approved after review." }, adminToken)).status, 404)
        assert.equal(fakes.calls.createRefund.length, 0)

        const approved = await approve({ note: "Photos show the damage, so the buyer is refunded.", customerNote: "Sorry about the damaged item" })
        assert.equal(approved.status, 201)
        assert.equal(approved.body.refund.amount, "3000.00")
        assert.equal(approved.body.refund.status, "PROCESSING")
        const dispute = approved.body.dispute
        assert.equal(dispute.status, "RESOLVED")
        assert.equal(dispute.outcome, "REFUNDED")
        assert.equal(dispute.approvedAmount, "3000.00")
        assert.deepEqual(dispute.messages.map((message: { author: string }) => message.author), ["BUYER", "SELLER", "SYSTEM", "ADMIN"])
        assert.match(dispute.messages[2].body, /approved a refund of ₦3000\.00/)

        const refund = await prisma.refund.findUniqueOrThrow({ where: { reference: approved.body.refund.reference } })
        assert.equal(refund.disputeId, id)
        assert.equal(refund.reason, `Complaint ${id}: Item damaged`)
        assert.equal(await prisma.sellerLiability.count({ where: { refundId: refund.id } }), 1)

        const buyerView = await request("GET", `/disputes/${id}`)
        assert.deepEqual(buyerView.body.dispute.refunds.map((item: { status: string; note: string }) => [item.status, item.note]), [["PROCESSING", "Sorry about the damaged item"]])
        assert.equal(JSON.stringify(buyerView.body).includes("Complaint "), false)
        const sellerView = await request("GET", `/seller/disputes/${id}`, undefined, fixture.sellerToken)
        assert.equal(sellerView.body.dispute.refunds[0].reason, `Complaint ${id}: Item damaged`)
        assert.equal((await request("GET", `/orders/${checkoutId}`)).body.sellerOrders[0].dispute.outcome, "REFUNDED")

        assert.equal((await approve({ note: "Approving it a second time." })).status, 409)
        assert.equal((await request("POST", `/disputes/${id}/messages`, { message: "Thank you for the refund." })).status, 409)
    })

    await withPaymentCheckout("dispute-approve-partial", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        await request("POST", `/seller/disputes/${id}/respond`, { action: "AGREE_TO_REFUND", message: "Please refund the buyer." }, fixture.sellerToken)

        const approved = await request("POST", `/admin/disputes/${id}/approve`, { note: "A partial refund is fair here.", amount: 1000, chargeSeller: false }, adminToken)
        assert.equal(approved.status, 201)
        assert.equal(approved.body.refund.amount, "1000.00")
        assert.equal(approved.body.dispute.approvedAmount, "1000.00")
        assert.equal(await prisma.sellerLiability.count({ where: { sellerId: fixture.sellerId } }), 0)
    })
})

test("a complaint stays open when the refund cannot be started, and closes once the refund is found", async (t) => {
    t.mock.method(console, "error", () => {})

    await withPaymentCheckout("dispute-refund-fails", async (context) => {
        const { checkoutId, request, adminToken, fakes } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        const approve = () => request("POST", `/admin/disputes/${id}/approve`, { note: "Approved after review of the photos." }, adminToken)

        fakes.behaviors.PAYSTACK.createRefund = async () => {
            throw new PaymentProviderError("rejected", "Paystack rejected the request", "HTTP 400: Invalid transaction")
        }
        const rejected = await approve()
        assert.equal(rejected.status, 502)
        assert.equal(rejected.body.code, "REFUND_PROVIDER_REJECTED")
        assert.equal((await prisma.dispute.findUniqueOrThrow({ where: { id } })).status, "OPEN")

        // The outcome is unknown: the refund exists and is tied to the complaint, but nothing is closed.
        fakes.behaviors.PAYSTACK.createRefund = async () => {
            throw new PaymentProviderError("unavailable", "Paystack could not be reached", "TimeoutError")
        }
        const unknown = await approve()
        assert.equal(unknown.status, 502)
        assert.equal(unknown.body.code, "REFUND_PROVIDER_UNAVAILABLE")
        const pending = await prisma.refund.findUniqueOrThrow({ where: { reference: unknown.body.refundReference } })
        assert.equal(pending.disputeId, id)
        assert.equal((await prisma.dispute.findUniqueOrThrow({ where: { id } })).status, "OPEN")

        const found = fakeProviderRefund({ amountKobo: 300000 })
        fakes.behaviors.PAYSTACK.findRefunds = async () => [found]
        await request("POST", `/admin/refunds/${pending.id}/sync`, undefined, adminToken)
        const closed = await prisma.dispute.findUniqueOrThrow({ where: { id } })
        assert.equal(closed.status, "RESOLVED")
        assert.equal(closed.outcome, "REFUNDED")
        assert.equal(closed.approvedAmount?.toFixed(2), "3000.00")
        assert.equal((await request("GET", `/orders/${checkoutId}`)).body.sellerOrders[0].dispute.status, "RESOLVED")
    })

    await withPaymentCheckout("dispute-refund-balance", async (context) => {
        const { request, adminToken, fakes } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        fakes.behaviors.PAYSTACK.balance = async () => 100000

        const warned = await request("POST", `/admin/disputes/${id}/approve`, { note: "Approved after review of the photos." }, adminToken)
        assert.equal(warned.status, 409)
        assert.equal(warned.body.code, "REFUND_BALANCE_LOW")
        assert.equal((await prisma.dispute.findUniqueOrThrow({ where: { id } })).status, "OPEN")

        const confirmed = await request("POST", `/admin/disputes/${id}/approve`, { note: "Approved after review of the photos.", acknowledgeLowBalance: true }, adminToken)
        assert.equal(confirmed.status, 201)
    })
})

test("a refund an administrator issues directly also closes the order's open complaint", async () => {
    await withPaymentCheckout("dispute-direct-refund", async (context) => {
        const { request } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number

        const refund = await refundOrder(context, orderId, { amount: 1500 })
        assert.equal(refund.status, 201)
        const closed = await prisma.dispute.findUniqueOrThrow({ where: { id } })
        assert.equal(closed.status, "RESOLVED")
        assert.equal(closed.outcome, "REFUNDED")
        assert.equal(closed.approvedAmount?.toFixed(2), "1500.00")
        assert.equal((await request("GET", `/disputes/${id}`)).body.dispute.status, "RESOLVED")
    })
})

test("an administrator can reject a complaint with a note both sides read, and it cannot be re-opened", async () => {
    await withPaymentCheckout("dispute-reject", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        const reject = (body: Record<string, unknown>, token = adminToken) => request("POST", `/admin/disputes/${id}/reject`, body, token)

        assert.equal((await reject({ note: "No evidence of damage was provided." }, fixture.token)).status, 403)
        assert.equal((await reject({})).status, 400)
        assert.equal((await reject({ note: "Short" })).status, 400)
        assert.equal((await request("POST", "/admin/disputes/999999/reject", { note: "No evidence of damage was provided." }, adminToken)).status, 404)

        const rejected = await reject({ note: "No evidence of damage was provided, so this complaint is rejected." })
        assert.equal(rejected.status, 200)
        assert.equal(rejected.body.dispute.status, "RESOLVED")
        assert.equal(rejected.body.dispute.outcome, "REJECTED")
        assert.equal(rejected.body.dispute.decisionNote, "No evidence of damage was provided, so this complaint is rejected.")
        assert.equal(rejected.body.dispute.messages.at(-1).author, "ADMIN")
        assert.equal((await request("GET", `/disputes/${id}`)).body.dispute.decisionNote, rejected.body.dispute.decisionNote)
        assert.equal((await reject({ note: "Rejecting a closed complaint again." })).status, 409)
        assert.equal(await prisma.refund.count({ where: { orderId } }), 0)

        const reopened = await complain(context, orderId)
        assert.equal(reopened.status, 409)
        assert.equal(reopened.body.code, "DISPUTE_ALREADY_DECIDED")
        // The seller can still choose to offer a refund later.
        const offer = await request("POST", `/seller/orders/${orderId}/refund-offer`, { message: "On reflection, I will refund this order." }, fixture.sellerToken)
        assert.equal(offer.status, 201)
    })
})

test("the administrator's complaint queue shows what needs a decision, oldest filters on request", async () => {
    await withPaymentCheckout("dispute-queue", async (context) => {
        const { request, adminToken } = context
        const orderId = await payAndShip(context)
        await complain(context, orderId)

        assert.equal((await request("GET", "/admin/disputes", undefined, adminToken)).body.total, 0)
        assert.equal((await request("GET", "/admin/disputes?status=OPEN", undefined, adminToken)).body.total, 1)
        assert.equal((await request("GET", "/admin/disputes?status=NOPE", undefined, adminToken)).status, 400)
        assert.equal((await request("GET", "/admin/disputes?page=0", undefined, adminToken)).status, 400)
        assert.equal((await request("GET", "/admin/disputes/abc", undefined, adminToken)).status, 404)
        assert.equal((await request("GET", "/admin/disputes/999999", undefined, adminToken)).status, 404)
    })
})

// ---- Sessions: short access token, rotating refresh token ----

type SessionContext = {
    userId: number
    email: string
    password: string
    baseUrl: string
}

function cookiesFrom(response: Response): Record<string, { value: string; attributes: string }> {
    const cookies: Record<string, { value: string; attributes: string }> = {}

    for (const line of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = line.split(";")
        const separator = pair.indexOf("=")
        cookies[pair.slice(0, separator)] = { value: pair.slice(separator + 1), attributes: attributes.join(";") }
    }

    return cookies
}

async function withSessionUser(run: (context: SessionContext) => Promise<void>) {
    const password = "a-long-test-password"
    const email = `session-${randomUUID()}@example.test`
    const user = await prisma.user.create({
        data: { name: "Session user", email, passwordHash: await bcrypt.hash(password, 4), role: "CONSUMER", emailVerifiedAt: new Date() }
    })
    const server = createServer(app)

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    try {
        const address = server.address()
        assert.ok(address && typeof address === "object")
        await run({ userId: user.id, email, password, baseUrl: `http://127.0.0.1:${address.port}` })
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        await prisma.user.deleteMany({ where: { id: user.id } })
    }
}

function postJson(baseUrl: string, path: string, body: Record<string, unknown>, cookie?: string) {
    return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body)
    })
}

// Logs in the way a person does on a device we do not know: password, then the emailed code.
async function loginForSession(context: SessionContext) {
    const passwordStep = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
    assert.equal(passwordStep.status, 200)
    assert.equal((await passwordStep.json() as { otpRequired?: boolean }).otpRequired, true)
    const response = await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: codeSentTo(context.email) })
    assert.equal(response.status, 200)
    const cookies = cookiesFrom(response)
    const access = cookies.token?.value
    const refresh = cookies.refreshToken?.value
    assert.ok(access && refresh)
    return { access, refresh, cookies }
}

function refreshSessionRequest(context: SessionContext, refreshToken: string) {
    return fetch(`${context.baseUrl}/users/refresh`, { method: "POST", headers: { cookie: `refreshToken=${refreshToken}` } })
}

test("logging in gives a 15-minute access cookie and a 30-day refresh cookie that only the account routes receive", async () => {
    await withSessionUser(async (context) => {
        const { refresh, cookies } = await loginForSession(context)

        assert.match(cookies.token?.attributes ?? "", /Max-Age=900\b/)
        assert.match(cookies.token?.attributes ?? "", /HttpOnly/)
        assert.match(cookies.refreshToken?.attributes ?? "", /Max-Age=259\d{4}\b/)
        assert.match(cookies.refreshToken?.attributes ?? "", /Path=\/users/)
        assert.match(cookies.refreshToken?.attributes ?? "", /HttpOnly/)

        // Only a hash of the refresh token is stored.
        const stored = await prisma.refreshToken.findMany({ where: { userId: context.userId } })
        assert.equal(stored.length, 1)
        assert.notEqual(stored[0]?.tokenHash, refresh)
        assert.equal(stored[0]?.revokedAt, null)
    })
})

test("registering sends a code and does not log in; the code confirms the account and logs in", async () => {
    await withAppServer(async (baseUrl) => {
        const email = `registered-${randomUUID()}@example.test`

        try {
            const response = await register(baseUrl, { name: "New person", email, password: goodPassword, role: "CONSUMER" })
            assert.equal(response.status, 200)
            assert.equal(response.headers.getSetCookie().length, 0)
            assert.deepEqual(await response.json(), { message: "Check your email for a code to finish creating your account", email })

            const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { cart: true } })
            assert.equal(user.emailVerifiedAt, null)
            assert.ok(user.cart)
            assert.equal(emailsTo(email).length, 1)
            assert.match(emailsTo(email)[0]?.subject ?? "", /Confirm your email: \d{6}/)

            // Until the email is confirmed the account cannot log in, even with the right password.
            const blocked = await postJson(baseUrl, "/users/login", { email, password: goodPassword })
            assert.equal(blocked.status, 403)
            assert.equal((await blocked.json() as { code: string }).code, "EMAIL_NOT_VERIFIED")
            assert.equal(blocked.headers.getSetCookie().length, 0)

            const wrong = await postJson(baseUrl, "/users/verify-email", { email, code: "000000" })
            assert.equal(wrong.status, 400)
            assert.deepEqual(await wrong.json(), { message: "That code is not right or has expired. Ask for a new one." })

            const code = codeSentTo(email)
            const confirmed = await postJson(baseUrl, "/users/verify-email", { email: email.toUpperCase(), code })
            assert.equal(confirmed.status, 200)
            assert.equal((await confirmed.json() as { role: string }).role, "CONSUMER")
            const cookies = cookiesFrom(confirmed)
            assert.ok(cookies.token?.value && cookies.refreshToken?.value && cookies.trustedDevice?.value)
            assert.ok((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt)

            // The code works once.
            assert.equal((await postJson(baseUrl, "/users/verify-email", { email, code })).status, 400)

            // This browser was just proven, so logging in from it needs no code.
            const later = await postJson(baseUrl, "/users/login", { email, password: goodPassword }, `trustedDevice=${cookies.trustedDevice.value}`)
            assert.equal(later.status, 200)
            assert.equal((await later.json() as { role: string }).role, "CONSUMER")
            assert.ok(cookiesFrom(later).token?.value)
        } finally {
            await deleteRegistered([email])
        }
    })
})

test("signing up with an address that already has an account looks the same, changes nothing and warns the owner", async () => {
    await withSessionUser(async (context) => {
        const freshEmail = `fresh-${randomUUID()}@example.test`

        try {
            const existing = await register(context.baseUrl, { name: "Impostor", email: context.email.toUpperCase(), password: "impostor-password-1", role: "SELLER" })
            const fresh = await register(context.baseUrl, { name: "Someone", email: freshEmail, password: goodPassword, role: "CONSUMER" })
            assert.equal(existing.status, 200)
            assert.equal(fresh.status, 200)
            assert.equal((await existing.json() as { message: string }).message, (await fresh.json() as { message: string }).message)

            const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: context.userId } })
            assert.equal(unchanged.role, "CONSUMER")
            assert.ok(await bcrypt.compare(context.password, unchanged.passwordHash))
            assert.equal(emailsTo(context.email).at(-1)?.subject, "You already have a StoreHatch account")
            assert.equal(await prisma.emailOtp.count({ where: { userId: context.userId, purpose: "VERIFY_EMAIL" } }), 0)
        } finally {
            await deleteRegistered([freshEmail])
        }
    })
})

test("signing up again before confirming starts over with the new details and an unused old code stops working", async () => {
    await withAppServer(async (baseUrl) => {
        const email = `again-${randomUUID()}@example.test`

        try {
            await register(baseUrl, { name: "First try", email, password: goodPassword, role: "CONSUMER" })
            const firstCode = codeSentTo(email)
            await register(baseUrl, { name: "Second try", email, password: "a-different-password", role: "SELLER" })
            const secondCode = codeSentTo(email)
            assert.notEqual(firstCode, secondCode)

            const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { cart: true } })
            assert.equal(user.name, "Second try")
            assert.equal(user.role, "SELLER")
            assert.equal(user.cart, null)
            assert.ok(await bcrypt.compare("a-different-password", user.passwordHash))
            assert.equal(await prisma.user.count({ where: { email } }), 1)

            assert.equal((await postJson(baseUrl, "/users/verify-email", { email, code: firstCode })).status, 400)
            assert.equal((await postJson(baseUrl, "/users/verify-email", { email, code: secondCode })).status, 200)
        } finally {
            await deleteRegistered([email])
        }
    })
})

test("a refresh token is swapped for a new pair that works, and the old one stops working", async () => {
    await withSessionUser(async (context) => {
        const { refresh } = await loginForSession(context)
        const refreshed = await refreshSessionRequest(context, refresh)
        assert.equal(refreshed.status, 200)
        const body = await refreshed.json()
        assert.equal(body.role, "CONSUMER")
        assert.equal(body.isAdmin, false)

        const cookies = cookiesFrom(refreshed)
        assert.ok(cookies.token?.value && cookies.refreshToken?.value)
        assert.notEqual(cookies.refreshToken?.value, refresh)

        const check = await fetch(`${context.baseUrl}/users/check`, { headers: { cookie: `token=${cookies.token.value}` } })
        assert.equal(check.status, 200)

        // The new refresh token keeps the original expiry, so a login cannot be extended forever.
        const tokens = await prisma.refreshToken.findMany({ where: { userId: context.userId }, orderBy: { id: "asc" } })
        assert.equal(tokens.length, 2)
        assert.equal(tokens[0]?.revokedReason, "ROTATED")
        assert.equal(tokens[1]?.expiresAt.getTime(), tokens[0]?.expiresAt.getTime())
        assert.equal(tokens[0]?.familyId, tokens[1]?.familyId)
    })
})

test("a refresh token used twice at once is refused the second time without ending the login", async () => {
    await withSessionUser(async (context) => {
        const { refresh } = await loginForSession(context)
        const first = await refreshSessionRequest(context, refresh)
        assert.equal(first.status, 200)
        const newRefresh = cookiesFrom(first).refreshToken?.value
        assert.ok(newRefresh)

        // The same token again, moments later: another tab lost the race.
        const second = await refreshSessionRequest(context, refresh)
        assert.equal(second.status, 401)

        const stillWorks = await refreshSessionRequest(context, newRefresh)
        assert.equal(stillWorks.status, 200)
    })
})

test("an old refresh token used long after it was swapped ends every login in its family", async () => {
    await withSessionUser(async (context) => {
        const { refresh } = await loginForSession(context)
        const first = await refreshSessionRequest(context, refresh)
        const newRefresh = cookiesFrom(first).refreshToken?.value
        assert.ok(newRefresh)

        await prisma.refreshToken.updateMany({
            where: { userId: context.userId, revokedReason: "ROTATED" },
            data: { revokedAt: new Date(Date.now() - 60 * 1000) }
        })

        // Someone presents the swapped-out token: it can only have been copied, so the new one dies too.
        const stolen = await refreshSessionRequest(context, refresh)
        assert.equal(stolen.status, 401)
        const legitimate = await refreshSessionRequest(context, newRefresh)
        assert.equal(legitimate.status, 401)

        const live = await prisma.refreshToken.count({ where: { userId: context.userId, revokedAt: null } })
        assert.equal(live, 0)
    })
})

test("refreshing is refused without a refresh token, for an unknown one, and for an expired one", async () => {
    await withSessionUser(async (context) => {
        const none = await fetch(`${context.baseUrl}/users/refresh`, { method: "POST" })
        assert.equal(none.status, 401)
        assert.deepEqual(await none.json(), { message: "Your session has ended. Please log in again." })

        const unknown = await refreshSessionRequest(context, "not-a-real-token")
        assert.equal(unknown.status, 401)

        const { refresh } = await loginForSession(context)
        await prisma.refreshToken.updateMany({ where: { userId: context.userId }, data: { expiresAt: new Date(Date.now() - 1000) } })
        const expired = await refreshSessionRequest(context, refresh)
        assert.equal(expired.status, 401)
    })
})

test("logging out ends that device's login but not another device's", async () => {
    await withSessionUser(async (context) => {
        const laptop = await loginForSession(context)
        const phone = await loginForSession(context)

        const logout = await fetch(`${context.baseUrl}/users/logout`, {
            method: "POST",
            headers: { cookie: `refreshToken=${laptop.refresh}` }
        })
        assert.equal(logout.status, 200)
        assert.equal(cookiesFrom(logout).refreshToken?.value, "")

        assert.equal((await refreshSessionRequest(context, laptop.refresh)).status, 401)
        assert.equal((await refreshSessionRequest(context, phone.refresh)).status, 200)
    })
})

test("logging out everywhere ends every device's login and needs a login itself", async () => {
    await withSessionUser(async (context) => {
        const laptop = await loginForSession(context)
        const phone = await loginForSession(context)

        const anonymous = await fetch(`${context.baseUrl}/users/logout-all`, { method: "POST" })
        assert.equal(anonymous.status, 401)

        const response = await fetch(`${context.baseUrl}/users/logout-all`, {
            method: "POST",
            headers: { cookie: `token=${laptop.access}` }
        })
        assert.equal(response.status, 200)

        assert.equal((await refreshSessionRequest(context, laptop.refresh)).status, 401)
        assert.equal((await refreshSessionRequest(context, phone.refresh)).status, 401)
    })
})

test("old expired and revoked login records are cleaned up, recent ones are kept", async () => {
    await withSessionUser(async (context) => {
        const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        const base = { userId: context.userId, familyId: randomUUID(), expiresAt: new Date(Date.now() + 60 * 1000) }
        await prisma.refreshToken.createMany({
            data: [
                { ...base, tokenHash: `old-expired-${randomUUID()}`, expiresAt: longAgo },
                { ...base, tokenHash: `old-revoked-${randomUUID()}`, revokedAt: longAgo, revokedReason: "LOGOUT" },
                { ...base, tokenHash: `recent-revoked-${randomUUID()}`, revokedAt: new Date(), revokedReason: "LOGOUT" },
                { ...base, tokenHash: `live-${randomUUID()}` }
            ]
        })

        assert.ok((await purgeOldRefreshTokens()) >= 2)
        const remaining = await prisma.refreshToken.findMany({ where: { userId: context.userId } })
        assert.equal(remaining.length, 2)
        assert.ok(remaining.every((token) => !token.tokenHash.startsWith("old-")))
    })
})

function checkWithAccess(context: SessionContext, accessToken: string) {
    return fetch(`${context.baseUrl}/users/check`, { headers: { cookie: `token=${accessToken}` } })
}

test("logging out stops that device's access token at once, not when it expires", async () => {
    await withSessionUser(async (context) => {
        const laptop = await loginForSession(context)
        const phone = await loginForSession(context)
        assert.equal((await checkWithAccess(context, laptop.access)).status, 200)

        await fetch(`${context.baseUrl}/users/logout`, { method: "POST", headers: { cookie: `refreshToken=${laptop.refresh}` } })

        const ended = await checkWithAccess(context, laptop.access)
        assert.equal(ended.status, 401)
        assert.deepEqual(await ended.json(), { message: "Your session has ended. Please log in again." })
        assert.equal((await checkWithAccess(context, phone.access)).status, 200)
    })
})

test("logging out everywhere stops every earlier access token at once but not a new login", async () => {
    await withSessionUser(async (context) => {
        const laptop = await loginForSession(context)
        const phone = await loginForSession(context)
        // A token from before sessions had login ids, still inside its lifetime.
        const jwtSecret = process.env.JWT_SECRET
        assert.ok(jwtSecret)
        const older = jwt.sign({ id: context.userId, iat: Math.floor(Date.now() / 1000) - 30 }, jwtSecret, { expiresIn: 600 })
        assert.equal((await checkWithAccess(context, older)).status, 200)

        const response = await fetch(`${context.baseUrl}/users/logout-all`, { method: "POST", headers: { cookie: `token=${laptop.access}` } })
        assert.equal(response.status, 200)

        assert.equal((await checkWithAccess(context, laptop.access)).status, 401)
        assert.equal((await checkWithAccess(context, phone.access)).status, 401)
        assert.equal((await checkWithAccess(context, older)).status, 401)

        const again = await loginForSession(context)
        assert.equal((await checkWithAccess(context, again.access)).status, 200)
    })
})

test("a copied refresh token being reused stops the whole login's access tokens at once", async () => {
    await withSessionUser(async (context) => {
        const first = await loginForSession(context)
        const swapped = await refreshSessionRequest(context, first.refresh)
        const newAccess = cookiesFrom(swapped).token?.value
        assert.ok(newAccess)
        assert.equal((await checkWithAccess(context, newAccess)).status, 200)

        await prisma.refreshToken.updateMany({
            where: { userId: context.userId, revokedReason: "ROTATED" },
            data: { revokedAt: new Date(Date.now() - 60 * 1000) }
        })
        assert.equal((await refreshSessionRequest(context, first.refresh)).status, 401)

        assert.equal((await checkWithAccess(context, newAccess)).status, 401)
        assert.equal((await checkWithAccess(context, first.access)).status, 401)
    })
})

test("an access token for an account that no longer exists is refused", async () => {
    await withSessionUser(async (context) => {
        const { access } = await loginForSession(context)
        await prisma.user.delete({ where: { id: context.userId } })
        assert.equal((await checkWithAccess(context, access)).status, 401)
        // The fixture cleanup deletes by id and tolerates the account being gone already.
    })
})

// ---- Registration and login rules ----

const goodPassword = "a-long-test-password"

function register(baseUrl: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/users/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    })
}

async function deleteRegistered(emails: string[]) {
    await prisma.cart.deleteMany({ where: { user: { email: { in: emails } } } })
    await prisma.sellerProfile.deleteMany({ where: { user: { email: { in: emails } } } })
    await prisma.user.deleteMany({ where: { email: { in: emails } } })
}

test("registration refuses weak passwords, bad emails, bad names and any role but shopper or seller", async () => {
    await withAppServer(async (baseUrl) => {
        const email = `rules-${randomUUID()}@example.test`
        const valid = { name: "Ada Obi", email, password: goodPassword, role: "CONSUMER" }
        const refused = async (changes: Record<string, unknown>, message: string | RegExp) => {
            const response = await register(baseUrl, { ...valid, ...changes })
            assert.equal(response.status, 400, JSON.stringify(changes))
            const body = await response.json() as { message: string }
            assert.match(body.message, message instanceof RegExp ? message : new RegExp(message))
        }

        await refused({ password: "short" }, "at least 10 characters")
        await refused({ password: "123456789" }, "at least 10 characters")
        await refused({ password: "Password123" }, "too common")
        await refused({ password: "qwertyuiop" }, "too common")
        await refused({ password: "aaaaaaaaaaaa" }, "too common")
        await refused({ password: "x".repeat(80) }, "72 bytes")
        await refused({ password: email }, "same as your email")
        await refused({ password: 12345678901234 }, "Enter a password")
        await refused({ email: "not-an-email" }, "valid email")
        await refused({ email: "two@@example.test" }, "valid email")
        await refused({ email: `${"a".repeat(250)}@example.test` }, "valid email")
        await refused({ email: { $ne: null } }, "valid email")
        await refused({ name: "n".repeat(81) }, "80 characters")
        await refused({ name: "   " }, /name|required/i)
        await refused({ name: ["Ada"] }, "Enter your name")
        await refused({ role: "ADMIN" }, "CONSUMER or SELLER")
        await refused({ role: "consumer" }, "CONSUMER or SELLER")
        await refused({ role: { x: 1 } }, "CONSUMER or SELLER")

        assert.equal(await prisma.user.count({ where: { email } }), 0)
    })
})

test("registration stores the email trimmed and lowercase, so capital letters make no second account", async () => {
    await withAppServer(async (baseUrl) => {
        const local = `mixed-${randomUUID()}`
        const stored = `${local}@example.test`.toLowerCase()

        try {
            const first = await register(baseUrl, { name: "  Ada Obi  ", email: `  ${local.toUpperCase()}@Example.TEST `, password: goodPassword, role: "SELLER" })
            assert.equal(first.status, 200)
            const user = await prisma.user.findUniqueOrThrow({ where: { email: stored } })
            assert.equal(user.name, "Ada Obi")
            assert.equal(user.role, "SELLER")
            assert.equal(user.isAdmin, false)

            await register(baseUrl, { name: "Ada Obi", email: stored.toUpperCase(), password: goodPassword, role: "SELLER" })
            assert.equal(await prisma.user.count({ where: { email: { equals: stored, mode: "insensitive" } } }), 1)

            // Logging in works whatever the capital letters or spaces, once the email is confirmed.
            await postJson(baseUrl, "/users/verify-email", { email: stored, code: codeSentTo(stored) })
            const login = await postJson(baseUrl, "/users/login", { email: ` ${stored.toUpperCase()} `, password: goodPassword })
            assert.equal(login.status, 200)
            assert.equal((await login.json() as { otpRequired: boolean }).otpRequired, true)
        } finally {
            await deleteRegistered([stored])
        }
    })
})

test("two registrations with the same email at the same moment give one account and the same answer, never a server error", async () => {
    await withAppServer(async (baseUrl) => {
        const email = `race-${randomUUID()}@example.test`

        try {
            const responses = await Promise.all(Array.from({ length: 4 }, () =>
                register(baseUrl, { name: "Racer", email, password: goodPassword, role: "CONSUMER" })))
            assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200])
            assert.equal(await prisma.user.count({ where: { email } }), 1)
        } finally {
            await deleteRegistered([email])
        }
    })
})

test("login gives the same answer for an unknown email, a wrong password and a malformed request, and tolerates odd input", async () => {
    await withSessionUser(async (context) => {
        const attempt = (body: Record<string, unknown>) => fetch(`${context.baseUrl}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
        const sameRefusal = { message: "Invalid email or password" }

        const unknown = await attempt({ email: `nobody-${randomUUID()}@example.test`, password: goodPassword })
        const wrong = await attempt({ email: context.email, password: "definitely-not-it" })
        assert.equal(unknown.status, 400)
        assert.equal(wrong.status, 400)
        assert.deepEqual(await unknown.json(), sameRefusal)
        assert.deepEqual(await wrong.json(), sameRefusal)

        for (const body of [
            { email: { $ne: null }, password: goodPassword },
            { email: context.email, password: { $ne: null } },
            { email: context.email, password: ["a"] },
            { email: context.email, password: "x".repeat(5000) }
        ]) {
            const response = await attempt(body)
            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80))
            assert.deepEqual(await response.json(), sameRefusal)
        }

        assert.equal((await attempt({ email: context.email.toUpperCase(), password: context.password })).status, 200)
    })
})

// ---- Login codes, trusted devices, password reset and change ----

async function setUpAccount(context: SessionContext, changes: { isAdmin?: boolean } = {}) {
    if (changes.isAdmin) {
        await prisma.user.update({ where: { id: context.userId }, data: { isAdmin: true } })
    }
}

test("logging in from an unknown device needs the emailed code, which works once and survives four wrong guesses at most", async () => {
    await withSessionUser(async (context) => {
        const step = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
        assert.equal(step.status, 200)
        assert.deepEqual(await step.json(), {
            otpRequired: true,
            message: "Enter the code we emailed you to log in on this device.",
            email: context.email
        })
        assert.equal(step.headers.getSetCookie().length, 0)
        assert.match(emailsTo(context.email).at(-1)?.subject ?? "", /Your login code: \d{6}/)

        const code = codeSentTo(context.email)
        const wrong = code === "000000" ? "111111" : "000000"

        for (let attempt = 0; attempt < 4; attempt++) {
            assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: wrong })).status, 400)
        }

        // Malformed codes are refused without counting as guesses.
        assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: "12ab56" })).status, 400)
        assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: { $ne: null } })).status, 400)

        const good = await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code })
        assert.equal(good.status, 200)
        assert.ok(cookiesFrom(good).trustedDevice?.value)
        assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code })).status, 400)
    })
})

test("five wrong guesses kill the code, even the right one afterwards", async () => {
    await withSessionUser(async (context) => {
        await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
        const code = codeSentTo(context.email)
        const wrong = code === "000000" ? "111111" : "000000"

        for (let attempt = 0; attempt < 5; attempt++) {
            assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: wrong })).status, 400)
        }

        assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code })).status, 400)
    })
})

test("a code needs the password step first and a wrong password never sends one", async () => {
    await withSessionUser(async (context) => {
        const before = emailsTo(context.email).length
        const wrongPassword = await postJson(context.baseUrl, "/users/login", { email: context.email, password: "definitely-not-it" })
        assert.equal(wrongPassword.status, 400)
        assert.equal(emailsTo(context.email).length, before)

        const noCode = await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: "123456" })
        assert.equal(noCode.status, 400)
    })
})

test("a trusted device skips the code for 30 days, then asks again; other browsers are not trusted", async () => {
    await withSessionUser(async (context) => {
        const first = await loginForSession(context)
        const trusted = first.cookies.trustedDevice?.value
        assert.ok(trusted)
        const cookie = `trustedDevice=${trusted}`

        const skipped = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password }, cookie)
        assert.equal(skipped.status, 200)
        assert.ok(cookiesFrom(skipped).token?.value)

        const stranger = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password }, "trustedDevice=not-a-real-secret")
        assert.equal((await stranger.json() as { otpRequired?: boolean }).otpRequired, true)

        // The trust lasts a fixed 30 days.
        await prisma.trustedDevice.updateMany({ where: { userId: context.userId }, data: { expiresAt: new Date(Date.now() - 1000) } })
        const expired = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password }, cookie)
        assert.equal((await expired.json() as { otpRequired?: boolean }).otpRequired, true)
    })
})

test("a trusted device belongs to one account and logging out everywhere forgets it", async () => {
    await withSessionUser(async (context) => {
        const other = await prisma.user.create({
            data: { name: "Other", email: `other-${randomUUID()}@example.test`, passwordHash: await bcrypt.hash(goodPassword, 4), role: "CONSUMER", emailVerifiedAt: new Date() }
        })

        try {
            const mine = await loginForSession(context)
            const cookie = `trustedDevice=${mine.cookies.trustedDevice?.value}`

            const theirs = await postJson(context.baseUrl, "/users/login", { email: other.email, password: goodPassword }, cookie)
            assert.equal((await theirs.json() as { otpRequired?: boolean }).otpRequired, true)

            await fetch(`${context.baseUrl}/users/logout-all`, { method: "POST", headers: { cookie: `token=${mine.access}` } })
            const afterwards = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password }, cookie)
            assert.equal((await afterwards.json() as { otpRequired?: boolean }).otpRequired, true)
        } finally {
            await prisma.user.delete({ where: { id: other.id } })
        }
    })
})

test("one browser stays trusted by each account that entered a code, so switching accounts does not ask again", async () => {
    await withSessionUser(async (context) => {
        const others = await Promise.all([1, 2, 3, 4, 5].map(async (n) => prisma.user.create({
            data: { name: `Other ${n}`, email: `switch-${n}-${randomUUID()}@example.test`, passwordHash: await bcrypt.hash(goodPassword, 4), role: "CONSUMER", emailVerifiedAt: new Date() }
        })))
        const asksForCode = async (email: string, password: string, cookie: string) =>
            (await (await postJson(context.baseUrl, "/users/login", { email, password }, cookie)).json() as { otpRequired?: boolean }).otpRequired === true
        // Logs in with a code on this browser and returns the browser's new trusted-device cookie.
        const enterCode = async (email: string, password: string, cookie: string) => {
            assert.equal(await asksForCode(email, password, cookie), true)
            const verified = await postJson(context.baseUrl, "/users/login/verify", { email, code: codeSentTo(email) }, cookie)
            assert.equal(verified.status, 200)
            return `trustedDevice=${cookiesFrom(verified).trustedDevice?.value}`
        }

        try {
            // Account A, then account B on the same browser: both are now trusted.
            let cookie = await enterCode(context.email, context.password, "")
            cookie = await enterCode(others[0]!.email, goodPassword, cookie)
            assert.equal(await asksForCode(context.email, context.password, cookie), false)
            assert.equal(await asksForCode(others[0]!.email, goodPassword, cookie), false)

            // Logging out everywhere on one account forgets only that account.
            await prisma.trustedDevice.updateMany({ where: { userId: others[0]!.id }, data: { revokedAt: new Date() } })
            assert.equal(await asksForCode(others[0]!.email, goodPassword, cookie), true)
            assert.equal(await asksForCode(context.email, context.password, cookie), false)

            // At most five accounts per browser: with a sixth, the oldest (A) is dropped.
            cookie = await enterCode(others[0]!.email, goodPassword, cookie)
            for (const other of others.slice(1)) {
                cookie = await enterCode(other.email, goodPassword, cookie)
            }
            assert.equal(cookie.split("=")[1]!.split(".").length, 5)
            assert.equal(await asksForCode(context.email, context.password, cookie), true)
            for (const other of others.slice(1)) {
                assert.equal(await asksForCode(other.email, goodPassword, cookie), false)
            }

            // Malformed parts of the cookie are ignored.
            assert.equal(await asksForCode(others[4]!.email, goodPassword, `${cookie}..%%%.`), false)
        } finally {
            await prisma.trustedDevice.deleteMany({ where: { userId: { in: others.map((other) => other.id) } } })
            await prisma.emailOtp.deleteMany({ where: { userId: { in: others.map((other) => other.id) } } })
            await prisma.refreshToken.deleteMany({ where: { userId: { in: others.map((other) => other.id) } } })
            await prisma.user.deleteMany({ where: { id: { in: others.map((other) => other.id) } } })
        }
    })
})

test("administrators enter a code every time and their devices are never remembered", async () => {
    await withSessionUser(async (context) => {
        await setUpAccount(context, { isAdmin: true })
        const first = await loginForSession(context)
        assert.equal(first.cookies.trustedDevice, undefined)
        assert.equal(await prisma.trustedDevice.count({ where: { userId: context.userId } }), 0)

        // Even a trusted-device cookie that was somehow valid does not let an administrator skip the code.
        const planted = "planted-secret"
        await prisma.trustedDevice.create({
            data: { userId: context.userId, tokenHash: createHash("sha256").update(planted).digest("hex"), expiresAt: new Date(Date.now() + 60_000) }
        })
        const step = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password }, `trustedDevice=${planted}`)
        assert.equal((await step.json() as { otpRequired?: boolean }).otpRequired, true)
    })
})

test("codes can be requested again once a minute, and only by someone who passed the password step", async () => {
    await withSessionUser(async (context) => {
        const stranger = await postJson(context.baseUrl, "/users/resend-code", { email: context.email, purpose: "LOGIN" })
        assert.equal(stranger.status, 200)
        assert.equal(emailsTo(context.email).length, 0)

        await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
        const firstCode = codeSentTo(context.email)
        assert.equal(emailsTo(context.email).length, 1)

        // Within the minute the code already sent stays in place and nothing new is emailed.
        const tooSoon = await postJson(context.baseUrl, "/users/resend-code", { email: context.email, purpose: "LOGIN" })
        assert.equal(tooSoon.status, 200)
        assert.equal(emailsTo(context.email).length, 1)

        await prisma.emailOtp.updateMany({ where: { userId: context.userId }, data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } })
        await postJson(context.baseUrl, "/users/resend-code", { email: context.email, purpose: "LOGIN" })
        assert.equal(emailsTo(context.email).length, 2)
        const secondCode = codeSentTo(context.email)

        if (secondCode !== firstCode) {
            assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: firstCode })).status, 400)
        }

        assert.equal((await postJson(context.baseUrl, "/users/login/verify", { email: context.email, code: secondCode })).status, 200)

        const badPurpose = await postJson(context.baseUrl, "/users/resend-code", { email: context.email, purpose: "PASSWORD_RESET" })
        assert.equal(badPurpose.status, 400)
    })
})

test("an unknown address gets the same answer when asking for codes, and no email", async () => {
    await withAppServer(async (baseUrl) => {
        const unknown = `nobody-${randomUUID()}@example.test`
        const known = await prisma.user.create({
            data: { name: "Known", email: `known-${randomUUID()}@example.test`, passwordHash: "x", role: "CONSUMER", emailVerifiedAt: new Date() }
        })

        try {
            for (const path of ["/users/forgot-password", "/users/resend-code"]) {
                const body = (email: string) => ({ email, purpose: "VERIFY_EMAIL" })
                const asked = await postJson(baseUrl, path, body(unknown))
                const askedKnown = await postJson(baseUrl, path, body(known.email))
                assert.equal(asked.status, 200)
                assert.equal(askedKnown.status, 200)
                assert.deepEqual(await asked.json(), await askedKnown.json())
            }

            assert.equal(emailsTo(unknown).length, 0)
            // Forgot password does send to a real account; resending a sign-up code does not (it is already confirmed).
            assert.equal(emailsTo(known.email).length, 1)
            assert.match(emailsTo(known.email)[0]?.subject ?? "", /Reset your password: \d{6}/)
        } finally {
            await prisma.user.delete({ where: { id: known.id } })
        }
    })
})

test("an account gets at most ten codes a day", async () => {
    await withSessionUser(async (context) => {
        await prisma.emailOtp.createMany({
            data: Array.from({ length: otpDailyLimit }, () => ({
                userId: context.userId, purpose: "PASSWORD_RESET" as const, codeHash: "x", consumedAt: new Date(), expiresAt: new Date(Date.now() - 1000)
            }))
        })

        const step = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
        assert.equal(step.status, 200)
        assert.equal(emailsTo(context.email).length, 0)

        await prisma.emailOtp.updateMany({ where: { userId: context.userId }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } })
        await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
        assert.equal(emailsTo(context.email).length, 1)
    })
})

test("a failed email send does not block asking again", async (t) => {
    await withSessionUser(async (context) => {
        const consoleError = t.mock.method(console, "error", () => {})
        setEmailSenderForTesting(async () => { throw new Error("the email service is down") })

        try {
            const step = await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
            assert.equal(step.status, 200)
            assert.equal(consoleError.mock.callCount(), 1)
        } finally {
            setEmailSenderForTesting(async (email) => { sentEmails.push(email) })
        }

        // The unsent code was set aside, so the very next attempt sends a fresh one at once.
        await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })
        assert.equal(emailsTo(context.email).length, 1)
    })
})

test("forgot password sends a code, a weak new password does not use up a try, and a reset ends every login", async () => {
    await withSessionUser(async (context) => {
        const laptop = await loginForSession(context)
        await postJson(context.baseUrl, "/users/forgot-password", { email: context.email })
        const code = codeSentTo(context.email)

        const weak = await postJson(context.baseUrl, "/users/reset-password", { email: context.email, code, newPassword: "short" })
        assert.equal(weak.status, 400)
        assert.match((await weak.json() as { message: string }).message, /at least 10 characters/)

        const wrongCode = code === "000000" ? "111111" : "000000"
        assert.equal((await postJson(context.baseUrl, "/users/reset-password", { email: context.email, code: wrongCode, newPassword: "a-brand-new-password" })).status, 400)

        const reset = await postJson(context.baseUrl, "/users/reset-password", { email: context.email, code, newPassword: "a-brand-new-password" })
        assert.equal(reset.status, 200)
        assert.equal(reset.headers.getSetCookie().length, 0)

        // The old logins and trusted devices are gone, and only the new password works.
        assert.equal((await checkWithAccess(context, laptop.access)).status, 401)
        assert.equal((await refreshSessionRequest(context, laptop.refresh)).status, 401)
        assert.equal((await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })).status, 400)
        const again = await postJson(context.baseUrl, "/users/login", { email: context.email, password: "a-brand-new-password" }, `trustedDevice=${laptop.cookies.trustedDevice?.value}`)
        assert.equal((await again.json() as { otpRequired?: boolean }).otpRequired, true)

        // The code works once.
        assert.equal((await postJson(context.baseUrl, "/users/reset-password", { email: context.email, code, newPassword: "another-new-password" })).status, 400)
    })
})

test("a reset finishes an unconfirmed sign-up, because the code proves the email", async () => {
    await withAppServer(async (baseUrl) => {
        const email = `reset-unconfirmed-${randomUUID()}@example.test`

        try {
            await register(baseUrl, { name: "Forgetful", email, password: goodPassword, role: "CONSUMER" })
            await postJson(baseUrl, "/users/forgot-password", { email })
            const reset = await postJson(baseUrl, "/users/reset-password", { email, code: codeSentTo(email), newPassword: "the-password-i-chose-2" })
            assert.equal(reset.status, 200)
            assert.ok((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt)
        } finally {
            await deleteRegistered([email])
        }
    })
})

test("changing the password needs the current one, ends the other logins and keeps this one", async () => {
    await withSessionUser(async (context) => {
        const laptop = await loginForSession(context)
        const phone = await loginForSession(context)
        const change = (body: Record<string, unknown>, access = laptop.access) =>
            postJson(context.baseUrl, "/users/change-password", body, `token=${access}`)

        assert.equal((await postJson(context.baseUrl, "/users/change-password", { currentPassword: context.password, newPassword: "a-brand-new-password" })).status, 401)
        assert.equal((await change({ newPassword: "a-brand-new-password" })).status, 400)
        const wrongCurrent = await change({ currentPassword: "not-my-password", newPassword: "a-brand-new-password" })
        assert.equal(wrongCurrent.status, 400)
        assert.deepEqual(await wrongCurrent.json(), { message: "Your current password is not right" })
        assert.equal((await change({ currentPassword: context.password, newPassword: "short" })).status, 400)
        assert.equal((await change({ currentPassword: context.password, newPassword: context.password })).status, 400)

        const changed = await change({ currentPassword: context.password, newPassword: "a-brand-new-password" })
        assert.equal(changed.status, 200)
        const cookies = cookiesFrom(changed)
        assert.ok(cookies.token?.value && cookies.refreshToken?.value)

        // This device carries on with a fresh login; every other login has ended.
        assert.equal((await checkWithAccess(context, cookies.token.value)).status, 200)
        assert.equal((await checkWithAccess(context, laptop.access)).status, 401)
        assert.equal((await checkWithAccess(context, phone.access)).status, 401)
        assert.equal((await refreshSessionRequest(context, phone.refresh)).status, 401)
        assert.equal((await refreshSessionRequest(context, cookies.refreshToken.value)).status, 200)

        assert.equal((await postJson(context.baseUrl, "/users/login", { email: context.email, password: context.password })).status, 400)
    })
})

test("accounts never confirmed within a week are removed, and old codes and device records are cleaned up", async () => {
    const stale = await prisma.user.create({
        data: { name: "Stale", email: `stale-${randomUUID()}@example.test`, passwordHash: "x", role: "CONSUMER", cart: { create: {} }, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }
    })
    const recent = await prisma.user.create({ data: { name: "Recent", email: `recent-${randomUUID()}@example.test`, passwordHash: "x", role: "CONSUMER" } })
    const oldConfirmed = await prisma.user.create({
        data: { name: "Old", email: `old-${randomUUID()}@example.test`, passwordHash: "x", role: "CONSUMER", emailVerifiedAt: new Date(), createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    })

    try {
        const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
        await prisma.emailOtp.createMany({
            data: [
                { userId: oldConfirmed.id, purpose: "LOGIN", codeHash: "x", expiresAt: longAgo },
                { userId: oldConfirmed.id, purpose: "LOGIN", codeHash: "y", expiresAt: new Date(Date.now() + 60_000) }
            ]
        })
        await prisma.trustedDevice.createMany({
            data: [
                { userId: oldConfirmed.id, tokenHash: `old-${randomUUID()}`, expiresAt: longAgo },
                { userId: oldConfirmed.id, tokenHash: `live-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) }
            ]
        })

        await purgeStaleAccountRecords()

        assert.equal(await prisma.user.count({ where: { id: stale.id } }), 0)
        assert.equal(await prisma.user.count({ where: { id: { in: [recent.id, oldConfirmed.id] } } }), 2)
        assert.equal(await prisma.emailOtp.count({ where: { userId: oldConfirmed.id } }), 1)
        assert.equal(await prisma.trustedDevice.count({ where: { userId: oldConfirmed.id } }), 1)
    } finally {
        await prisma.user.deleteMany({ where: { id: { in: [stale.id, recent.id, oldConfirmed.id] } } })
    }
})

test("email settings: console mode for development, SMTP needs its settings, production must really send", () => {
    assert.deepEqual(loadEmailConfig({}), { mode: "console", from: "StoreHatch <no-reply@storehatch.local>" })
    assert.throws(() => loadEmailConfig({ EMAIL_MODE: "carrier-pigeon" }), /EMAIL_MODE must be console or smtp/)
    assert.throws(() => loadEmailConfig({ EMAIL_MODE: "smtp" }), /SMTP_HOST, SMTP_USER, SMTP_PASSWORD/)
    assert.throws(() => loadEmailConfig({ EMAIL_MODE: "smtp", SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_PORT: "99999" }), /SMTP_PORT/)

    const smtp = { EMAIL_MODE: "smtp", EMAIL_FROM: "StoreHatch <hello@example.test>", SMTP_HOST: "smtp.example.test", SMTP_USER: "u", SMTP_PASSWORD: "p" }
    const config = loadEmailConfig(smtp)
    assert.equal(config.mode, "smtp")
    assert.equal(config.mode === "smtp" ? config.smtp.port : 0, 587)

    assert.doesNotThrow(() => assertEmailEnvironment({}))
    assert.throws(() => assertEmailEnvironment({ NODE_ENV: "production" }), /EMAIL_MODE must be smtp in production/)
    assert.throws(() => assertEmailEnvironment({ ...smtp, NODE_ENV: "production", EMAIL_FROM: "" }), /EMAIL_FROM must be set in production/)
    assert.doesNotThrow(() => assertEmailEnvironment({ ...smtp, NODE_ENV: "production" }))
})

// ---- Google sign-in ----

async function withGoogleServer(emails: string[], run: (baseUrl: string) => Promise<void>) {
    try {
        await withAppServer(run)
    } finally {
        await deleteRegistered(emails)
    }
}

test("a new person signs in with Google, says whether they buy or sell, and gets a confirmed account with no password", async () => {
    const identity = newGoogleIdentity()

    await withGoogleServer([identity.email], async (baseUrl) => {
        const token = googleToken(identity)
        const asked = await postJson(baseUrl, "/users/google", { credential: token })
        assert.equal(asked.status, 200)
        const askedBody = await asked.json() as { roleRequired: boolean; name: string; email: string }
        assert.equal(askedBody.roleRequired, true)
        assert.equal(askedBody.name, "Grace Hopper")
        assert.equal(askedBody.email, identity.email)
        assert.equal(asked.headers.getSetCookie().length, 0)
        assert.equal(await prisma.user.count({ where: { email: identity.email } }), 0)

        assert.equal((await postJson(baseUrl, "/users/google", { credential: token, role: "ADMIN" })).headers.getSetCookie().length, 0)
        assert.equal(await prisma.user.count({ where: { email: identity.email } }), 0)

        const created = await postJson(baseUrl, "/users/google", { credential: token, role: "CONSUMER" })
        assert.equal(created.status, 200)
        const createdBody = await created.json() as { role: string; isNewAccount: boolean }
        assert.equal(createdBody.role, "CONSUMER")
        assert.equal(createdBody.isNewAccount, true)
        const cookies = cookiesFrom(created)
        assert.ok(cookies.token?.value && cookies.refreshToken?.value)

        const user = await prisma.user.findUniqueOrThrow({ where: { email: identity.email }, include: { cart: true } })
        assert.equal(user.googleId, identity.googleId)
        assert.equal(user.passwordHash, null)
        assert.ok(user.emailVerifiedAt)
        assert.ok(user.cart)
        assert.equal(user.isAdmin, false)

        const check = await fetch(`${baseUrl}/users/check`, { headers: { cookie: `token=${cookies.token.value}` } })
        assert.equal((await check.json() as { hasPassword: boolean }).hasPassword, false)
    })
})

test("a seller can sign up with Google and gets no cart", async () => {
    const identity = newGoogleIdentity("seller")

    await withGoogleServer([identity.email], async (baseUrl) => {
        const created = await postJson(baseUrl, "/users/google", { credential: googleToken(identity), role: "SELLER" })
        assert.equal(created.status, 200)
        const user = await prisma.user.findUniqueOrThrow({ where: { email: identity.email }, include: { cart: true } })
        assert.equal(user.role, "SELLER")
        assert.equal(user.cart, null)
    })
})

test("someone who signed up with Google logs straight back in without a code, from any device", async () => {
    const identity = newGoogleIdentity()

    await withGoogleServer([identity.email], async (baseUrl) => {
        await postJson(baseUrl, "/users/google", { credential: googleToken(identity), role: "CONSUMER" })
        const emailsBefore = emailsTo(identity.email).length

        const again = await postJson(baseUrl, "/users/google", { credential: googleToken(identity) })
        assert.equal(again.status, 200)
        const body = await again.json() as { role: string; isNewAccount?: boolean }
        assert.equal(body.role, "CONSUMER")
        assert.equal(body.isNewAccount, undefined)
        assert.ok(cookiesFrom(again).token?.value)
        assert.equal(emailsTo(identity.email).length, emailsBefore)

        // The same Google person is recognised by Google's id, even if the address on the Google account changed.
        const moved = await postJson(baseUrl, "/users/google", { credential: googleToken({ ...identity, email: `changed-${randomUUID()}@example.test` }) })
        assert.equal(moved.status, 200)
        assert.ok(cookiesFrom(moved).token?.value)
        assert.equal(await prisma.user.count({ where: { googleId: identity.googleId } }), 1)
    })
})

test("Google sign-in refuses tokens that do not check out and says so when it is not set up", async () => {
    await withAppServer(async (baseUrl) => {
        for (const body of [{}, { credential: "" }, { credential: 123 }, { credential: "x".repeat(5000) }, { credential: "not-a-token-we-know" }]) {
            const response = await postJson(baseUrl, "/users/google", body)
            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 40))
            assert.deepEqual(await response.json(), { message: "Google sign-in could not be checked. Try again." })
            assert.equal(response.headers.getSetCookie().length, 0)
        }

        const savedClientId = process.env.GOOGLE_CLIENT_ID
        delete process.env.GOOGLE_CLIENT_ID
        setGoogleVerifierForTesting(null)

        try {
            const unavailable = await postJson(baseUrl, "/users/google", { credential: "anything" })
            assert.equal(unavailable.status, 503)
            assert.deepEqual(await unavailable.json(), { message: "Google sign-in is not available right now" })
        } finally {
            setGoogleVerifierForTesting(async (credential) => googleIdentities.get(credential) ?? null)

            if (savedClientId !== undefined) {
                process.env.GOOGLE_CLIENT_ID = savedClientId
            }
        }
    })
})

test("Google with the email of an existing account is only linked after the owner enters an emailed code", async () => {
    await withSessionUser(async (context) => {
        const identity = { googleId: `google-sub-${randomUUID()}`, email: context.email, name: "Grace Hopper" }
        const token = googleToken(identity)

        const asked = await postJson(context.baseUrl, "/users/google", { credential: token, role: "SELLER" })
        assert.equal(asked.status, 200)
        const body = await asked.json() as { linkRequired: boolean; email: string }
        assert.equal(body.linkRequired, true)
        assert.equal(body.email, context.email)
        assert.equal(asked.headers.getSetCookie().length, 0)
        assert.match(emailsTo(context.email).at(-1)?.subject ?? "", /Link Google to your account: \d{6}/)
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: context.userId } })).googleId, null)

        const code = codeSentTo(context.email)
        const wrong = code === "000000" ? "111111" : "000000"
        assert.equal((await postJson(context.baseUrl, "/users/google/link", { credential: token, code: wrong })).status, 400)
        assert.equal((await postJson(context.baseUrl, "/users/google/link", { credential: "unknown-token", code })).status, 400)

        const linked = await postJson(context.baseUrl, "/users/google/link", { credential: token, code })
        assert.equal(linked.status, 200)
        // The account keeps its role and password; Google was only added to it.
        assert.equal((await linked.json() as { role: string }).role, "CONSUMER")
        assert.ok(cookiesFrom(linked).token?.value)
        const user = await prisma.user.findUniqueOrThrow({ where: { id: context.userId } })
        assert.equal(user.googleId, identity.googleId)
        assert.ok(user.passwordHash)
        assert.equal((await postJson(context.baseUrl, "/users/google/link", { credential: token, code })).status, 400)

        // From now on Google signs in without a code, and a different Google account cannot take the address.
        assert.ok(cookiesFrom(await postJson(context.baseUrl, "/users/google", { credential: googleToken(identity) })).token?.value)
        const other = await postJson(context.baseUrl, "/users/google", { credential: googleToken({ ...identity, googleId: `google-sub-${randomUUID()}` }) })
        assert.equal(other.status, 400)
        assert.match((await other.json() as { message: string }).message, /different Google account/)
    })
})

test("Google with the address of a sign-up that was never confirmed takes the account over and throws the typed password away", async () => {
    await withAppServer(async (baseUrl) => {
        const identity = newGoogleIdentity("unconfirmed")

        try {
            await register(baseUrl, { name: "Sneaky", email: identity.email, password: "sneaky-chosen-password", role: "SELLER" })
            const oldCode = codeSentTo(identity.email)

            const signedIn = await postJson(baseUrl, "/users/google", { credential: googleToken(identity) })
            assert.equal(signedIn.status, 200)
            assert.equal((await signedIn.json() as { role: string }).role, "SELLER")

            const user = await prisma.user.findUniqueOrThrow({ where: { email: identity.email } })
            assert.equal(user.googleId, identity.googleId)
            assert.equal(user.passwordHash, null)
            assert.ok(user.emailVerifiedAt)

            assert.equal((await postJson(baseUrl, "/users/login", { email: identity.email, password: "sneaky-chosen-password" })).status, 400)
            assert.equal((await postJson(baseUrl, "/users/verify-email", { email: identity.email, code: oldCode })).status, 400)
        } finally {
            await deleteRegistered([identity.email])
        }
    })
})

test("an administrator signing in with Google still enters an emailed code", async () => {
    const identity = newGoogleIdentity("admin")

    await withGoogleServer([identity.email], async (baseUrl) => {
        await postJson(baseUrl, "/users/google", { credential: googleToken(identity), role: "CONSUMER" })
        await prisma.user.update({ where: { email: identity.email }, data: { isAdmin: true } })

        const step = await postJson(baseUrl, "/users/google", { credential: googleToken(identity) })
        assert.equal(step.status, 200)
        assert.equal((await step.json() as { otpRequired: boolean }).otpRequired, true)
        assert.equal(step.headers.getSetCookie().length, 0)

        const done = await postJson(baseUrl, "/users/login/verify", { email: identity.email, code: codeSentTo(identity.email) })
        assert.equal(done.status, 200)
        assert.equal(cookiesFrom(done).trustedDevice, undefined)
    })
})

test("an account made with Google has no password to log in with until it sets one with an emailed code", async () => {
    const identity = newGoogleIdentity()

    await withGoogleServer([identity.email], async (baseUrl) => {
        const created = await postJson(baseUrl, "/users/google", { credential: googleToken(identity), role: "CONSUMER" })
        const first = cookiesFrom(created)
        const second = cookiesFrom(await postJson(baseUrl, "/users/google", { credential: googleToken(identity) }))
        assert.ok(first.token?.value && second.token?.value && second.refreshToken?.value)
        const access = first.token.value

        const passwordLogin = await postJson(baseUrl, "/users/login", { email: identity.email, password: "a-guessed-password" })
        assert.equal(passwordLogin.status, 400)
        assert.deepEqual(await passwordLogin.json(), { message: "Invalid email or password" })

        const change = await postJson(baseUrl, "/users/change-password", { currentPassword: "anything-at-all", newPassword: "a-brand-new-password" }, `token=${access}`)
        assert.equal(change.status, 400)
        assert.equal((await change.json() as { code: string }).code, "NO_PASSWORD")

        assert.equal((await postJson(baseUrl, "/users/set-password/send-code", {})).status, 401)
        assert.equal((await postJson(baseUrl, "/users/set-password/send-code", {}, `token=${access}`)).status, 200)
        assert.match(emailsTo(identity.email).at(-1)?.subject ?? "", /Set your password: \d{6}/)
        const code = codeSentTo(identity.email)

        const weak = await postJson(baseUrl, "/users/set-password", { code, newPassword: "short" }, `token=${access}`)
        assert.equal(weak.status, 400)
        assert.match((await weak.json() as { message: string }).message, /at least 10 characters/)
        const wrong = code === "000000" ? "111111" : "000000"
        assert.equal((await postJson(baseUrl, "/users/set-password", { code: wrong, newPassword: "a-brand-new-password" }, `token=${access}`)).status, 400)

        const set = await postJson(baseUrl, "/users/set-password", { code, newPassword: "a-brand-new-password" }, `token=${access}`)
        assert.equal(set.status, 200)
        const after = cookiesFrom(set)
        assert.ok(after.token?.value)
        // This device carries on; the other login ended.
        assert.equal((await fetch(`${baseUrl}/users/check`, { headers: { cookie: `token=${after.token.value}` } })).status, 200)
        assert.equal((await fetch(`${baseUrl}/users/check`, { headers: { cookie: `token=${second.token.value}` } })).status, 401)

        // Now it has a password, and the password route needs the usual code on a new device.
        const loginStep = await postJson(baseUrl, "/users/login", { email: identity.email, password: "a-brand-new-password" })
        assert.equal((await loginStep.json() as { otpRequired: boolean }).otpRequired, true)
        assert.equal((await postJson(baseUrl, "/users/set-password/send-code", {}, `token=${after.token.value}`)).status, 400)
        const again = await postJson(baseUrl, "/users/set-password", { code, newPassword: "yet-another-password" }, `token=${after.token.value}`)
        assert.equal(again.status, 400)
        assert.equal((await again.json() as { code: string }).code, "HAS_PASSWORD")
    })
})

test("a seller with no password cannot change their bank account until they set one", async () => {
    const identity = newGoogleIdentity("seller")

    await withGoogleServer([identity.email], async (baseUrl) => {
        const created = await postJson(baseUrl, "/users/google", { credential: googleToken(identity), role: "SELLER" })
        const access = cookiesFrom(created).token?.value
        assert.ok(access)
        const user = await prisma.user.findUniqueOrThrow({ where: { email: identity.email } })
        await prisma.sellerProfile.create({
            data: {
                userId: user.id,
                businessName: "Google Shop",
                state: "Lagos",
                lga: "Ikeja",
                location: "Ikeja, Lagos",
                logoUrl: "https://example.test/logo.png",
                slug: `google-shop-${randomUUID()}`,
                shippingPolicy: "FREE",
                shippingCost: null
            }
        })

        const response = await fetch(`${baseUrl}/seller/payout/accounts`, {
            method: "PUT",
            headers: { "content-type": "application/json", cookie: `token=${access}` },
            body: JSON.stringify(changeBankRequest)
        })
        assert.equal(response.status, 403)
        assert.equal((await response.json() as { code: string }).code, "PAYOUT_PASSWORD_REQUIRED")
    })
})

// ---- Hardening: headers, origin check, health, rate limits, input limits, startup checks ----

test("responses carry security headers and do not announce the framework", async () => {
    await withAppServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/listings/abc`)
        assert.equal(response.headers.get("x-powered-by"), null)
        assert.equal(response.headers.get("x-content-type-options"), "nosniff")
        assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=/)
        assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN")
        assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin")
    })
})

test("health checks answer without logging in, and say whether the database is reachable", async () => {
    await withAppServer(async (baseUrl) => {
        const alive = await fetch(`${baseUrl}/health`)
        assert.equal(alive.status, 200)
        assert.deepEqual(await alive.json(), { status: "ok" })

        const ready = await fetch(`${baseUrl}/health/ready`)
        assert.equal(ready.status, 200)
        assert.deepEqual(await ready.json(), { status: "ready" })
    })
})

test("changes asked for by another website are refused, even without a body, while our own frontend and tools pass", async () => {
    await withSessionUser(async (context) => {
        const { access } = await loginForSession(context)
        const cookie = `token=${access}`
        const attempt = (origin?: string) => fetch(`${context.baseUrl}/users/logout-all`, {
            method: "POST",
            headers: { cookie, ...(origin ? { origin } : {}) }
        })

        const evil = await attempt("https://evil.example")
        assert.equal(evil.status, 403)
        assert.deepEqual(await evil.json(), { message: "This request is not allowed from that website" })
        assert.equal((await attempt("null")).status, 403)
        // Nothing happened: the login is still live.
        assert.equal((await checkWithAccess(context, access)).status, 200)

        // Reading is never blocked, and requests from our own frontend or with no Origin (tools, servers) go through.
        const read = await fetch(`${context.baseUrl}/users/check`, { headers: { cookie, origin: "https://evil.example" } })
        assert.equal(read.status, 200)
        assert.equal((await attempt(config.frontendUrl)).status, 200)
    })
})

test("payment webhooks are not blocked by the origin check or the rate limit", async () => {
    setRateLimitingForTesting(true)

    try {
        await withAppServer(async (baseUrl) => {
            for (let request = 0; request < 3; request++) {
                const response = await fetch(`${baseUrl}/payments/webhooks/paystack`, {
                    method: "POST",
                    headers: { origin: "https://evil.example", "content-type": "application/json" },
                    body: "{}"
                })
                // Refused for its missing signature, not for where it came from or how often.
                assert.equal(response.status, 401)
            }
        })
    } finally {
        setRateLimitingForTesting(false)
    }
})

test("a wrong-password flood on one account is slowed down, other accounts are not affected, and the answer is JSON", async () => {
    setRateLimitingForTesting(true)

    try {
        await withSessionUser(async (context) => {
            const attempt = (email: string) => postJson(context.baseUrl, "/users/login", { email, password: "definitely-not-it" })
            const statuses: number[] = []

            for (let request = 0; request < 12; request++) {
                statuses.push((await attempt(context.email)).status)
            }

            assert.deepEqual(statuses, [...Array(10).fill(400), 429, 429])

            const blocked = await attempt(context.email.toUpperCase())
            assert.equal(blocked.status, 429)
            assert.deepEqual(await blocked.json(), { message: "Too many attempts. Please wait a few minutes and try again." })
            assert.ok(blocked.headers.get("retry-after"))

            // A different account from the same address still gets through to the password check.
            assert.equal((await attempt(`someone-else-${randomUUID()}@example.test`)).status, 400)
        })
    } finally {
        setRateLimitingForTesting(false)
    }
})

test("asking for emails is limited per account, and sign-ups per address", async () => {
    setRateLimitingForTesting(true)

    try {
        await withAppServer(async (baseUrl) => {
            const email = `flood-${randomUUID()}@example.test`
            const statuses: number[] = []

            for (let request = 0; request < 7; request++) {
                statuses.push((await postJson(baseUrl, "/users/forgot-password", { email })).status)
            }

            assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429])
        })
    } finally {
        setRateLimitingForTesting(false)
    }
})

test("writing in complaint threads is limited per user", async () => {
    setRateLimitingForTesting(true)

    try {
        await withSessionUser(async (context) => {
            const { access } = await loginForSession(context)
            const statuses: number[] = []

            for (let request = 0; request < 32; request++) {
                const response = await postJson(context.baseUrl, "/disputes/1/messages", { message: "This is a long enough message." }, `token=${access}`)
                statuses.push(response.status)
            }

            // The first 30 reach the handler (no such complaint: 404); the rest are stopped before it.
            assert.equal(statuses.slice(0, 30).every((status) => status === 404), true, statuses.join(","))
            assert.deepEqual(statuses.slice(30), [429, 429])
        })
    } finally {
        setRateLimitingForTesting(false)
    }
})

test("prices, text and image links on listings and shops are checked", async () => {
    assert.equal(priceProblem(1500), null)
    assert.equal(priceProblem("19.99"), null)
    assert.equal(priceProblem(0.01), null)
    assert.equal(priceProblem(100_000_000), null)
    for (const bad of [0, -5, "abc", NaN, Infinity, null, undefined, {}, "1e21", 100_000_001, 19.999, "0.001"]) {
        assert.ok(priceProblem(bad), `${String(bad)} should be refused`)
    }

    for (const good of ["https://res.cloudinary.com/demo/image/upload/a.png", "https://example.test/logo.png"]) {
        assert.equal(isHttpsUrl(good), true, good)
    }
    for (const bad of ["http://example.test/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://localhost/a.png", "https://user:pw@example.test/a.png", "not a url", "", `https://example.test/${"a".repeat(2100)}`, 5, null]) {
        assert.equal(isHttpsUrl(bad), false, String(bad).slice(0, 40))
    }
})

test("creating and editing a listing refuses oversized text, non-https images and odd prices", async () => {
    const fixture = await createCheckoutLifecycleFixture("listing-limits", 5, 1)

    try {
        const post = (body: Record<string, unknown>, method = "POST", path = "/listings") => fetch(`${fixture.baseUrl}${path}`, {
            method,
            headers: { "content-type": "application/json", cookie: `token=${fixture.sellerToken}` },
            body: JSON.stringify(body)
        })
        const valid = { title: "Charger", description: "A fast charger", price: 2500, category: "Electronics", imageUrl: "https://example.test/charger.png", stockQuantity: 3 }
        const refused = async (changes: Record<string, unknown>, message: RegExp) => {
            const response = await post({ ...valid, ...changes })
            assert.equal(response.status, 400, JSON.stringify(changes).slice(0, 60))
            assert.match((await response.json() as { message: string }).message, message)
        }

        await refused({ title: "t".repeat(121) }, /120 characters/)
        await refused({ description: "d".repeat(5001) }, /5000 characters/)
        await refused({ title: { x: 1 } }, /Title must be text/)
        await refused({ imageUrl: "http://example.test/charger.png" }, /https link/)
        await refused({ imageUrl: "javascript:alert(1)" }, /https link/)
        await refused({ price: 19.999 }, /two decimal places/)
        await refused({ price: 100_000_001 }, /cannot be more than/)
        await refused({ price: "abc" }, /greater than 0/)
        await refused({ stockQuantity: 1_000_001 }, /cannot be more than/)
        await refused({ stockQuantity: 2.5 }, /whole number/)

        const created = await post(valid)
        assert.equal(created.status, 201)
        const listing = await created.json() as { id: number }

        const edit = (body: Record<string, unknown>) => post(body, "PATCH", `/listings/${listing.id}`)
        assert.equal((await edit({ imageUrl: "http://example.test/x.png" })).status, 400)
        assert.equal((await edit({ price: 12.345 })).status, 400)
        assert.equal((await edit({ title: "t".repeat(121) })).status, 400)
        assert.equal((await edit({ price: 3000.5, imageUrl: "https://example.test/new.png" })).status, 200)

        await prisma.listing.delete({ where: { id: listing.id } })
    } finally {
        await fixture.cleanup()
    }
})

test("shop names and logos are checked", async () => {
    const identity = newGoogleIdentity("shop")

    await withGoogleServer([identity.email], async (baseUrl) => {
        const created = await postJson(baseUrl, "/users/google", { credential: googleToken(identity), role: "SELLER" })
        const cookie = `token=${cookiesFrom(created).token?.value}`
        const shop = { businessName: "Good Shop", state: "Lagos", lga: "Ikeja", logoUrl: "https://example.test/logo.png", shippingPolicy: "FREE" }
        const send = (body: Record<string, unknown>) => postJson(baseUrl, "/seller/profile", body, cookie)

        const longName = await send({ ...shop, businessName: "n".repeat(81) })
        assert.equal(longName.status, 400)
        assert.match((await longName.json() as { message: string }).message, /80 characters/)
        const badLogo = await send({ ...shop, logoUrl: "http://example.test/logo.png" })
        assert.equal(badLogo.status, 400)
        assert.match((await badLogo.json() as { message: string }).message, /https link/)
        assert.equal(await prisma.sellerProfile.count({ where: { user: { email: identity.email } } }), 0)

        assert.equal((await send(shop)).status, 201)
    })
})

test("production refuses to start without the payment secrets, a deliberate proxy setting and a long signing secret", () => {
    const base = {
        DATABASE_URL: "postgresql://localhost/vendly",
        JWT_SECRET: "x".repeat(32),
        NODE_ENV: "production",
        PAYSTACK_SECRET_KEY: "k",
        FLUTTERWAVE_SECRET_KEY: "k",
        FLUTTERWAVE_WEBHOOK_SECRET: "k",
        TRUST_PROXY: "1"
    }

    assert.doesNotThrow(() => assertRequiredEnvironment(base))
    assert.throws(
        () => assertRequiredEnvironment({ ...base, PAYSTACK_SECRET_KEY: "", FLUTTERWAVE_WEBHOOK_SECRET: " ", TRUST_PROXY: undefined }),
        /required in production: PAYSTACK_SECRET_KEY, FLUTTERWAVE_WEBHOOK_SECRET, TRUST_PROXY/
    )
    assert.throws(() => assertRequiredEnvironment({ ...base, JWT_SECRET: "short" }), /JWT_SECRET must be at least 32 characters in production/)
    // Outside production none of this is demanded.
    assert.doesNotThrow(() => assertRequiredEnvironment({ DATABASE_URL: "postgresql://localhost/vendly", JWT_SECRET: "short" }))
})

test("the number of proxies in front of the server is read as a count, never as true", () => {
    assert.equal(loadConfig({ TRUST_PROXY: "1" }).trustProxy, 1)
    assert.equal(loadConfig({ TRUST_PROXY: "2" }).trustProxy, 2)
    assert.equal(loadConfig({ TRUST_PROXY: "0" }).trustProxy, false)
    assert.equal(loadConfig({}).trustProxy, false)

    for (const bad of ["true", "yes", "-1", "1.5", "10.0.0.1"]) {
        assert.throws(() => loadConfig({ TRUST_PROXY: bad }), /TRUST_PROXY must be the number of proxies/)
    }
})

test("the background checker can be stopped and waits for a run in progress", async () => {
    const stop = startPaymentChecker()
    await stop()
    // Stopping twice, or when nothing is running, is harmless.
    await stop()
})

// ---- Small backend items: checkout id on complaints, complaint filter, listing with seller, archive, earnings, admin lookups, unread ----

test("complaints carry the checkout id, so a complaint page can link back to its order", async () => {
    await withPaymentCheckout("dispute-checkout-id", async (context) => {
        const { fixture, checkoutId, request, adminToken } = context
        const orderId = await payAndShip(context)
        const opened = await complain(context, orderId)
        assert.equal(opened.status, 201)
        const id = opened.body.dispute.id

        assert.equal(opened.body.dispute.checkoutId, checkoutId)
        assert.equal(opened.body.dispute.order.checkoutId, checkoutId)
        assert.equal((await request("GET", "/disputes")).body.disputes[0].checkoutId, checkoutId)
        assert.equal((await request("GET", `/disputes/${id}`)).body.dispute.checkoutId, checkoutId)
        assert.equal((await request("GET", "/seller/disputes", undefined, fixture.sellerToken)).body.disputes[0].checkoutId, checkoutId)
        assert.equal((await request("GET", `/admin/disputes/${id}`, undefined, adminToken)).body.dispute.order.checkoutId, checkoutId)
    })
})

test("the seller's order list can be narrowed to orders with a complaint", async () => {
    await withPaymentCheckout("orders-by-complaint", async (context) => {
        const { fixture, request } = context
        const orderId = await payAndShip(context)
        const orders = (query: string) => request("GET", `/seller/orders${query}`, undefined, fixture.sellerToken)
        const total = async (query: string) => (await orders(query)).body.total

        assert.equal(await total(""), 1)
        assert.equal(await total("?complaint=none"), 1)
        assert.equal(await total("?complaint=any"), 0)
        assert.equal(await total("?complaint=active"), 0)
        assert.equal(await total("?complaint=awaiting-response"), 0)
        assert.equal((await orders("?complaint=everything")).status, 400)

        const opened = await complain(context, orderId)
        assert.equal(await total("?complaint=none"), 0)
        assert.equal(await total("?complaint=any"), 1)
        assert.equal(await total("?complaint=active"), 1)
        assert.equal(await total("?complaint=awaiting-response"), 1)
        assert.equal(await total("?complaint=awaiting-response&status=SHIPPED"), 1)
        assert.equal(await total("?complaint=awaiting-response&status=PAID"), 0)

        // Once the seller has answered, it no longer awaits them but is still active.
        await request("POST", `/seller/disputes/${opened.body.dispute.id}/respond`, { action: "DISAGREE", message: "The item left us in perfect condition." }, fixture.sellerToken)
        assert.equal(await total("?complaint=awaiting-response"), 0)
        assert.equal(await total("?complaint=active"), 1)

        // A withdrawn complaint does not count.
        await request("POST", `/disputes/${opened.body.dispute.id}/withdraw`)
        assert.equal(await total("?complaint=any"), 0)
        assert.equal(await total("?complaint=none"), 1)
    })
})

test("one listing includes its seller's shop name and link, and not the seller's account id", async () => {
    const fixture = await createCheckoutLifecycleFixture("listing-with-seller", 5, 1)

    try {
        await withAppServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/listings/${fixture.listingId}`)
            assert.equal(response.status, 200)
            const listing = await response.json() as Record<string, unknown>
            assert.equal(listing.id, fixture.listingId)
            assert.equal(listing.sellerName, "listing-with-seller Shop")
            assert.match(String(listing.sellerSlug), /^listing-with-seller-/)
            assert.equal("userId" in listing, false)
            assert.equal(listing.title, "listing-with-seller listing")
        })
    } finally {
        await fixture.cleanup()
    }
})

test("a seller archives a listing that has history: it leaves the shop and carts but orders keep it, and it can come back", async () => {
    await withPaymentCheckout("archive-listing", async (context) => {
        const { fixture, request } = context
        await payAndShip(context)
        const listingId = fixture.listingId
        const slug = (await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })).slug
        const shopListings = async () => (await request("GET", `/seller/shop/${slug}`)).body.listings as Array<{ id: number }>
        const publicIds = async () => ((await request("GET", "/listings")).body.listings as Array<{ id: number }>).map((listing) => listing.id)

        // It has order history, so it cannot be deleted; the answer says what to do instead.
        const deleted = await request("DELETE" as "GET", `/listings/${listingId}`, undefined, fixture.sellerToken)
        assert.equal(deleted.status, 409)
        assert.equal(deleted.body.code, "LISTING_HAS_HISTORY")
        assert.match(deleted.body.message, /Archive it instead/)

        const shopper = await fixture.addConsumer(1)
        assert.equal(await prisma.cartItem.count({ where: { listingId } }), 1)
        assert.ok((await publicIds()).includes(listingId))
        assert.ok((await shopListings()).some((listing) => listing.id === listingId))

        // Only its owner can archive it.
        assert.equal((await request("POST", `/listings/${listingId}/archive`, {}, fixture.token)).status, 403)
        await withStrangerSeller(async (strangerToken) => {
            assert.equal((await request("POST", `/listings/${listingId}/archive`, {}, strangerToken)).status, 403)
        })
        assert.equal((await request("POST", "/listings/999999999/archive", {}, fixture.sellerToken)).status, 404)

        const archived = await request("POST", `/listings/${listingId}/archive`, {}, fixture.sellerToken)
        assert.equal(archived.status, 200)
        assert.ok(archived.body.listing.archivedAt)
        // Archiving again changes nothing.
        const again = await request("POST", `/listings/${listingId}/archive`, {}, fixture.sellerToken)
        assert.equal(again.body.listing.archivedAt, archived.body.listing.archivedAt)

        assert.equal(await prisma.cartItem.count({ where: { listingId } }), 0)
        assert.equal((await publicIds()).includes(listingId), false)
        assert.equal((await shopListings()).some((listing) => listing.id === listingId), false)
        assert.equal((await request("GET", `/listings/${listingId}`)).status, 404)
        const addToCart = await request("POST", "/cart/items", { listingId, quantity: 1 }, shopper.token)
        assert.equal(addToCart.status, 404)

        // The seller still has it, and the paid order still names it.
        assert.equal(((await request("GET", "/listings/Mylisting", undefined, fixture.sellerToken)).body as unknown[]).length, 0)
        assert.equal(((await request("GET", "/listings/Mylisting?archived=only", undefined, fixture.sellerToken)).body as unknown[]).length, 1)
        assert.equal(((await request("GET", "/listings/Mylisting?archived=all", undefined, fixture.sellerToken)).body as unknown[]).length, 1)
        assert.equal((await request("GET", "/listings/Mylisting?archived=maybe", undefined, fixture.sellerToken)).status, 400)
        const order = await request("GET", `/orders/${context.checkoutId}`)
        assert.equal(order.body.sellerOrders[0].items[0].title, "archive-listing listing")

        const restored = await request("POST", `/listings/${listingId}/unarchive`, {}, fixture.sellerToken)
        assert.equal(restored.status, 200)
        assert.equal(restored.body.listing.archivedAt, null)
        assert.ok((await publicIds()).includes(listingId))
        assert.equal((await request("GET", `/listings/${listingId}`)).status, 200)
    })
})

test("a seller's earnings summarise paid orders, optionally within dates, and nobody else can read them", async () => {
    await withPaymentCheckout("seller-earnings", async (context) => {
        const { fixture, request } = context
        const empty = await request("GET", "/seller/earnings", undefined, fixture.sellerToken)
        assert.equal(empty.status, 200)
        assert.equal(empty.body.totals.orders, 0)
        assert.equal(empty.body.totals.sales, "0.00")
        assert.deepEqual(empty.body.months, [])

        await payAndShip(context)
        const earnings = await request("GET", "/seller/earnings", undefined, fixture.sellerToken)
        assert.equal(earnings.status, 200)
        assert.equal(earnings.body.totals.orders, 1)
        assert.equal(earnings.body.totals.sales, "3000.00")
        assert.equal(earnings.body.totals.refunded, "0.00")
        assert.deepEqual(earnings.body.ordersByStatus, { SHIPPED: 1 })
        assert.equal(earnings.body.owedToVendly.amountStillOwed, "0.00")
        assert.equal(earnings.body.months.length, 1)
        assert.equal(earnings.body.months[0].orders, 1)
        assert.equal(earnings.body.months[0].sales, "3000.00")
        assert.equal(earnings.body.months[0].month, new Date().toISOString().slice(0, 7))

        const today = new Date().toISOString().slice(0, 10)
        assert.equal((await request("GET", `/seller/earnings?from=${today}&to=${today}`, undefined, fixture.sellerToken)).body.totals.orders, 1)
        const past = await request("GET", "/seller/earnings?from=2020-01-01&to=2020-01-31", undefined, fixture.sellerToken)
        assert.equal(past.body.totals.orders, 0)
        assert.equal(past.body.from, "2020-01-01")
        for (const query of ["?from=yesterday", "?to=2026-13-40", "?from=2026-02-30", "?from=2026-05-02&to=2026-05-01"]) {
            assert.equal((await request("GET", `/seller/earnings${query}`, undefined, fixture.sellerToken)).status, 400, query)
        }

        assert.equal((await request("GET", "/seller/earnings", undefined, fixture.token)).status, 403)
        await withStrangerSeller(async (strangerToken) => {
            assert.equal((await request("GET", "/seller/earnings", undefined, strangerToken)).body.totals.orders, 0)
        })
    })
})

test("buyers and sellers are told which complaints have messages they have not opened", async () => {
    await withPaymentCheckout("dispute-unread", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payAndShip(context)
        const buyerCount = async () => (await request("GET", "/disputes/unread")).body.count
        const sellerCount = async () => (await request("GET", "/seller/disputes/unread", undefined, fixture.sellerToken)).body.count
        const buyerFlag = async () => (await request("GET", "/disputes")).body.disputes[0].unread
        const sellerFlag = async () => (await request("GET", "/seller/disputes", undefined, fixture.sellerToken)).body.disputes[0].unread

        const opened = await complain(context, orderId)
        const id = opened.body.dispute.id

        // The buyer's own message is not new to the buyer; it is new to the seller.
        assert.equal(await buyerCount(), 0)
        assert.equal(await buyerFlag(), false)
        assert.equal(await sellerCount(), 1)
        assert.equal(await sellerFlag(), true)
        // The complaints waiting for an answer are a different count and are not affected by reading.
        assert.equal((await request("GET", "/seller/disputes/awaiting-response", undefined, fixture.sellerToken)).body.count, 1)

        // Opening the complaint clears it for that person.
        await request("GET", `/seller/disputes/${id}`, undefined, fixture.sellerToken)
        assert.equal(await sellerCount(), 0)
        assert.equal(await sellerFlag(), false)
        assert.equal((await request("GET", "/seller/disputes/awaiting-response", undefined, fixture.sellerToken)).body.count, 1)

        // The seller replies: new to the buyer, not to the seller.
        await request("POST", `/seller/disputes/${id}/messages`, { message: "Please send a photo of the damage." }, fixture.sellerToken)
        assert.equal(await sellerCount(), 0)
        assert.equal(await buyerCount(), 1)
        assert.equal(await buyerFlag(), true)
        await request("GET", `/disputes/${id}`)
        assert.equal(await buyerCount(), 0)
        assert.equal(await buyerFlag(), false)

        // An administrator's message is new to both; the buyer opening it does not clear the seller's.
        await request("POST", `/admin/disputes/${id}/messages`, { message: "We are looking into this for both of you." }, adminToken)
        assert.equal(await buyerCount(), 1)
        assert.equal(await sellerCount(), 1)
        await request("GET", `/disputes/${id}`)
        assert.equal(await buyerCount(), 0)
        assert.equal(await sellerCount(), 1)

        // Posting counts as having seen the thread, and an administrator opening it changes nothing for the others.
        await request("GET", `/admin/disputes/${id}`, undefined, adminToken)
        assert.equal(await sellerCount(), 1)
        await request("POST", `/seller/disputes/${id}/messages`, { message: "Understood, we will wait for the decision." }, fixture.sellerToken)
        assert.equal(await sellerCount(), 0)

        // Strangers see nothing, and the counts need the right role.
        const other = await fixture.addConsumer(1)
        assert.equal((await request("GET", "/disputes/unread", undefined, other.token)).body.count, 0)
        assert.equal((await request("GET", "/disputes/unread", undefined, fixture.sellerToken)).body.count, 0)
        assert.equal((await request("GET", "/seller/disputes/unread", undefined, fixture.token)).status, 403)
    })
})

test("administrators can see what needs attention, and find orders and people when someone phones or emails", async () => {
    await withPaymentCheckout("admin-lookup", async (context) => {
        const { fixture, request, adminToken, checkoutId } = context
        const summary = async () => (await request("GET", "/admin/summary", undefined, adminToken)).body
        const before = await summary()
        assert.deepEqual(Object.keys(before).sort(), ["complaints", "liabilities", "recoveryCases", "refunds"])

        const orderId = await payAndShip(context)
        await complain(context, orderId)
        const during = await summary()
        assert.equal(during.complaints.awaitingSeller, before.complaints.awaitingSeller + 1)
        assert.equal(during.complaints.awaitingDecision, before.complaints.awaitingDecision)
        assert.match(during.liabilities.amountStillOwed, /^\d+\.\d{2}$/)

        // Orders: found by id, checkout id, buyer, seller, shop, delivery name and payment reference.
        const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { checkoutId } })
        const consumerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.consumerId } })).email
        const sellerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.sellerId } })).email
        const found = async (query: string) => (await request("GET", `/admin/orders${query}`, undefined, adminToken)).body
        for (const search of [String(orderId), String(checkoutId), consumerEmail.toUpperCase(), sellerEmail, "admin-lookup Shop", "Test Consumer", attempt.reference]) {
            const result = await found(`?search=${encodeURIComponent(search)}`)
            assert.ok(result.orders.some((order: { id: number }) => order.id === orderId), `searching for ${search}`)
        }
        const row = (await found(`?search=${orderId}`)).orders.find((order: { id: number }) => order.id === orderId)
        assert.equal(row.checkoutId, checkoutId)
        assert.equal(row.status, "SHIPPED")
        assert.equal(row.buyer.email, consumerEmail)
        assert.equal(row.seller.businessName, "admin-lookup Shop")
        assert.equal(row.complaint.status, "OPEN")
        assert.equal(row.itemCount, 2)
        assert.equal((await found(`?sellerId=${fixture.sellerId}&status=SHIPPED`)).total, 1)
        assert.equal((await found(`?buyerId=${fixture.consumerId}&status=PAID`)).total, 0)
        assert.equal((await found("?search=no-such-person-anywhere")).total, 0)
        for (const query of ["?page=0", "?status=LOST", "?buyerId=abc", `?search=${"x".repeat(101)}`]) {
            assert.equal((await request("GET", `/admin/orders${query}`, undefined, adminToken)).status, 400, query)
        }

        const detail = await request("GET", `/admin/orders/${orderId}`, undefined, adminToken)
        assert.equal(detail.status, 200)
        const order = detail.body.order
        assert.equal(order.total, "3000.00")
        assert.equal(order.buyer.email, consumerEmail)
        assert.equal(order.seller.email, sellerEmail)
        assert.equal(order.delivery.name, "Test Consumer")
        assert.ok(order.delivery.address)
        assert.equal(order.payments[0].reference, attempt.reference)
        assert.equal(order.payments[0].status, "SUCCESS")
        assert.equal(order.complaints[0].reason, "DAMAGED")
        assert.equal(order.items[0].lineTotal, "3000.00")
        assert.equal(JSON.stringify(detail.body).includes("authorizationUrl"), false)
        assert.equal((await request("GET", "/admin/orders/999999999", undefined, adminToken)).status, 404)

        // People: found by id, email, name or shop; secrets are never returned.
        const people = async (query: string) => (await request("GET", `/admin/users${query}`, undefined, adminToken)).body
        for (const search of [String(fixture.sellerId), sellerEmail.toUpperCase(), "admin-lookup Shop"]) {
            assert.ok((await people(`?search=${encodeURIComponent(search)}`)).users.some((user: { id: number }) => user.id === fixture.sellerId), search)
        }
        const sellers = await people("?role=SELLER&search=admin-lookup")
        assert.equal(sellers.users.length, 1)
        assert.deepEqual(sellers.users[0].shop.businessName, "admin-lookup Shop")
        assert.equal(sellers.users[0].emailConfirmed, false)
        assert.equal((await people("?admin=true&search=admin-lookup")).users.length, 1)
        assert.equal((await request("GET", "/admin/users?role=ADMIN", undefined, adminToken)).status, 400)
        assert.equal((await request("GET", "/admin/users?page=x", undefined, adminToken)).status, 400)

        const seller = (await request("GET", `/admin/users/${fixture.sellerId}`, undefined, adminToken)).body.user
        assert.equal(seller.ordersAsSeller, 1)
        assert.equal(seller.ordersAsBuyer, 0)
        assert.equal(seller.activeComplaints, 1)
        assert.equal(seller.openLiabilities.amountStillOwed, "0.00")
        const buyer = (await request("GET", `/admin/users/${fixture.consumerId}`, undefined, adminToken)).body.user
        assert.equal(buyer.ordersAsBuyer, 1)
        assert.equal(buyer.activeComplaints, 1)
        assert.equal((await request("GET", "/admin/users/999999999", undefined, adminToken)).status, 404)

        const everything = JSON.stringify([detail.body, await people(""), seller, buyer])
        assert.equal(everything.includes("passwordHash"), false)
        assert.equal(everything.includes("integration-test-not-a-password"), false)

        // Only administrators.
        for (const path of ["/admin/summary", "/admin/orders", `/admin/orders/${orderId}`, "/admin/users", `/admin/users/${fixture.sellerId}`]) {
            assert.equal((await request("GET", path, undefined, fixture.token)).status, 403, path)
            assert.equal((await request("GET", path, undefined, fixture.sellerToken)).status, 403, path)
        }
    })
})

test("a public shop page says what delivery costs", async () => {
    const fixture = await createCheckoutLifecycleFixture("shop-shipping", 5, 1)

    try {
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })

        await withAppServer(async (baseUrl) => {
            const free = await (await fetch(`${baseUrl}/seller/shop/${profile.slug}`)).json() as { profile: Record<string, unknown> }
            assert.equal(free.profile.shippingPolicy, "FREE")
            assert.equal(free.profile.shippingCost, null)

            await prisma.sellerProfile.update({ where: { id: profile.id }, data: { shippingPolicy: "FIXED", shippingCost: "1500.50" } })
            const fixed = await (await fetch(`${baseUrl}/seller/shop/${profile.slug}`)).json() as { profile: Record<string, unknown> }
            assert.equal(fixed.profile.shippingPolicy, "FIXED")
            assert.equal(fixed.profile.shippingCost, "1500.5")
            // Nothing private came with it.
            assert.equal("businessPhone" in fixed.profile, false)
            assert.equal("latitude" in fixed.profile, false)
        })
    } finally {
        await fixture.cleanup()
    }
})

// ---- Several photos per listing ----

test("a listing can have up to five photos, the first is the card's picture, and they can be replaced and reordered", async () => {
    const fixture = await createCheckoutLifecycleFixture("listing-photos", 5, 1)

    try {
        const send = (body: Record<string, unknown>, method = "POST", path = "/listings") => fetch(`${fixture.baseUrl}${path}`, {
            method,
            headers: { "content-type": "application/json", cookie: `token=${fixture.sellerToken}` },
            body: JSON.stringify(body)
        })
        const photo = (name: string) => `https://images.example.test/${name}.jpg`
        const valid = { title: "Dress", description: "A red dress", price: 8000, category: "Fashion & Clothing", stockQuantity: 4 }
        const refused = async (body: Record<string, unknown>, message: RegExp) => {
            const response = await send(body)
            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80))
            assert.match((await response.json() as { message: string }).message, message)
        }

        await refused({ ...valid, imageUrls: [] }, /between 1 and 5 photos/)
        await refused({ ...valid, imageUrls: ["a", "b", "c", "d", "e", "f"].map(photo) }, /between 1 and 5 photos/)
        await refused({ ...valid, imageUrls: "not a list" }, /between 1 and 5 photos/)
        await refused({ ...valid, imageUrls: [photo("a"), "http://images.example.test/b.jpg"] }, /https links/)
        await refused({ ...valid, imageUrls: [photo("a"), 7] }, /https links/)
        await refused({ ...valid, imageUrls: [photo("a"), photo("a")] }, /only be added once/)
        await refused({ ...valid }, /All areas must be filled/)

        const created = await send({ ...valid, imageUrls: ["red", "blue", "green"].map(photo) })
        assert.equal(created.status, 201)
        const listing = await created.json() as { id: number; imageUrl: string; images: string[] }
        assert.deepEqual(listing.images, ["red", "blue", "green"].map(photo))
        assert.equal(listing.imageUrl, photo("red"))

        // The older single-photo request still works.
        const single = await send({ ...valid, imageUrl: photo("only") })
        const singleListing = await single.json() as { id: number; images: string[] }
        assert.equal(single.status, 201)
        assert.deepEqual(singleListing.images, [photo("only")])

        // Every place that shows a listing carries the photos.
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })
        const one = await (await fetch(`${fixture.baseUrl}/listings/${listing.id}`)).json() as { images: string[]; imageUrl: string }
        assert.deepEqual(one.images, ["red", "blue", "green"].map(photo))
        const all = (await (await fetch(`${fixture.baseUrl}/listings`)).json() as { listings: Array<{ id: number; images: string[] }> }).listings
        assert.deepEqual(all.find((candidate) => candidate.id === listing.id)?.images, ["red", "blue", "green"].map(photo))
        await withAppServer(async (appUrl) => {
            const shop = await (await fetch(`${appUrl}/seller/shop/${profile.slug}`)).json() as { listings: Array<{ id: number; images: string[] }> }
            assert.deepEqual(shop.listings.find((candidate) => candidate.id === listing.id)?.images, ["red", "blue", "green"].map(photo))
        })
        const mine = await (await fetch(`${fixture.baseUrl}/listings/Mylisting`, { headers: { cookie: `token=${fixture.sellerToken}` } })).json() as Array<{ id: number; images: string[] }>
        assert.deepEqual(mine.find((candidate) => candidate.id === listing.id)?.images, ["red", "blue", "green"].map(photo))

        // Reordering and replacing: the order sent is the order shown, and the card picture follows the first.
        const reordered = await send({ imageUrls: ["green", "red", "yellow", "pink", "black"].map(photo) }, "PATCH", `/listings/${listing.id}`)
        assert.equal(reordered.status, 200)
        const reorderedBody = await reordered.json() as { images: string[]; imageUrl: string }
        assert.deepEqual(reorderedBody.images, ["green", "red", "yellow", "pink", "black"].map(photo))
        assert.equal(reorderedBody.imageUrl, photo("green"))
        assert.equal(await prisma.listingImage.count({ where: { listingId: listing.id } }), 5)
        assert.equal((await send({ imageUrls: [] }, "PATCH", `/listings/${listing.id}`)).status, 400)
        assert.equal((await send({ imageUrls: [photo("a"), photo("a")] }, "PATCH", `/listings/${listing.id}`)).status, 400)

        // Editing something else leaves the photos alone; the old single field replaces them with one.
        const retitled = await (await send({ title: "Red dress" }, "PATCH", `/listings/${listing.id}`)).json() as { images: string[] }
        assert.equal(retitled.images.length, 5)
        const oneAgain = await (await send({ imageUrl: photo("solo") }, "PATCH", `/listings/${listing.id}`)).json() as { images: string[]; imageUrl: string }
        assert.deepEqual(oneAgain.images, [photo("solo")])
        assert.equal(oneAgain.imageUrl, photo("solo"))

        // A listing made before photos existed (no photo rows) falls back to its one picture.
        await prisma.listingImage.deleteMany({ where: { listingId: listing.id } })
        const legacy = await (await fetch(`${fixture.baseUrl}/listings/${listing.id}`)).json() as { images: string[] }
        assert.deepEqual(legacy.images, [photo("solo")])

        // Photos go with a listing that is deleted.
        await prisma.listingImage.create({ data: { listingId: singleListing.id, url: photo("extra"), position: 1 } })
        const deleted = await send({}, "DELETE", `/listings/${singleListing.id}`)
        assert.equal(deleted.status, 200)
        assert.equal(await prisma.listingImage.count({ where: { listingId: singleListing.id } }), 0)
    } finally {
        await prisma.listing.deleteMany({ where: { userId: fixture.sellerId, id: { not: fixture.listingId } } })
        await fixture.cleanup()
    }
})

// ---- Emails about accounts, orders, refunds and complaints; the 7-day delivery closing ----

async function addressesOf(fixture: CheckoutLifecycleFixture) {
    const consumer = await prisma.user.findUniqueOrThrow({ where: { id: fixture.consumerId } })
    const seller = await prisma.user.findUniqueOrThrow({ where: { id: fixture.sellerId } })
    return { buyer: consumer.email, seller: seller.email }
}

function subjectsTo(address: string) {
    return emailsTo(address).map((email) => email.subject)
}

test("a welcome email is sent once the email is confirmed, and a notice when the password changes", async () => {
    await withAppServer(async (baseUrl) => {
        const email = `welcome-${randomUUID()}@example.test`
        const sellerEmail = `welcome-seller-${randomUUID()}@example.test`

        try {
            await register(baseUrl, { name: "Ada Obi", email, password: goodPassword, role: "CONSUMER" })
            await register(baseUrl, { name: "Seller Sam", email: sellerEmail, password: goodPassword, role: "SELLER" })
            await waitForNotifications()
            assert.equal(subjectsTo(email).some((subject) => subject === "Welcome to StoreHatch"), false)

            const confirmed = await postJson(baseUrl, "/users/verify-email", { email, code: codeSentTo(email) })
            await postJson(baseUrl, "/users/verify-email", { email: sellerEmail, code: codeSentTo(sellerEmail) })
            await waitForNotifications()
            const welcome = emailsTo(email).find((mail) => mail.subject === "Welcome to StoreHatch")
            assert.ok(welcome)
            assert.match(welcome.text, /Welcome to StoreHatch, Ada Obi/)
            assert.match(welcome.text, new RegExp(config.frontendUrl.replace(/[.]/g, "\\.")))
            assert.match(emailsTo(sellerEmail).find((mail) => mail.subject === "Welcome to StoreHatch")?.text ?? "", /set up your shop/i)

            // Only once.
            assert.equal(emailsTo(email).filter((mail) => mail.subject === "Welcome to StoreHatch").length, 1)

            // Changing the password tells the owner, and the notice never contains the passwords.
            const access = cookiesFrom(confirmed).token?.value
            assert.ok(access)
            await postJson(baseUrl, "/users/change-password", { currentPassword: goodPassword, newPassword: "a-brand-new-password" }, `token=${access}`)
            await waitForNotifications()
            const notice = emailsTo(email).find((mail) => mail.subject === "Your password was changed")
            assert.ok(notice)
            assert.match(notice.text, /logged out of your other devices/)
            assert.equal(notice.text.includes(goodPassword) || notice.text.includes("a-brand-new-password"), false)

            // A reset sends one too.
            await postJson(baseUrl, "/users/forgot-password", { email })
            await postJson(baseUrl, "/users/reset-password", { email, code: codeSentTo(email), newPassword: "another-new-password" })
            await waitForNotifications()
            assert.equal(emailsTo(email).filter((mail) => mail.subject === "Your password was changed").length, 2)
            assert.ok(emailsTo(email).some((mail) => /was reset/.test(mail.text)))
        } finally {
            await deleteRegistered([email, sellerEmail])
        }
    })
})

test("a payment, shipping, delivery and its confirmation each email the right person exactly once", async () => {
    await withPaymentCheckout("order-emails", async (context) => {
        const { fixture, request, checkoutId } = context
        const { buyer, seller } = await addressesOf(fixture)
        const orderId = await payForCheckout(context)
        await waitForNotifications()

        const receipt = emailsTo(buyer).find((mail) => mail.subject === "Payment received: ₦3,000.00")
        assert.ok(receipt)
        assert.match(receipt.text, /2 × order-emails listing/)
        assert.match(receipt.text, new RegExp(`/orders/${checkoutId}`))
        // The receipt invites the buyer to open a shop too, after the sign-off; the seller's alert does not.
        assert.match(receipt.text, /The StoreHatch team\n\n---\nSell online too\? Open your own StoreHatch shop for free: .*\/seller\/register$/)
        const alert = emailsTo(seller).find((mail) => mail.subject === "New order: ₦3,000.00")
        assert.equal(alert?.text.includes("Sell online too"), false)
        assert.ok(alert)
        assert.match(alert.text, new RegExp(`/seller/orders/${orderId}`))
        // The seller is told where it goes, but never who the buyer is.
        assert.equal(alert.text.includes(buyer) || alert.text.includes("Test Consumer"), false)
        assert.equal(receipt.text.includes(seller), false)

        // A repeated payment check does not send them again.
        const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { checkoutId } })
        await request("GET", `/payments/${attempt.reference}`)
        await waitForNotifications()
        assert.equal(emailsTo(buyer).filter((mail) => mail.subject.startsWith("Payment received")).length, 1)

        await request("POST", `/seller/orders/${orderId}/ship`, { note: "Sent by Gokada rider" }, fixture.sellerToken)
        await request("POST", `/seller/orders/${orderId}/ship`, { note: "Sent by Gokada rider" }, fixture.sellerToken)
        await waitForNotifications()
        const shipped = emailsTo(buyer).filter((mail) => /has shipped$/.test(mail.subject))
        assert.equal(shipped.length, 1)
        assert.match(shipped[0]!.text, /Sent by Gokada rider/)

        await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        await waitForNotifications()
        const reported = emailsTo(buyer).filter((mail) => /says your order was delivered/.test(mail.subject))
        assert.equal(reported.length, 1)
        assert.match(reported[0]!.text, /within 7 days/)

        await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/confirm-delivery`, {})
        await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/confirm-delivery`, {})
        await waitForNotifications()
        assert.equal(emailsTo(seller).filter((mail) => mail.subject === `Order #${orderId} was confirmed as received`).length, 1)
    })
})

test("complaints email the other side at each step, with a short excerpt and a link, and never the other side's contact details", async () => {
    await withPaymentCheckout("complaint-emails", async (context) => {
        const { fixture, request, adminToken, checkoutId } = context
        const { buyer, seller } = await addressesOf(fixture)
        const orderId = await payAndShip(context)
        const opened = await complain(context, orderId)
        const id = opened.body.dispute.id as number
        await waitForNotifications()

        const newComplaint = emailsTo(seller).find((mail) => mail.subject === `New complaint about order #${orderId}: please answer`)
        assert.ok(newComplaint)
        assert.match(newComplaint.text, /cracked casing/)
        assert.match(newComplaint.text, new RegExp(`/seller/disputes/${id}`))
        assert.equal(newComplaint.text.includes(buyer), false)
        // Nobody emailed the buyer about their own message.
        assert.equal(subjectsTo(buyer).some((subject) => /^(New complaint|The seller replied|The complaint)/.test(subject)), false)

        await request("POST", `/seller/disputes/${id}/respond`, { action: "AGREE_TO_REFUND", message: "Sorry about that, please refund this buyer." }, fixture.sellerToken)
        await waitForNotifications()
        const replied = emailsTo(buyer).find((mail) => mail.subject === `The seller replied about order #${orderId}`)
        assert.ok(replied)
        assert.match(replied.text, /agreed, and it is waiting for StoreHatch to approve/)
        assert.match(replied.text, new RegExp(`/disputes/${id}`))
        assert.equal(replied.text.includes(seller), false)

        await request("POST", `/admin/disputes/${id}/messages`, { message: "We are checking the photos you sent." }, adminToken)
        await waitForNotifications()
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === `StoreHatch wrote in the complaint about order #${orderId}`))
        assert.ok(emailsTo(seller).some((mail) => mail.subject === `StoreHatch wrote in the complaint about order #${orderId}`))

        await request("POST", `/admin/disputes/${id}/reject`, { note: "The photos do not show damage, so this is not approved." }, adminToken)
        await waitForNotifications()
        for (const address of [buyer, seller]) {
            const decision = emailsTo(address).find((mail) => mail.subject === `StoreHatch's decision on the complaint about order #${orderId}`)
            assert.ok(decision, address)
            assert.match(decision.text, /did not approve a refund/)
            assert.match(decision.text, /do not show damage/)
        }
        assert.ok(checkoutId)
    })
})

test("a withdrawn complaint, a seller's refund offer and an escalation are each emailed", async () => {
    await withPaymentCheckout("complaint-emails-more", async (context) => {
        const { fixture, request } = context
        const { buyer, seller } = await addressesOf(fixture)
        const orderId = await payAndShip(context)

        const offer = await request("POST", `/seller/orders/${orderId}/refund-offer`, { message: "I would like to refund this order, sorry." }, fixture.sellerToken)
        assert.equal(offer.status, 201)
        await waitForNotifications()
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === `The seller offered you a refund for order #${orderId}`))
        await request("POST", `/seller/disputes/${offer.body.dispute.id}/withdraw`, {}, fixture.sellerToken)
        await waitForNotifications()
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === `The complaint about order #${orderId} was withdrawn`))
        assert.ok(emailsTo(seller).some((mail) => mail.subject === `The complaint about order #${orderId} was withdrawn`))

        const complaint = await complain(context, orderId)
        const id = complaint.body.dispute.id as number
        await prisma.dispute.update({ where: { id }, data: { responseDueAt: new Date(Date.now() - 1000) } })
        await escalateOverdueDisputes()
        await waitForNotifications()
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === `The complaint about order #${orderId} was passed to StoreHatch`))
        assert.ok(emailsTo(seller).some((mail) => mail.subject === `The complaint about order #${orderId} was passed to StoreHatch`))
    })
})

test("a refund emails the buyer as it starts and as it completes, and tells the seller they owe it", async () => {
    await withPaymentCheckout("refund-emails", async (context) => {
        const { fixture, request, adminToken, fakes } = context
        const { buyer, seller } = await addressesOf(fixture)
        const orderId = await payAndShip(context)
        const refunded = await request("POST", `/admin/orders/${orderId}/refunds`, { amount: 1000, reason: "Goodwill refund for a late delivery" }, adminToken)
        assert.equal(refunded.status, 201)
        await waitForNotifications()

        const started = emailsTo(buyer).find((mail) => mail.subject === "Your refund of ₦1,000.00 has started")
        assert.ok(started)
        assert.match(started.text, new RegExp(`order #${orderId}`))
        const charged = emailsTo(seller).find((mail) => mail.subject === `StoreHatch refunded a buyer for order #${orderId}`)
        assert.ok(charged)
        assert.match(charged.text, /₦1,000\.00/)
        assert.match(charged.text, /Goodwill refund for a late delivery/)
        assert.match(charged.text, /at most half/)
        // The seller is told, but the buyer never sees the reason the seller was charged.
        assert.equal(started.text.includes("Goodwill"), false)

        // Checking again while it is still processing sends nothing more.
        await request("POST", `/admin/refunds/${refunded.body.refund.id}/sync`, {}, adminToken)
        await waitForNotifications()
        assert.equal(emailsTo(buyer).filter((mail) => mail.subject.startsWith("Your refund of")).length, 1)

        // When the provider reports it done, the buyer is told once.
        const stored = await prisma.refund.findUniqueOrThrow({ where: { id: refunded.body.refund.id } })
        fakes.behaviors.PAYSTACK.findRefunds = async () => [fakeProviderRefund({
            providerRefundId: stored.providerRefundId ?? "unknown", amountKobo: 100000, outcome: "succeeded", providerStatus: "processed"
        })]
        await request("POST", `/admin/refunds/${refunded.body.refund.id}/sync`, {}, adminToken)
        await request("POST", `/admin/refunds/${refunded.body.refund.id}/sync`, {}, adminToken)
        await waitForNotifications()
        assert.equal(emailsTo(buyer).filter((mail) => mail.subject === "Your refund of ₦1,000.00 is complete").length, 1)
        assert.equal(emailsTo(seller).filter((mail) => mail.subject.startsWith("StoreHatch refunded a buyer")).length, 1)
    })
})

test("emails that cannot be sent never undo or delay what they are about", async (t) => {
    await withPaymentCheckout("email-failure", async (context) => {
        const consoleError = t.mock.method(console, "error", () => {})
        setEmailSenderForTesting(async () => { throw new Error("the email service is down") })

        try {
            const orderId = await payForCheckout(context)
            await waitForNotifications()
            const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
            assert.equal(order.status, "PAID")
            assert.ok(consoleError.mock.calls.some((call) => call.arguments[0] === "Could not send an email"))
        } finally {
            setEmailSenderForTesting(async (email) => { sentEmails.push(email) })
        }
    })
})

// A shipped order whose seller reported delivery `days` ago.
async function shippedAndReportedDelivered(context: PaymentTestContext, days: number) {
    const orderId = await payAndShip(context)
    await context.request("POST", `/seller/orders/${orderId}/delivered`, {}, context.fixture.sellerToken)
    await prisma.order.update({ where: { id: orderId }, data: { deliveryReportedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } })
    return orderId
}

test("a buyer is reminded 4 days after the seller reports delivery, and the order closes as delivered at 7 days", async () => {
    await withPaymentCheckout("delivery-closing", async (context) => {
        const { fixture, request, checkoutId } = context
        const { buyer, seller } = await addressesOf(fixture)
        const orderId = await shippedAndReportedDelivered(context, 2)

        // Too early for anything.
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 0, reminded: 0 })

        // Day 5: a reminder, once.
        await prisma.order.update({ where: { id: orderId }, data: { deliveryReportedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) } })
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 0, reminded: 1 })
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 0, reminded: 0 })
        await waitForNotifications()
        const reminders = emailsTo(buyer).filter((mail) => mail.subject === "Did your order arrive?")
        assert.equal(reminders.length, 1)
        assert.match(reminders[0]!.text, /closed as delivered on/)
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status, "SHIPPED")

        // Day 8: closed automatically, and both sides are told.
        await prisma.order.update({ where: { id: orderId }, data: { deliveryReportedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 1, reminded: 0 })
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 0, reminded: 0 })
        await waitForNotifications()
        const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        assert.equal(order.status, "DELIVERED")
        assert.ok(order.deliveryAutoClosedAt)
        assert.equal(order.deliveryConfirmedAt, null)
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === "Your order was closed as delivered"))
        assert.ok(emailsTo(seller).some((mail) => mail.subject === `Order #${orderId} was closed as delivered`))

        // Both sides can see it was automatic, and the buyer's own confirmation was not claimed.
        const buyerView = await request("GET", `/orders/${checkoutId}`)
        assert.equal(buyerView.body.sellerOrders[0].status, "DELIVERED")
        assert.ok(buyerView.body.sellerOrders[0].deliveryAutoClosedAt)
        assert.equal(buyerView.body.sellerOrders[0].deliveryConfirmedAt, null)
        const sellerView = await request("GET", `/seller/orders/${orderId}`, undefined, fixture.sellerToken)
        assert.ok(sellerView.body.deliveryAutoClosedAt)

        // Silence is not proof of receipt: the buyer can still say it never arrived.
        const complaint = await complain(context, orderId, { reason: "NOT_RECEIVED", message: "Nothing ever arrived at my address." })
        assert.equal(complaint.status, 201)
    })
})

test("an order the buyer confirmed, or that has an open complaint, is never closed or reminded automatically", async () => {
    await withPaymentCheckout("delivery-closing-skips", async (context) => {
        const { request, checkoutId } = context
        const confirmedOrder = await shippedAndReportedDelivered(context, 9)
        await request("POST", `/orders/${checkoutId}/seller-orders/${confirmedOrder}/confirm-delivery`, {})
        const order = await prisma.order.findUniqueOrThrow({ where: { id: confirmedOrder } })
        assert.ok(order.deliveryConfirmedAt)
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 0, reminded: 0 })
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: confirmedOrder } })).deliveryAutoClosedAt, null)
    })

    await withPaymentCheckout("delivery-closing-complaint", async (context) => {
        const orderId = await shippedAndReportedDelivered(context, 9)
        const complaint = await complain(context, orderId)
        assert.equal(complaint.status, 201)

        // An open complaint holds the order open, whatever its age.
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 0, reminded: 0 })
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status, "SHIPPED")

        // Once the complaint is withdrawn the order can close.
        await context.request("POST", `/disputes/${complaint.body.dispute.id}/withdraw`, {})
        assert.deepEqual(await remindAndCloseDeliveries(), { closed: 1, reminded: 0 })
    })
})

// ---- Reviews ----

// A paid order that has been shipped, reported delivered and confirmed by the buyer.
async function payShipDeliverConfirm(context: PaymentTestContext) {
    const orderId = await payAndShip(context)
    await context.request("POST", `/seller/orders/${orderId}/delivered`, {}, context.fixture.sellerToken)
    const confirmed = await context.request("POST", `/orders/${context.checkoutId}/seller-orders/${orderId}/confirm-delivery`, {})
    assert.equal(confirmed.status, 200)
    return orderId
}

// Other buyers who have left reviews, made straight in the database so a test can have several.
async function addOtherReviewers(context: PaymentTestContext, orderId: number, ratings: number[]) {
    const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: context.fixture.sellerId } })
    const users = []

    for (const rating of ratings) {
        const user = await prisma.user.create({
            data: { name: `Reviewer ${rating}`, email: `reviewer-${randomUUID()}@example.test`, passwordHash: "integration-test-not-a-password", role: "CONSUMER" }
        })
        await prisma.productReview.create({ data: { listingId: context.fixture.listingId, buyerId: user.id, orderId, rating } })
        await prisma.shopReview.create({ data: { sellerProfileId: profile.id, buyerId: user.id, orderId, rating } })
        users.push(user)
    }

    // The app keeps each rating up to date as reviews change; reviews made directly need the same step.
    await prisma.$transaction(async (tx) => {
        await recalculateRating(tx, "product", context.fixture.listingId)
        await recalculateRating(tx, "shop", profile.id)
    })

    return users
}

async function removeUsers(users: Array<{ id: number }>) {
    await prisma.productReview.deleteMany({ where: { buyerId: { in: users.map((user) => user.id) } } })
    await prisma.shopReview.deleteMany({ where: { buyerId: { in: users.map((user) => user.id) } } })
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } })
}

test("only a buyer whose order was delivered can review it, and what is allowed is checked", async () => {
    await withPaymentCheckout("review-rules", async (context) => {
        const { fixture, request, checkoutId } = context
        const orderId = await payAndShip(context)
        const path = `/orders/${checkoutId}/seller-orders/${orderId}/reviews`
        const review = (body: unknown, token = fixture.token) => request("POST", path, body, token)
        const listingId = fixture.listingId

        // Not before it is delivered.
        const early = await request("GET", path)
        assert.equal(early.body.canReview, false)
        const tooEarly = await review({ shop: { rating: 5 } })
        assert.equal(tooEarly.status, 409)
        assert.equal(tooEarly.body.code, "REVIEW_NOT_ALLOWED")

        await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/confirm-delivery`, {})
        const state = await request("GET", path)
        assert.equal(state.body.canReview, true)
        assert.deepEqual(state.body.products, [{ listingId, title: "review-rules listing", review: null }])
        assert.equal(state.body.shop, null)

        // Bad requests.
        const refused = async (body: unknown, message: RegExp) => {
            const response = await review(body)
            assert.equal(response.status, 400, JSON.stringify(body))
            assert.match(response.body.message, message)
        }
        await refused({}, /shop, a product, or both/)
        await refused({ shop: {} }, /1 to 5/)
        await refused({ shop: { rating: 0 } }, /1 to 5/)
        await refused({ shop: { rating: 6 } }, /1 to 5/)
        await refused({ shop: { rating: 4.5 } }, /1 to 5/)
        await refused({ shop: { rating: "5" } }, /1 to 5/)
        await refused({ shop: null }, /1 to 5/)
        await refused({ shop: { rating: 5, comment: "c".repeat(1001) } }, /1000 characters/)
        await refused({ shop: { rating: 5, comment: { x: 1 } } }, /1000 characters/)
        await refused({ products: [] }, /1 to 20/)
        await refused({ products: "x" }, /1 to 20/)
        await refused({ products: [{ rating: 5 }] }, /listingId/)
        await refused({ products: [{ listingId, rating: 9 }] }, /1 to 5/)
        await refused({ products: [{ listingId, rating: 5 }, { listingId, rating: 4 }] }, /only be reviewed once/)
        await refused({ products: [{ listingId: listingId + 999999, rating: 5 }] }, /only review products from this order/)
        assert.equal(await prisma.productReview.count({ where: { listingId } }), 0)

        // Someone else's order is not theirs to review.
        const other = await fixture.addConsumer(1)
        assert.equal((await review({ shop: { rating: 5 } }, other.token)).status, 404)
        assert.equal((await request("GET", path, undefined, other.token)).status, 404)
        assert.equal((await review({ shop: { rating: 5 } }, fixture.sellerToken)).status, 404)
        assert.equal((await request("POST", `/orders/${checkoutId}/seller-orders/999999999/reviews`, { shop: { rating: 5 } })).status, 404)

        // Blank comments mean no comment; control characters are dropped.
        const created = await review({ shop: { rating: 4, comment: "   " }, products: [{ listingId, rating: 5, comment: "Great\u0000 charger\n\n\n\nworks well" }] })
        assert.equal(created.status, 201)
        assert.equal(created.body.shop.comment, null)
        assert.equal(created.body.products[0].comment, "Great charger\n\nworks well")

        // Once each.
        const again = await review({ products: [{ listingId, rating: 1 }] })
        assert.equal(again.status, 409)
        assert.equal(again.body.code, "REVIEW_EXISTS")
        assert.equal((await review({ shop: { rating: 1 } })).status, 409)
        assert.equal(await prisma.productReview.count({ where: { listingId } }), 1)
    })
})

test("an order closed automatically after 7 days of silence can be reviewed, and a refunded one cannot", async () => {
    await withPaymentCheckout("review-auto-closed", async (context) => {
        const { fixture, request, checkoutId } = context
        const orderId = await payAndShip(context)
        await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        await prisma.order.update({ where: { id: orderId }, data: { deliveryReportedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
        await remindAndCloseDeliveries()
        const path = `/orders/${checkoutId}/seller-orders/${orderId}/reviews`
        assert.equal((await request("GET", path)).body.canReview, true)
        assert.equal((await request("POST", path, { shop: { rating: 3 } })).status, 201)

        await prisma.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } })
        assert.equal((await request("GET", path)).body.canReview, false)
    })
})

test("ratings and reviews show on listings, shops and the public review lists, without anything private", async () => {
    await withPaymentCheckout("review-public", async (context) => {
        const { fixture, request, checkoutId } = context
        const orderId = await payShipDeliverConfirm(context)
        const listingId = fixture.listingId
        const slug = (await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })).slug

        // No reviews yet: no average, a count of zero.
        const before = (await request("GET", `/listings/${listingId}`)).body
        assert.equal(before.ratingAverage, null)
        assert.equal(before.ratingCount, 0)
        assert.equal("ratingSum" in before, false)

        const created = await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`, {
            shop: { rating: 4, comment: "Quick and friendly" },
            products: [{ listingId, rating: 5, comment: "Works perfectly" }]
        })
        assert.equal(created.status, 201)
        const others = await addOtherReviewers(context, orderId, [2, 2])

        try {
            // Re-count with the others included, by hiding and showing nothing: a new review through the app recalculates,
            // so recalculate by changing the buyer's own review to the same rating.
            await request("PATCH" as "GET", `/reviews/products/${created.body.products[0].id}`, { rating: 5 })
            await request("PATCH" as "GET", `/reviews/shops/${created.body.shop.id}`, { rating: 4 })

            const listing = (await request("GET", `/listings/${listingId}`)).body
            assert.equal(listing.ratingCount, 3)
            assert.equal(listing.ratingAverage, 3)
            assert.equal("ratingSum" in listing, false)
            const inList = ((await request("GET", "/listings")).body.listings as Array<{ id: number; ratingAverage: number | null; ratingCount: number }>).find((item) => item.id === listingId)
            assert.deepEqual([inList?.ratingAverage, inList?.ratingCount], [3, 3])

            const shop = (await request("GET", `/seller/shop/${slug}`)).body
            assert.equal(shop.profile.ratingCount, 3)
            assert.equal(shop.profile.ratingAverage, 2.7)
            assert.equal("ratingSum" in shop.profile, false)
            assert.equal(shop.listings[0].ratingAverage, 3)
            const shops = (await request("GET", "/seller/shops?category=Electronics")).body as Array<{ id: number; ratingAverage: number | null; ratingCount: number }>
            const card = shops.find((candidate) => candidate.id === shop.profile.id)
            assert.deepEqual([card?.ratingAverage, card?.ratingCount], [2.7, 3])
            assert.equal("ratingSum" in (card ?? {}), false)
            const mine = (await request("GET", "/seller/profile", undefined, fixture.sellerToken)).body
            assert.equal(mine.ratingAverage, 2.7)

            // The public list: newest first, with the count of each star, and only a first name and initial.
            const list = (await request("GET", `/listings/${listingId}/reviews`)).body
            assert.equal(list.summary.average, 3)
            assert.equal(list.summary.count, 3)
            assert.deepEqual(list.summary.distribution, { "1": 0, "2": 2, "3": 0, "4": 0, "5": 1 })
            assert.equal(list.reviews.length, 3)
            assert.ok(list.reviews.some((item: { reviewer: string; comment: string }) => item.reviewer === "review-public C." && item.comment === "Works perfectly"))
            assert.ok(list.reviews.some((item: { reviewer: string }) => item.reviewer === "Reviewer 2."))
            const text = JSON.stringify(list)
            assert.equal(text.includes("@example.test") || text.includes("buyerId") || text.includes("orderId") || text.includes("hidden"), false)
            const shopList = (await request("GET", `/seller/shop/${slug}/reviews`)).body
            assert.equal(shopList.summary.count, 3)
            assert.equal(shopList.summary.average, 2.7)
            assert.equal((await request("GET", `/listings/${listingId}/reviews?page=2`)).body.reviews.length, 0)

            // Bad requests and things that are not there.
            assert.equal((await request("GET", `/listings/${listingId}/reviews?page=0`)).status, 400)
            assert.equal((await request("GET", "/listings/999999999/reviews")).status, 404)
            assert.equal((await request("GET", "/listings/abc/reviews")).status, 404)
            assert.equal((await request("GET", "/seller/shop/no-such-shop/reviews")).status, 404)

            // An archived listing's reviews are not public.
            await request("POST", `/listings/${listingId}/archive`, {}, fixture.sellerToken)
            assert.equal((await request("GET", `/listings/${listingId}/reviews`)).status, 404)
        } finally {
            await removeUsers(others)
        }
    })
})

test("a buyer can change or remove their review for a week, and the rating follows", async () => {
    await withPaymentCheckout("review-edit", async (context) => {
        const { fixture, request, checkoutId } = context
        const orderId = await payShipDeliverConfirm(context)
        const listingId = fixture.listingId
        const created = (await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`, {
            shop: { rating: 5 },
            products: [{ listingId, rating: 5, comment: "Lovely" }]
        })).body
        const productId = created.products[0].id as number
        const shopId = created.shop.id as number
        const patch = (path: string, body: unknown, token = fixture.token) => request("PATCH" as "GET", path, body, token)
        const average = async () => ((await request("GET", `/listings/${listingId}`)).body as { ratingAverage: number | null }).ratingAverage

        assert.equal(await average(), 5)
        const changed = await patch(`/reviews/products/${productId}`, { rating: 3, comment: "Okay after a week of use" })
        assert.equal(changed.status, 200)
        assert.equal(changed.body.review.rating, 3)
        assert.equal(await average(), 3)
        const list = (await request("GET", `/listings/${listingId}/reviews`)).body
        assert.equal(list.reviews[0].comment, "Okay after a week of use")
        assert.equal(list.reviews[0].edited, false, "changed within a second of writing")

        // Clearing the comment, and the things that are refused.
        assert.equal((await patch(`/reviews/products/${productId}`, { comment: null })).body.review.comment, null)
        assert.equal((await patch(`/reviews/products/${productId}`, {})).status, 400)
        assert.equal((await patch(`/reviews/products/${productId}`, { rating: 7 })).status, 400)
        assert.equal((await patch(`/reviews/products/${productId}`, { comment: "c".repeat(1001) })).status, 400)
        assert.equal((await patch(`/reviews/gifts/${productId}`, { rating: 1 })).status, 404)
        assert.equal((await patch("/reviews/products/999999999", { rating: 1 })).status, 404)
        const other = await fixture.addConsumer(1)
        assert.equal((await patch(`/reviews/products/${productId}`, { rating: 1 }, other.token)).status, 404)
        assert.equal((await request("DELETE" as "GET", `/reviews/products/${productId}`, undefined, other.token)).status, 404)
        assert.equal((await patch(`/reviews/products/${productId}`, { rating: 1 }, fixture.sellerToken)).status, 404)

        // Removing takes it out of the rating, and the product can be reviewed again.
        assert.equal((await request("DELETE" as "GET", `/reviews/products/${productId}`)).status, 200)
        assert.equal(await average(), null)
        assert.equal(((await request("GET", `/listings/${listingId}`)).body as { ratingCount: number }).ratingCount, 0)
        assert.equal((await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`, { products: [{ listingId, rating: 4 }] })).status, 201)

        // After a week it is final.
        await prisma.shopReview.update({ where: { id: shopId }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
        const locked = await patch(`/reviews/shops/${shopId}`, { rating: 1 })
        assert.equal(locked.status, 409)
        assert.equal(locked.body.code, "REVIEW_LOCKED")
        assert.equal((await request("DELETE" as "GET", `/reviews/shops/${shopId}`)).status, 409)
        assert.equal((await request("GET", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`)).body.shop.canChange, false)
    })
})

test("a seller can report a review of their shop and an administrator can hide it, which takes it out of the rating", async () => {
    await withPaymentCheckout("review-moderation", async (context) => {
        const { fixture, request, checkoutId, adminToken } = context
        const orderId = await payShipDeliverConfirm(context)
        const listingId = fixture.listingId
        const created = (await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`, {
            shop: { rating: 1, comment: "Terrible, they are scammers" },
            products: [{ listingId, rating: 1, comment: "Rubbish" }]
        })).body
        const productId = created.products[0].id as number
        const shopId = created.shop.id as number
        const others = await addOtherReviewers(context, orderId, [5, 5])

        try {
            await waitForNotifications()
            // The seller is told about it, with the words, and can look at them.
            const sellerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.sellerId } })).email
            const notice = emailsTo(sellerEmail).find((mail) => mail.subject === "A buyer reviewed your order")
            assert.ok(notice)
            assert.match(notice.text, /Terrible, they are scammers/)
            const mineShop = (await request("GET", "/seller/reviews", undefined, fixture.sellerToken)).body
            assert.equal(mineShop.total, 3)
            assert.equal(mineShop.reviews.find((item: { id: number }) => item.id === shopId).reported, false)
            const mineProducts = (await request("GET", "/seller/reviews?type=product", undefined, fixture.sellerToken)).body
            assert.equal(mineProducts.reviews.find((item: { id: number }) => item.id === productId).listing.title, "review-moderation listing")
            assert.equal((await request("GET", "/seller/reviews?type=gift", undefined, fixture.sellerToken)).status, 400)

            // Reporting: only the seller it is about, with a reason.
            const report = (kind: string, id: number, body: unknown, token = fixture.sellerToken) => request("POST", `/seller/reviews/${kind}/${id}/report`, body, token)
            assert.equal((await report("shops", shopId, {})).status, 400)
            assert.equal((await report("shops", shopId, { reason: "no" })).status, 400)
            assert.equal((await report("gifts", shopId, { reason: "Not true at all" })).status, 404)
            assert.equal((await report("shops", shopId, { reason: "Not true at all" }, fixture.token)).status, 403)
            await withStrangerSeller(async (strangerToken) => {
                assert.equal((await report("shops", shopId, { reason: "Not true at all" }, strangerToken)).status, 404)
                assert.equal((await report("products", productId, { reason: "Not true at all" }, strangerToken)).status, 404)
            })
            assert.equal((await report("shops", shopId, { reason: "This buyer never received anything wrong and is lying" })).status, 200)
            assert.equal((await report("shops", shopId, { reason: "Reporting again changes nothing here" })).status, 200)
            assert.equal((await report("products", productId, { reason: "A competitor wrote this review" })).status, 200)
            assert.equal(((await request("GET", "/seller/reviews", undefined, fixture.sellerToken)).body.reviews.find((item: { id: number }) => item.id === shopId)).reported, true)

            // The administrator sees what was reported, with the reason and who wrote it.
            const reported = await request("GET", "/admin/reviews?type=shop", undefined, adminToken)
            assert.equal(reported.status, 200)
            assert.equal(reported.body.total, 1)
            assert.equal(reported.body.reviews[0].id, shopId)
            assert.match(reported.body.reviews[0].reportReason, /never received anything wrong/)
            assert.match(reported.body.reviews[0].buyer.email, /review-moderation-consumer/)
            assert.equal(reported.body.reviews[0].subject.businessName, "review-moderation Shop")
            assert.equal((await request("GET", "/admin/reviews?type=shop", undefined, fixture.sellerToken)).status, 403)
            assert.equal((await request("GET", "/admin/reviews?status=pending", undefined, adminToken)).status, 400)
            assert.equal((await request("GET", "/admin/reviews?type=gift", undefined, adminToken)).status, 400)

            // Hiding needs a reason and removes it from the lists and from the average.
            const slug = (await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })).slug
            assert.equal(((await request("GET", `/seller/shop/${slug}`)).body.profile).ratingAverage, 3.7)
            assert.equal((await request("POST", `/admin/reviews/shops/${shopId}/hide`, {}, adminToken)).status, 400)
            assert.equal((await request("POST", `/admin/reviews/shops/${shopId}/hide`, { reason: "Untrue claim about scams" }, fixture.sellerToken)).status, 403)
            assert.equal((await request("POST", "/admin/reviews/shops/999999999/hide", { reason: "Untrue claim about scams" }, adminToken)).status, 404)
            assert.equal((await request("POST", `/admin/reviews/shops/${shopId}/hide`, { reason: "Untrue claim about scams" }, adminToken)).status, 200)
            const shop = (await request("GET", `/seller/shop/${slug}`)).body.profile
            assert.equal(shop.ratingCount, 2)
            assert.equal(shop.ratingAverage, 5)
            assert.equal((await request("GET", `/seller/shop/${slug}/reviews`)).body.reviews.some((item: { id: number }) => item.id === shopId), false)
            assert.equal((await request("GET", "/admin/reviews?type=shop", undefined, adminToken)).body.total, 0)
            const hidden = await request("GET", "/admin/reviews?type=shop&status=hidden", undefined, adminToken)
            assert.equal(hidden.body.reviews[0].hiddenReason, "Untrue claim about scams")
            // The buyer is told it is hidden, and the seller can see it is.
            assert.equal((await request("GET", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`)).body.shop.hidden, true)
            assert.equal(((await request("GET", "/seller/reviews", undefined, fixture.sellerToken)).body.reviews.find((item: { id: number }) => item.id === shopId)).hidden, true)

            // Showing it again puts it back.
            assert.equal((await request("POST", `/admin/reviews/shops/${shopId}/show`, {}, adminToken)).status, 200)
            assert.equal((await request("GET", `/seller/shop/${slug}`)).body.profile.ratingCount, 3)

            // Products too.
            assert.equal((await request("POST", `/admin/reviews/products/${productId}/hide`, { reason: "A competitor wrote this" }, adminToken)).status, 200)
            assert.equal(((await request("GET", `/listings/${listingId}`)).body as { ratingAverage: number }).ratingAverage, 5)
            assert.equal((await request("GET", `/listings/${listingId}/reviews`)).body.summary.count, 2)
        } finally {
            await removeUsers(others)
        }
    })
})

// ---- Pre-orders for food shops ----

const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

// Makes the fixture's one listing food and sets how the shop takes orders.
async function makeFoodShop(context: PaymentTestContext, type: "NOW" | "PRE_ORDER" | "BOTH") {
    await prisma.listing.update({ where: { id: context.fixture.listingId }, data: { category: "Food & Grocery" } })
    const response = await context.request("PATCH" as "GET", "/seller/profile", { foodOrderType: type }, context.fixture.sellerToken)
    assert.equal(response.status, 200)
    assert.equal(response.body.foodOrderType, type)
}

async function shopSlug(context: PaymentTestContext) {
    return (await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: context.fixture.sellerId } })).slug
}

// Asks the shop for a pre-order of what is in the buyer's cart.
function askForPreOrder(context: PaymentTestContext, body: Record<string, unknown> = {}, token = context.fixture.token) {
    return shopSlug(context).then((slug) => context.request("POST", "/pre-orders", { sellerSlug: slug, readyAt: inHours(48), ...body }, token))
}

// Creates a checkout from the cart, as the checkout page does: look at the prices, then confirm.
async function checkoutFromCart(context: PaymentTestContext, preOrderIds?: number[]) {
    const preview = await context.request("GET", "/checkout/preview")
    assert.equal(preview.status, 200)
    return context.request("POST", "/checkout", {
        reviewToken: preview.body.reviewToken,
        delivery: fixtureDelivery,
        ...(preOrderIds ? { preOrderIds } : {})
    })
}

async function payCheckout(context: PaymentTestContext, checkoutId: number) {
    const started = await context.request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" })
    assert.equal(started.status, 201)
    const reference = started.body.payment.reference as string
    context.fakes.behaviors.PAYSTACK.verify = async () => paystackVerification("success", reference)
    await context.request("GET", `/payments/${reference}`)
    const [order] = await prisma.order.findMany({ where: { checkoutId } })
    assert.equal(order?.status, "PAID")
    return order!.id
}

test("only a shop that sells food can take pre-orders, and the setting is shown to shoppers", async () => {
    await withPaymentCheckout("preorder-setting", async (context) => {
        const { fixture, request } = context
        const patch = (body: unknown, token = fixture.sellerToken) => request("PATCH" as "GET", "/seller/profile", body, token)

        // A shop with no food cannot take pre-orders.
        const noFood = await patch({ foodOrderType: "PRE_ORDER" })
        assert.equal(noFood.status, 400)
        assert.match(noFood.body.message, /Food & Grocery/)
        assert.equal((await patch({ foodOrderType: "SOMETIMES" })).status, 400)
        assert.equal((await patch({ foodOrderType: "BOTH" }, fixture.token)).status, 403)

        await makeFoodShop(context, "PRE_ORDER")
        const slug = await shopSlug(context)
        assert.equal((await request("GET", `/seller/shop/${slug}`)).body.profile.foodOrderType, "PRE_ORDER")
        assert.equal((await request("GET", "/seller/profile", undefined, fixture.sellerToken)).body.foodOrderType, "PRE_ORDER")
        const shops = (await request("GET", "/seller/shops?category=Food%20%26%20Grocery")).body as Array<{ slug: string; foodOrderType: string }>
        assert.equal(shops.find((shop) => shop.slug === slug)?.foodOrderType, "PRE_ORDER")

        assert.equal((await patch({ foodOrderType: "BOTH" })).body.foodOrderType, "BOTH")
        assert.equal((await patch({ foodOrderType: "NOW" })).body.foodOrderType, "NOW")
    })
})

test("a buyer asks for a pre-order, the seller approves, and the paid order carries the ready time", async () => {
    await withPaymentCheckout("preorder-flow", async (context) => {
        const { fixture, request, checkoutId } = context
        const buyer = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.consumerId } })).email
        const seller = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.sellerId } })).email
        await makeFoodShop(context, "PRE_ORDER")

        // This shop only takes pre-orders: the preview says so, and a plain checkout is refused.
        const preview = await request("GET", "/checkout/preview")
        assert.equal(preview.body.sellers[0].orderType, "PRE_ORDER")
        assert.deepEqual(preview.body.sellers[0].preOrder, { required: true, approved: null })
        const refused = await checkoutFromCart(context)
        assert.equal(refused.status, 409)
        assert.equal(refused.body.code, "CHECKOUT_PREORDER_REQUIRED")
        assert.equal(refused.body.seller.businessName, "preorder-flow Shop")

        // Asking: the time must be sensible, and the buyer needs something in the cart.
        for (const body of [{ readyAt: "tomorrow" }, { readyAt: "2026-11-02T14:00:00" }, { readyAt: 12345 }, { readyAt: inHours(2) }, { readyAt: inHours(24 * 31) }, { note: 42 }, { note: "n".repeat(501) }]) {
            const response = await askForPreOrder(context, body)
            assert.equal(response.status, 400, JSON.stringify(body))
        }
        assert.equal((await request("POST", "/pre-orders", { readyAt: inHours(48) })).status, 400)
        assert.equal((await request("POST", "/pre-orders", { sellerSlug: "no-such-shop", readyAt: inHours(48) })).status, 404)
        assert.equal((await askForPreOrder(context, {}, fixture.sellerToken)).status, 409)
        const empty = await fixture.addConsumer(1)
        await prisma.cartItem.deleteMany({ where: { cart: { userId: empty.id } } })
        assert.equal((await askForPreOrder(context, {}, empty.token)).body.code, "PREORDER_CART_EMPTY")

        const readyAt = inHours(48)
        const asked = await askForPreOrder(context, { readyAt, note: "For my daughter's birthday" })
        assert.equal(asked.status, 201)
        const preOrder = asked.body.preOrder
        assert.equal(preOrder.status, "REQUESTED")
        assert.equal(preOrder.subtotal, "3000.00")
        assert.deepEqual(preOrder.items, [{ listingId: fixture.listingId, title: "preorder-flow listing", quantity: 2, unitPrice: "1500.00", imageUrl: "https://example.test/listing.png", optionLabel: null, sizeLabel: null }])
        assert.equal(preOrder.note, "For my daughter's birthday")
        assert.equal(preOrder.seller.businessName, "preorder-flow Shop")
        const answerWithin = (new Date(preOrder.respondBy).getTime() - Date.now()) / 3_600_000
        assert.ok(answerWithin > 47.9 && answerWithin <= 48)
        // One open request per shop.
        const again = await askForPreOrder(context)
        assert.equal(again.status, 409)
        assert.equal(again.body.code, "PREORDER_EXISTS")
        assert.equal(again.body.preOrderId, preOrder.id)

        await waitForNotifications()
        assert.ok(emailsTo(seller).some((mail) => mail.subject === "A buyer asked for a pre-order" && /For my daughter's birthday/.test(mail.text)))

        // The seller sees it, with the buyer's first name only, and can count what is waiting.
        assert.equal((await request("GET", "/seller/pre-orders/awaiting-answer", undefined, fixture.sellerToken)).body.count, 1)
        const sellerList = await request("GET", "/seller/pre-orders", undefined, fixture.sellerToken)
        assert.equal(sellerList.body.total, 1)
        assert.equal(sellerList.body.preOrders[0].buyerName, "preorder-flow")
        assert.equal(JSON.stringify(sellerList.body).includes(buyer), false)
        assert.equal((await request("GET", "/seller/pre-orders?status=NOPE", undefined, fixture.sellerToken)).status, 400)
        assert.equal((await request("GET", "/pre-orders")).body.total, 1)
        assert.equal((await request("GET", `/pre-orders/${preOrder.id}`)).body.preOrder.status, "REQUESTED")
        assert.equal((await request("GET", `/pre-orders/${preOrder.id}`, undefined, empty.token)).status, 404)
        await withStrangerSeller(async (strangerToken) => {
            assert.equal((await request("GET", `/seller/pre-orders/${preOrder.id}`, undefined, strangerToken)).status, 404)
            assert.equal((await request("POST", `/seller/pre-orders/${preOrder.id}/approve`, {}, strangerToken)).status, 404)
        })
        assert.equal((await request("POST", `/seller/pre-orders/${preOrder.id}/approve`, {}, fixture.token)).status, 403)

        // Declining needs a reason, and the buyer can then ask again.
        assert.equal((await request("POST", `/seller/pre-orders/${preOrder.id}/decline`, {}, fixture.sellerToken)).status, 400)
        const declined = await request("POST", `/seller/pre-orders/${preOrder.id}/decline`, { note: "We are closed that day" }, fixture.sellerToken)
        assert.equal(declined.status, 200)
        assert.equal(declined.body.preOrder.status, "DECLINED")
        assert.equal((await request("POST", `/seller/pre-orders/${preOrder.id}/approve`, {}, fixture.sellerToken)).status, 409)
        await waitForNotifications()
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === "preorder-flow Shop could not take your pre-order" && /closed that day/.test(mail.text)))

        const second = (await askForPreOrder(context, { readyAt })).body.preOrder
        const approved = await request("POST", `/seller/pre-orders/${second.id}/approve`, { note: "See you then" }, fixture.sellerToken)
        assert.equal(approved.status, 200)
        assert.equal(approved.body.preOrder.status, "APPROVED")
        const payWithin = (new Date(approved.body.preOrder.payBy).getTime() - Date.now()) / 3_600_000
        assert.ok(payWithin > 23.9 && payWithin <= 24)
        await waitForNotifications()
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === "preorder-flow Shop approved your pre-order" && /See you then/.test(mail.text)))

        // The buyer sees the approval, and checkout now accepts it.
        const reviewed = (await request("GET", "/checkout/preview")).body.sellers[0].preOrder
        assert.equal(reviewed.required, true)
        assert.equal(reviewed.approved.id, second.id)
        assert.equal(new Date(reviewed.approved.readyAt).getTime(), new Date(readyAt).getTime())
        assert.equal((await checkoutFromCart(context)).body.code, "CHECKOUT_PREORDER_REQUIRED")
        assert.equal((await checkoutFromCart(context, [second.id + 999])).body.code, "CHECKOUT_PREORDER_INVALID")
        assert.equal((await context.request("POST", "/checkout", { delivery: fixtureDelivery, preOrderIds: ["x"] })).status, 400)
        const created = await checkoutFromCart(context, [second.id])
        assert.equal(created.status, 201)
        assert.equal(created.body.orders[0].fulfilmentType, "PRE_ORDER")
        assert.equal(new Date(created.body.orders[0].readyAt).getTime(), new Date(readyAt).getTime())
        // Asking again with the same choice reuses the checkout.
        assert.equal((await checkoutFromCart(context, [second.id])).body.code, "CHECKOUT_REUSED")

        // Paying uses the approval up, and the order carries the ready time for both sides.
        const orderId = await payCheckout(context, created.body.checkout.id)
        assert.equal((await prisma.preOrderRequest.findUniqueOrThrow({ where: { id: second.id } })).status, "USED")
        const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        assert.equal(order.fulfilmentType, "PRE_ORDER")
        assert.equal(order.readyAt?.getTime(), new Date(readyAt).getTime())
        assert.equal(order.preOrderRequestId, second.id)
        const buyerOrder = (await request("GET", `/orders/${created.body.checkout.id}`)).body.sellerOrders[0]
        assert.equal(buyerOrder.fulfilmentType, "PRE_ORDER")
        assert.equal(new Date(buyerOrder.readyAt).getTime(), new Date(readyAt).getTime())
        const sellerOrder = (await request("GET", `/seller/orders/${orderId}`, undefined, fixture.sellerToken)).body
        assert.equal(sellerOrder.fulfilmentType, "PRE_ORDER")
        assert.equal((await request("GET", `/admin/orders/${orderId}`, undefined, context.adminToken)).body.order.fulfilmentType, "PRE_ORDER")
        await waitForNotifications()
        assert.ok(emailsTo(buyer).some((mail) => /Pre-order, to be ready/.test(mail.text)))
        assert.ok(emailsTo(seller).some((mail) => /pre-order you approved/.test(mail.text)))
        assert.ok(checkoutId)
    })
})

test("an approval is only good for exactly what was approved, and lapses", async () => {
    await withPaymentCheckout("preorder-changes", async (context) => {
        const { fixture, request } = context
        await makeFoodShop(context, "PRE_ORDER")
        const approvedRequest = async () => {
            const asked = (await askForPreOrder(context)).body.preOrder
            await request("POST", `/seller/pre-orders/${asked.id}/approve`, {}, fixture.sellerToken)
            return asked.id as number
        }

        // A changed cart no longer matches.
        let id = await approvedRequest()
        assert.equal((await request("GET", "/checkout/preview")).body.sellers[0].preOrder.approved.id, id)
        await prisma.cartItem.updateMany({ where: { cart: { userId: fixture.consumerId } }, data: { quantity: 1 } })
        assert.equal((await request("GET", "/checkout/preview")).body.sellers[0].preOrder.approved, null)
        assert.equal((await checkoutFromCart(context, [id])).body.code, "CHECKOUT_PREORDER_INVALID")
        await prisma.cartItem.updateMany({ where: { cart: { userId: fixture.consumerId } }, data: { quantity: 2 } })

        // So does a changed price.
        await prisma.listing.update({ where: { id: fixture.listingId }, data: { price: 1600 } })
        assert.equal((await checkoutFromCart(context, [id])).body.code, "CHECKOUT_PREORDER_INVALID")
        await prisma.listing.update({ where: { id: fixture.listingId }, data: { price: 1500 } })
        assert.equal((await checkoutFromCart(context, [id])).status, 201)

        // A buyer can cancel, and only their own.
        assert.equal((await request("POST", `/pre-orders/${id}/cancel`, {}, (await fixture.addConsumer(1)).token)).status, 404)
        const cancelled = await request("POST", `/pre-orders/${id}/cancel`, {})
        assert.equal(cancelled.status, 200)
        assert.equal(cancelled.body.preOrder.status, "CANCELLED")
        assert.equal((await request("POST", `/pre-orders/${id}/cancel`, {})).status, 409)
        assert.equal((await checkoutFromCart(context, [id])).body.code, "CHECKOUT_PREORDER_INVALID")

        // An approval the buyer never pays for lapses, and so does a request the seller never answers.
        id = await approvedRequest()
        await prisma.preOrderRequest.update({ where: { id }, data: { payBy: new Date(Date.now() - 1000) } })
        assert.equal(await expirePreOrders(), 1)
        const unanswered = (await askForPreOrder(context, { readyAt: inHours(72) }))
        assert.equal(unanswered.status, 201)
        await prisma.preOrderRequest.update({ where: { id: unanswered.body.preOrder.id }, data: { respondBy: new Date(Date.now() - 1000) } })
        assert.equal(await expirePreOrders(), 1)
        assert.equal(await expirePreOrders(), 0)
        await waitForNotifications()
        const buyer = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.consumerId } })).email
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === "Your pre-order approval has lapsed"))
        assert.ok(emailsTo(buyer).some((mail) => mail.subject === "preorder-changes Shop did not answer your pre-order"))
        assert.equal((await request("POST", `/seller/pre-orders/${unanswered.body.preOrder.id}/approve`, {}, fixture.sellerToken)).status, 409)
        assert.equal((await request("GET", "/seller/pre-orders/awaiting-answer", undefined, fixture.sellerToken)).body.count, 0)

        // The seller cannot approve a time that is too close or has passed.
        const soon = (await askForPreOrder(context, { readyAt: inHours(7) })).body.preOrder
        await prisma.preOrderRequest.update({ where: { id: soon.id }, data: { readyAt: new Date(Date.now() + 30 * 60 * 1000) } })
        const tooLate = await request("POST", `/seller/pre-orders/${soon.id}/approve`, {}, fixture.sellerToken)
        assert.equal(tooLate.status, 409)
        assert.equal(tooLate.body.code, "PREORDER_TIME_INVALID")
    })
})

test("a shop that takes both lets the buyer choose, and a shop that stops taking pre-orders cannot be paid as one", async () => {
    await withPaymentCheckout("preorder-both", async (context) => {
        const { fixture, request } = context
        await makeFoodShop(context, "BOTH")

        // Without a request it is an ordinary order, ready now.
        const preview = (await request("GET", "/checkout/preview")).body.sellers[0]
        assert.equal(preview.orderType, "BOTH")
        assert.deepEqual(preview.preOrder, { required: false, approved: null })
        const now = await checkoutFromCart(context)
        assert.ok([200, 201].includes(now.status))
        assert.equal(now.body.orders[0].fulfilmentType, "NOW")
        assert.equal(now.body.orders[0].readyAt, null)

        // With an approved request and its id, it is a pre-order, and the earlier checkout is replaced.
        const asked = (await askForPreOrder(context)).body.preOrder
        await request("POST", `/seller/pre-orders/${asked.id}/approve`, {}, fixture.sellerToken)
        const planned = await checkoutFromCart(context, [asked.id])
        assert.equal(planned.status, 201)
        assert.equal(planned.body.orders[0].fulfilmentType, "PRE_ORDER")
        // ...and leaving the id out brings back the ordinary one.
        const plain = await checkoutFromCart(context)
        assert.equal(plain.body.orders[0].fulfilmentType, "NOW")

        // A shop that stops taking pre-orders cannot be paid for as one.
        await request("PATCH" as "GET", "/seller/profile", { foodOrderType: "NOW" }, fixture.sellerToken)
        const refused = await checkoutFromCart(context, [asked.id])
        assert.equal(refused.status, 409)
        assert.equal(refused.body.code, "CHECKOUT_PREORDER_NOT_AVAILABLE")
        assert.equal((await askForPreOrder(context)).body.code, "PREORDER_NOT_AVAILABLE")
    })
})

test("a pre-order's complaint periods count from the ready time, not from payment", async () => {
    await withPaymentCheckout("preorder-clocks", async (context) => {
        const { fixture, request } = context
        await makeFoodShop(context, "PRE_ORDER")
        const asked = (await askForPreOrder(context, { readyAt: inHours(24 * 10) })).body.preOrder
        await request("POST", `/seller/pre-orders/${asked.id}/approve`, {}, fixture.sellerToken)
        const created = await checkoutFromCart(context, [asked.id])
        const orderId = await payCheckout(context, created.body.checkout.id)
        const checkoutId = created.body.checkout.id as number
        const day = 24 * 60 * 60 * 1000
        const complain = (body: Record<string, unknown>) => request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/disputes`, {
            reason: "NOT_RECEIVED", message: "Nothing has arrived at my address yet.", ...body
        })

        // Paid 20 days ago and still not shipped: an ordinary order could be reported by now, but this one is not due for 10 more days.
        await backdatePayment(checkoutId, 20)
        const early = await complain({})
        assert.equal(early.status, 409)
        assert.equal(early.body.code, "DISPUTE_NOT_ALLOWED")
        assert.match(early.body.message, /agreed ready time/)

        // The ready time has passed by 3 days: still not 7 days late.
        await prisma.order.update({ where: { id: orderId }, data: { readyAt: new Date(Date.now() - 3 * day) } })
        assert.equal((await complain({})).status, 409)

        // 8 days after the ready time and still not shipped: it can be reported.
        await prisma.order.update({ where: { id: orderId }, data: { readyAt: new Date(Date.now() - 8 * day) } })
        const late = await complain({})
        assert.equal(late.status, 201)
        await request("POST", `/disputes/${late.body.dispute.id}/withdraw`, {})

        // The 30-day window counts from the ready time too: paid 40 days ago, due 5 days ago, so there is time left.
        await shipPaidOrder(context, orderId)
        await backdatePayment(checkoutId, 40)
        await prisma.order.update({ where: { id: orderId }, data: { readyAt: new Date(Date.now() - 5 * day) } })
        assert.equal((await complain({ reason: "DAMAGED", message: "The food arrived spoiled and cold." })).status, 201)
    })
    await withPaymentCheckout("preorder-clocks-late", async (context) => {
        const { fixture, request } = context
        await makeFoodShop(context, "PRE_ORDER")
        const asked = (await askForPreOrder(context)).body.preOrder
        await request("POST", `/seller/pre-orders/${asked.id}/approve`, {}, fixture.sellerToken)
        const created = await checkoutFromCart(context, [asked.id])
        const orderId = await payCheckout(context, created.body.checkout.id)
        await shipPaidOrder(context, orderId)
        const day = 24 * 60 * 60 * 1000

        // Due 40 days ago: the window has closed.
        await backdatePayment(created.body.checkout.id, 45)
        await prisma.order.update({ where: { id: orderId }, data: { readyAt: new Date(Date.now() - 40 * day) } })
        const closed = await request("POST", `/orders/${created.body.checkout.id}/seller-orders/${orderId}/disputes`, {
            reason: "DAMAGED", message: "The food arrived spoiled and cold."
        })
        assert.equal(closed.status, 409)
        assert.match(closed.body.message, /30-day period/)
    })
})

// ---- Listing pages ----

test("the public listings come a page at a time, newest first", async () => {
    const fixture = await createCheckoutLifecycleFixture("listing-pages", 5, 1)
    const marker = `pagetest-${randomUUID()}`

    try {
        // 26 listings with distinct creation times, oldest first in the loop.
        const start = Date.now() - 60_000
        await prisma.listing.createMany({
            data: Array.from({ length: 26 }, (_, index) => ({
                title: `${marker} item ${String(index).padStart(2, "0")}`,
                description: "A listing for the page test",
                price: 1000,
                stockQuantity: 1,
                category: "Electronics",
                imageUrl: "https://example.test/page.png",
                userId: fixture.sellerId,
                createdAt: new Date(start + index * 1000)
            }))
        })
        const get = async (query: string) => {
            const response = await fetch(`${fixture.baseUrl}/listings?${query}`)
            return { status: response.status, body: await response.json() as { page: number; pageSize: number; total: number; listings: Array<{ title: string }> } }
        }

        const first = await get(`search=${marker}`)
        assert.equal(first.status, 200)
        assert.deepEqual([first.body.page, first.body.pageSize, first.body.total, first.body.listings.length], [1, 24, 26, 24])
        // Newest first: item 25 leads, and the page ends at item 02.
        assert.match(first.body.listings[0]!.title, /item 25$/)
        assert.match(first.body.listings[23]!.title, /item 02$/)

        const second = await get(`search=${marker}&page=2`)
        assert.deepEqual(second.body.listings.map((listing) => listing.title.slice(-7)), ["item 01", "item 00"])
        assert.equal((await get(`search=${marker}&page=3`)).body.listings.length, 0)

        // The same order every time, and filters still apply.
        assert.deepEqual((await get(`search=${marker}`)).body.listings.map((listing) => listing.title), first.body.listings.map((listing) => listing.title))
        assert.equal((await get(`search=${marker}&category=Pet%20Supplies`)).body.total, 0)
        assert.equal((await get(`search=${marker}&category=electronics`)).body.total, 26)

        for (const query of ["page=0", "page=-1", "page=1.5", "page=abc", "page=1&page=2"]) {
            assert.equal((await get(query)).status, 400, query)
        }
    } finally {
        await prisma.listing.deleteMany({ where: { userId: fixture.sellerId, id: { not: fixture.listingId } } })
        await fixture.cleanup()
    }
})

// ---- Appeals and reopening ----

test("a buyer can appeal StoreHatch's rejection once, within a week, and the second decision is final", async () => {
    await withPaymentCheckout("dispute-appeal", async (context) => {
        const { fixture, request, adminToken } = context
        const seller = (await prisma.user.findUniqueOrThrow({ where: { id: fixture.sellerId } })).email
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        const appeal = (body: unknown, token = fixture.token) => request("POST", `/disputes/${id}/appeal`, body, token)
        const appealText = { message: "I have a new photo that clearly shows the crack.", evidenceUrls: ["https://images.example.test/crack-2.jpg"] }

        // Nothing to appeal while it is still open.
        assert.equal((await request("GET", `/disputes/${id}`)).body.dispute.appeal.canAppeal, false)
        const early = await appeal(appealText)
        assert.equal(early.status, 409)
        assert.equal(early.body.code, "DISPUTE_NOT_APPEALABLE")

        await request("POST", `/admin/disputes/${id}/reject`, { note: "The first photos do not show any damage." }, adminToken)
        const rejected = (await request("GET", `/disputes/${id}`)).body.dispute
        assert.equal(rejected.status, "RESOLVED")
        assert.equal(rejected.appeal.canAppeal, true)
        assert.equal(rejected.appeal.appealed, false)
        const daysLeft = (new Date(rejected.appeal.deadline).getTime() - Date.now()) / 86_400_000
        assert.ok(daysLeft > 6.9 && daysLeft <= 7)

        // Who can appeal, and what is checked.
        assert.equal((await appeal({ message: "short" })).status, 400)
        assert.equal((await appeal({ message: "A long enough message.", evidenceUrls: ["http://not-https.example.test/a.jpg"] })).status, 400)
        assert.equal((await appeal(appealText, (await fixture.addConsumer(1)).token)).status, 404)
        assert.equal((await appeal(appealText, fixture.sellerToken)).status, 404)
        assert.equal((await request("POST", "/disputes/999999/appeal", appealText)).status, 404)

        const appealed = await appeal(appealText)
        assert.equal(appealed.status, 201)
        const dispute = appealed.body.dispute
        assert.equal(dispute.status, "UNDER_REVIEW")
        assert.equal(dispute.outcome, null)
        assert.equal(dispute.decisionNote, null)
        assert.equal(dispute.appeal.appealed, true)
        assert.equal(dispute.appeal.canAppeal, false)
        const last = dispute.messages.at(-1)
        assert.equal(last.author, "BUYER")
        assert.match(last.body, /^Appeal: I have a new photo/)
        assert.deepEqual(last.evidenceUrls, ["https://images.example.test/crack-2.jpg"])
        await waitForNotifications()
        assert.ok(emailsTo(seller).some((mail) => /New message about the complaint/.test(mail.subject) && /Appeal: I have a new photo/.test(mail.text)))

        // It is back in the administrators' queue, and appealing again is refused.
        assert.equal((await request("GET", "/admin/disputes", undefined, adminToken)).body.disputes.some((item: { id: number }) => item.id === id), true)
        const twice = await appeal(appealText)
        assert.equal(twice.status, 409)
        assert.match(twice.body.message, /Only a complaint that StoreHatch rejected/)

        // The second rejection is final for the buyer.
        await request("POST", `/admin/disputes/${id}/reject`, { note: "We looked again and the decision stands." }, adminToken)
        const final = (await request("GET", `/disputes/${id}`)).body.dispute
        assert.equal(final.status, "RESOLVED")
        assert.equal(final.outcome, "REJECTED")
        assert.equal(final.appeal.canAppeal, false)
        assert.equal(final.appeal.appealed, true)
        const afterFinal = await appeal(appealText)
        assert.equal(afterFinal.status, 409)
        assert.match(afterFinal.body.message, /already appealed/)
        assert.equal((await complain(context, orderId)).body.code, "DISPUTE_ALREADY_DECIDED")
    })

    // An appeal that succeeds ends in a refund like any complaint.
    await withPaymentCheckout("dispute-appeal-approved", async (context) => {
        const { request, adminToken } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        await request("POST", `/admin/disputes/${id}/reject`, { note: "Not enough evidence to approve this." }, adminToken)
        await request("POST", `/disputes/${id}/appeal`, { message: "Here is a video of the problem, please look." })
        const approved = await request("POST", `/admin/disputes/${id}/approve`, { note: "The video settles it, so we refund." }, adminToken)
        assert.equal(approved.status, 201)
        assert.equal(approved.body.dispute.outcome, "REFUNDED")
        assert.equal(approved.body.dispute.appeal.appealed, true)
    })

    // The week is up.
    await withPaymentCheckout("dispute-appeal-late", async (context) => {
        const { request, adminToken } = context
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        await request("POST", `/admin/disputes/${id}/reject`, { note: "Not enough evidence to approve this." }, adminToken)
        await prisma.dispute.update({ where: { id }, data: { resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } })
        const late = await request("POST", `/disputes/${id}/appeal`, { message: "I only just found the photo again." })
        assert.equal(late.status, 409)
        assert.match(late.body.message, /7-day period to appeal/)
        assert.equal((await request("GET", `/disputes/${id}`)).body.dispute.appeal.canAppeal, false)
    })
})

test("an administrator can reopen a rejected complaint, but not one that ended in a refund", async () => {
    await withPaymentCheckout("dispute-reopen", async (context) => {
        const { fixture, request, adminToken } = context
        const { buyer, seller } = await addressesOf(fixture)
        const orderId = await payAndShip(context)
        const id = (await complain(context, orderId)).body.dispute.id as number
        const reopen = (body: unknown, token = adminToken) => request("POST", `/admin/disputes/${id}/reopen`, body, token)

        // Only a rejected complaint can be reopened, and only by an administrator, with a note.
        assert.equal((await reopen({ note: "Reopening this one for another look." })).status, 409)
        await request("POST", `/admin/disputes/${id}/reject`, { note: "The photos do not show any damage." }, adminToken)
        assert.equal((await reopen({ note: "Reopening this one for another look." }, fixture.token)).status, 403)
        assert.equal((await reopen({})).status, 400)
        assert.equal((await reopen({ note: "short" })).status, 400)
        assert.equal((await request("POST", "/admin/disputes/999999/reopen", { note: "Reopening this one for another look." }, adminToken)).status, 404)

        const reopened = await reopen({ note: "The courier has sent us a damage report." })
        assert.equal(reopened.status, 200)
        const dispute = reopened.body.dispute
        assert.equal(dispute.status, "UNDER_REVIEW")
        assert.equal(dispute.outcome, null)
        assert.equal(dispute.decisionNote, null)
        const last = dispute.messages.at(-1)
        assert.equal(last.author, "ADMIN")
        assert.match(last.body, /^StoreHatch reopened this complaint: The courier has sent us a damage report\./)
        // Reopening is not the buyer's appeal, so the buyer's one appeal is still there for later.
        assert.equal(dispute.appeal.appealed, false)
        await waitForNotifications()
        for (const address of [buyer, seller]) {
            assert.ok(emailsTo(address).some((mail) => /StoreHatch wrote in the complaint/.test(mail.subject) && /reopened this complaint/.test(mail.text)), address)
        }
        assert.equal((await reopen({ note: "Reopening an open one again." })).status, 409)

        // It can be decided again, and a refund cannot be reopened.
        const approved = await request("POST", `/admin/disputes/${id}/approve`, { note: "The damage report settles it." }, adminToken)
        assert.equal(approved.status, 201)
        const refunded = await reopen({ note: "Trying to reopen a refunded one." })
        assert.equal(refunded.status, 409)
        assert.equal(refunded.body.code, "DISPUTE_NOT_REOPENABLE")
    })
})

// ---- Seller standing ----

test("lost complaints are strikes: a warning at 2, a block at 4, and an administrator can lift it", async () => {
    await withPaymentCheckout("seller-standing", async (context) => {
        const { fixture, request, adminToken, baseUrl } = context
        const { seller } = await addressesOf(fixture)
        const orderId = await payAndShip(context)
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId }, select: { slug: true } })
        const standing = async () => (await request("GET", "/seller/standing", undefined, fixture.sellerToken)).body.standing
        const strike = (data: Record<string, unknown> = {}) => prisma.dispute.create({
            data: {
                orderId,
                openedBy: "BUYER",
                reason: "OTHER",
                requestedAmount: 1000,
                status: "RESOLVED",
                outcome: "REFUNDED",
                responseDueAt: new Date(),
                resolvedAt: new Date(),
                ...data
            }
        })

        // A real complaint that StoreHatch approves is the first strike. One strike is not a warning.
        const id = (await complain(context, orderId)).body.dispute.id as number
        assert.equal((await request("POST", `/admin/disputes/${id}/approve`, { note: "Approved after review of the photos." }, adminToken)).status, 201)
        await waitForNotifications()
        let now = await standing()
        assert.deepEqual([now.strikes, now.warnAt, now.blockAt, now.windowDays, now.warned, now.blocked], [1, 2, 4, 90, false, false])
        assert.equal(now.recent[0].disputeId, id)
        assert.equal(emailsTo(seller).some((mail) => /warning about complaints/.test(mail.subject)), false)

        // A refund the seller agreed to, and one older than 90 days, are not strikes.
        await strike({ sellerAgreedAt: new Date() })
        await strike({ resolvedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) })
        await strike({ outcome: "REJECTED" })
        await strike({ openedBy: "SELLER", reason: "SELLER_REFUND_OFFER" })
        assert.equal((await standing()).strikes, 1)

        // The second strike warns the seller, once.
        await strike()
        await reviewSellerStanding(fixture.sellerId)
        await reviewSellerStanding(fixture.sellerId)
        await waitForNotifications()
        now = await standing()
        assert.deepEqual([now.strikes, now.warned, now.blocked], [2, true, false])
        assert.equal(emailsTo(seller).filter((mail) => /warning about complaints/.test(mail.subject)).length, 1)
        assert.equal((await fetch(`${baseUrl}/listings/${fixture.listingId}`)).status, 200)

        // The fourth strike blocks the shop. The shop is hidden and cannot be bought from.
        await strike()
        await reviewSellerStanding(fixture.sellerId)
        assert.equal((await standing()).blocked, false)
        await strike()
        await reviewSellerStanding(fixture.sellerId)
        await waitForNotifications()
        now = await standing()
        assert.deepEqual([now.strikes, now.blocked], [4, true])
        assert.match(now.blockReason, /^Automatic: 4 lost complaints in 90 days$/)
        assert.equal(emailsTo(seller).some((mail) => /blocked from new orders/.test(mail.subject)), true)

        const shopper = await fixture.addConsumer(1)
        assert.equal((await fetch(`${baseUrl}/listings/${fixture.listingId}`)).status, 404)
        const title = (await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId }, select: { title: true } })).title
        const listed = await (await fetch(`${baseUrl}/listings?search=${encodeURIComponent(title)}`)).json() as { listings: Array<{ id: number }> }
        assert.equal(listed.listings.some((listing) => listing.id === fixture.listingId), false)
        assert.equal((await fetch(`${baseUrl}/seller/shop/${profile.slug}`)).status, 404)
        assert.equal((await request("POST", "/cart/items", { listingId: fixture.listingId, quantity: 1 }, shopper.token)).status, 404)

        // Orders already placed carry on: the seller can still see their orders and complaints.
        assert.equal((await request("GET", "/seller/orders", undefined, fixture.sellerToken)).status, 200)
        assert.equal((await request("GET", "/seller/disputes", undefined, fixture.sellerToken)).status, 200)

        // Only administrators see or change a standing, and a block by hand needs a note.
        const adminView = await request("GET", `/admin/sellers/${fixture.sellerId}/standing`, undefined, adminToken)
        assert.equal(adminView.body.standing.blocked, true)
        assert.equal((await request("GET", `/admin/sellers/${fixture.sellerId}/standing`, undefined, fixture.token)).status, 403)
        assert.equal((await request("GET", "/seller/standing", undefined, fixture.token)).status, 403)
        assert.equal((await request("GET", "/admin/sellers/999999/standing", undefined, adminToken)).status, 404)
        assert.equal((await request("POST", `/admin/sellers/${fixture.sellerId}/block`, { note: "short" }, adminToken)).status, 400)
        const twice = await request("POST", `/admin/sellers/${fixture.sellerId}/block`, { note: "Blocking this one again." }, adminToken)
        assert.equal(twice.status, 409)

        // Lifting the block makes the shop visible again and starts the count from zero.
        const lifted = await request("POST", `/admin/sellers/${fixture.sellerId}/unblock`, {}, adminToken)
        assert.equal(lifted.status, 200)
        assert.deepEqual([lifted.body.standing.strikes, lifted.body.standing.warned, lifted.body.standing.blocked], [0, false, false])
        await waitForNotifications()
        assert.equal(emailsTo(seller).some((mail) => /can take orders again/.test(mail.subject)), true)
        assert.equal((await fetch(`${baseUrl}/listings/${fixture.listingId}`)).status, 200)
        assert.equal((await request("POST", "/cart/items", { listingId: fixture.listingId, quantity: 1 }, shopper.token)).status, 200)
        assert.equal((await request("POST", `/admin/sellers/${fixture.sellerId}/unblock`, {}, adminToken)).status, 409)

        // An administrator can also block a shop by hand, with a reason the seller can read.
        const manual = await request("POST", `/admin/sellers/${fixture.sellerId}/block`, { note: "Selling items that are not allowed." }, adminToken)
        assert.equal(manual.status, 200)
        assert.equal(manual.body.standing.blockReason, "Selling items that are not allowed.")
        assert.equal((await fetch(`${baseUrl}/listings/${fixture.listingId}`)).status, 404)
    })
})

// ---- Product options (colour, size) ----

// A title no other run has used, so searches find only this run's products.
const hoodieTitle = `Oversized Hoodie ${randomUUID().slice(0, 8)}`
const hoodie = {
    title: hoodieTitle,
    description: "A soft cotton hoodie for every day",
    price: 20000,
    category: "Electronics",
    imageUrls: ["https://img.example.test/hoodie.jpg"]
}

test("a product can have options with their own price and stock, and shoppers buy them through the cart", async () => {
    await withPaymentCheckout("listing-options", async (context) => {
        const { fixture, request } = context
        const seller = fixture.sellerToken
        const slug = (await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })).slug
        const create = (options: unknown, extra: Record<string, unknown> = {}) => request("POST", "/listings", { ...hoodie, options, ...extra }, seller)

        // Bad options are refused with a reason.
        const blue = { label: "Blue", price: 22000, imageUrl: "https://img.example.test/blue.jpg", sizes: [{ label: "M", stockQuantity: 3 }, { label: "L", stockQuantity: 2 }] }
        const red = { label: "Red", stockQuantity: 4 }
        for (const [options, message] of [
            [[blue, { ...red, label: "blue" }], /listed twice/],
            [[{ ...blue, stockQuantity: 1 }], /has sizes/],
            [[{ label: "Green" }], /Stock quantity/],
            [[{ label: "Green", stockQuantity: -1 }], /Stock quantity/],
            [[{ label: "Green", stockQuantity: 1, price: 0 }], /Option "Green"/],
            [[{ label: "Green", stockQuantity: 1, imageUrl: "http://not-https.example.test/a.jpg" }], /https/],
            [[{ label: "Blue", sizes: [{ label: "M" }] }], /Option "Blue", size "M"/],
            [[{ label: "Blue", sizes: [{ label: "M", stockQuantity: 1 }, { label: "m", stockQuantity: 1 }] }], /listed twice/],
            [[{ label: " ", stockQuantity: 1 }], /needs a name/],
            [Array.from({ length: 21 }, (_, index) => ({ label: `Colour ${index}`, stockQuantity: 1 })), /at most 20/],
            ["Blue", /must be a list/]
        ] as const) {
            const refused = await create(options)
            assert.equal(refused.status, 400, JSON.stringify(options).slice(0, 80))
            assert.match(refused.body.message, message)
        }
        assert.equal((await request("POST", "/listings", { ...hoodie, options: [red] }, fixture.token)).status, 403)

        // A product with options needs no stock of its own. It shows its lowest price and its total stock.
        const created = await create([blue, red])
        assert.equal(created.status, 201)
        const product = created.body
        assert.equal(product.hasOptions, true)
        assert.equal(product.hasPriceRange, true)
        assert.equal(product.price, 20000)
        assert.equal(product.stockQuantity, 9)
        assert.equal(product.options.length, 2)
        assert.deepEqual(product.options[0].sizes.map((size: { label: string; stockQuantity: number }) => [size.label, size.stockQuantity]), [["M", 3], ["L", 2]])
        assert.deepEqual([product.options[0].label, product.options[0].price, product.options[0].listingId, product.options[0].stockQuantity], ["Blue", 22000, null, null])
        assert.deepEqual([product.options[1].label, product.options[1].price, product.options[1].stockQuantity, product.options[1].sizes.length], ["Red", 20000, 4, 0])
        assert.equal(product.options[1].imageUrl, "https://img.example.test/hoodie.jpg")
        const productId = product.id as number
        const blueM = product.options[0].sizes[0].listingId as number
        const redId = product.options[1].listingId as number

        // The choices are listings of their own underneath, titled after the product.
        const choices = await prisma.listing.findMany({ where: { parentId: productId }, orderBy: { position: "asc" } })
        assert.deepEqual(choices.map((choice) => choice.title), [`${hoodieTitle} — Blue / M`, `${hoodieTitle} — Blue / L`, `${hoodieTitle} — Red`])
        assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: productId } })).stockQuantity, 0)

        // Shoppers only see the product: in the list, the shop and the seller's own list.
        const found = (await request("GET", `/listings?search=${encodeURIComponent(hoodieTitle)}`)).body.listings as Array<{ id: number; hasOptions: boolean; price: number }>
        assert.deepEqual(found.map((listing) => [listing.id, listing.hasOptions, listing.price]), [[productId, true, 20000]])
        const shop = (await request("GET", `/seller/shop/${slug}`)).body.listings as Array<{ id: number; title: string }>
        assert.deepEqual(shop.filter((listing) => listing.title === hoodieTitle).map((listing) => listing.id), [productId])
        const mine = (await request("GET", "/listings/Mylisting", undefined, seller)).body as Array<{ id: number; title: string; options: unknown[] }>
        assert.deepEqual(mine.filter((listing) => listing.title === hoodieTitle).map((listing) => [listing.id, listing.options.length]), [[productId, 2]])
        assert.equal((await request("GET", `/listings/${productId}`)).body.selectedListingId, null)
        const viaChoice = (await request("GET", `/listings/${blueM}`)).body
        assert.deepEqual([viaChoice.id, viaChoice.selectedListingId, viaChoice.hasOptions], [productId, blueM, true])
        // An ordinary listing is unchanged.
        const plain = (await request("GET", `/listings/${fixture.listingId}`)).body
        assert.deepEqual([plain.hasOptions, plain.hasPriceRange, plain.options], [false, false, []])

        // The product itself cannot be bought; one of its choices can, like any listing.
        const shopper = (await fixture.addConsumer(1)).token
        const refusedProduct = await request("POST", "/cart/items", { listingId: productId, quantity: 1 }, shopper)
        assert.equal(refusedProduct.status, 409)
        assert.match(refusedProduct.body.message, /Choose an option/)
        assert.equal((await request("POST", "/cart/items", { listingId: blueM, quantity: 1 }, shopper)).status, 201)
        assert.equal((await request("POST", "/cart/items", { listingId: blueM, quantity: 3 }, shopper)).status, 409)
        const cart = await request("GET", "/cart", undefined, shopper)
        assert.ok(JSON.stringify(cart.body).includes(`${hoodieTitle} — Blue / M`))
        assert.match(JSON.stringify(cart.body), /22000/)
        // The cart says which option was picked, gives the plain product name, and tells the shop's card what it needs.
        const cartListing = cart.body.cart.cartItems.find((item: { listingId: number }) => item.listingId === blueM).listing
        assert.deepEqual(
            [cartListing.parentId, cartListing.optionLabel, cartListing.sizeLabel, cartListing.productTitle, cartListing.imageUrl],
            [productId, "Blue", "M", hoodieTitle, "https://img.example.test/blue.jpg"]
        )
        assert.equal("parent" in cartListing, false)
        const cartShop = cartListing.user.sellerProfile
        assert.deepEqual(Object.keys(cartShop).sort(), ["brandColor", "businessName", "location", "logoUrl", "slug"])
        assert.equal(cartShop.brandColor.key, "forest")
        assert.equal(typeof cartShop.brandColor.background, "string")
        const patchedItem = await request("PATCH" as "GET", `/cart/items/${blueM}`, { quantity: 2 }, shopper)
        assert.equal(patchedItem.status, 200)
        assert.equal(patchedItem.body.listing.productTitle, hoodieTitle)
        assert.equal(patchedItem.body.listing.user.sellerProfile.brandColor.key, "forest")
        await request("PATCH" as "GET", `/cart/items/${blueM}`, { quantity: 1 }, shopper)

        // What can be changed where.
        const patch = (id: number, body: unknown) => request("PATCH" as "GET", `/listings/${id}`, body, seller)
        for (const body of [{ price: 1000 }, { stockQuantity: 5 }]) {
            const refused = await patch(productId, body)
            assert.equal(refused.status, 400)
            assert.equal(refused.body.code, "LISTING_HAS_OPTIONS")
        }
        for (const body of [{ title: "Other" }, { description: "Other text here" }, { category: "Electronics" }, { imageUrls: ["https://img.example.test/x.jpg"] }]) {
            const refused = await patch(blueM, body)
            assert.equal(refused.status, 400)
            assert.equal(refused.body.code, "LISTING_IS_OPTION")
        }
        assert.equal((await patch(blueM, { stockQuantity: 10, price: 23000 })).status, 200)
        assert.deepEqual((await request("GET", `/listings/${productId}`)).body.options[0].sizes.map((size: { stockQuantity: number }) => size.stockQuantity), [10, 2])
        assert.equal((await request("DELETE" as "GET", `/listings/${blueM}`, undefined, seller)).body.code, "LISTING_IS_OPTION")
        assert.equal((await request("POST", `/listings/${blueM}/archive`, {}, seller)).body.code, "LISTING_IS_OPTION")
        assert.equal((await request("POST", `/listings/${blueM}/unarchive`, {}, seller)).body.code, "LISTING_IS_OPTION")

        // Renaming the product renames its choices, and its photo follows the choices that have none of their own.
        const renamedTitle = `Cotton ${hoodieTitle.slice(-8)}`
        const renamed = await patch(productId, { title: renamedTitle, imageUrls: ["https://img.example.test/new.jpg"] })
        assert.equal(renamed.status, 200)
        assert.deepEqual((await prisma.listing.findMany({ where: { parentId: productId }, orderBy: { position: "asc" } })).map((choice) => [choice.title, choice.imageUrl]), [
            [`${renamedTitle} — Blue / M`, "https://img.example.test/blue.jpg"],
            [`${renamedTitle} — Blue / L`, "https://img.example.test/blue.jpg"],
            [`${renamedTitle} — Red`, "https://img.example.test/new.jpg"]
        ])

        // Replacing the options: same names are updated in place, new ones added, missing ones removed.
        const put = (body: unknown, token = seller) => request("PUT" as "GET", `/listings/${productId}/options`, body, token)
        const replaced = await put({ options: [{ ...blue, sizes: [{ label: "M", stockQuantity: 7 }, { label: "L", stockQuantity: 2 }] }, { label: "Green", stockQuantity: 6 }] })
        assert.equal(replaced.status, 200)
        assert.deepEqual(replaced.body.options.map((option: { label: string }) => option.label), ["Blue", "Green"])
        assert.equal(replaced.body.options[0].sizes[0].listingId, blueM)
        assert.equal(replaced.body.options[0].sizes[0].stockQuantity, 7)
        assert.equal(await prisma.listing.count({ where: { id: redId } }), 0)
        assert.equal(replaced.body.stockQuantity, 15)
        // The shopper's cart still holds Blue / M, which was kept.
        assert.match(JSON.stringify((await request("GET", "/cart", undefined, shopper)).body), /Blue \/ M/)
        assert.equal((await put({ options: [] })).status, 400)
        assert.equal((await put({ options: [blue] }, fixture.token)).status, 403)
        await withStrangerSeller(async (stranger) => {
            assert.equal((await put({ options: [blue] }, stranger)).status, 403)
        })
        assert.equal((await request("PUT" as "GET", `/listings/${blueM}/options`, { options: [blue] }, seller)).body.code, "LISTING_IS_OPTION")
        assert.equal((await request("PUT" as "GET", "/listings/999999/options", { options: [blue] }, seller)).status, 404)

        // A choice that an order or checkout has used is hidden, not deleted, when it is removed. (The fixture's own
        // listing stands in for a choice that has history.)
        await prisma.listing.update({ where: { id: fixture.listingId }, data: { parentId: productId, optionLabel: "Fixture", sizeLabel: null } })
        const withoutFixture = await put({ options: [{ ...blue, sizes: [{ label: "M", stockQuantity: 7 }, { label: "L", stockQuantity: 2 }] }, { label: "Green", stockQuantity: 6 }] })
        assert.equal(withoutFixture.status, 200)
        const hidden = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
        assert.notEqual(hidden.archivedAt, null)

        // Taking the product off sale takes its choices with it, and putting it back restores only those.
        assert.equal((await request("POST", `/listings/${productId}/archive`, {}, seller)).status, 200)
        assert.equal((await request("GET", `/listings/${productId}`)).status, 404)
        assert.equal((await request("GET", `/listings/${blueM}`)).status, 404)
        assert.equal((await request("POST", "/cart/items", { listingId: blueM, quantity: 1 }, shopper)).status, 404)
        assert.equal(await prisma.cartItem.count({ where: { listingId: blueM } }), 0)
        assert.equal((await request("POST", `/listings/${productId}/unarchive`, {}, seller)).status, 200)
        assert.equal((await request("GET", `/listings/${blueM}`)).status, 200)
        assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })).archivedAt !== null, true)
        assert.equal((await request("GET", `/listings/${productId}`)).body.options.length, 2)

        // A product whose choices have history cannot be deleted; one without history can, with its choices.
        const stuck = await request("DELETE" as "GET", `/listings/${productId}`, undefined, seller)
        assert.equal(stuck.status, 409)
        assert.equal(stuck.body.code, "LISTING_HAS_HISTORY")
        assert.equal(await prisma.listing.count({ where: { parentId: productId } }) > 0, true)
        const spare = (await create([red])).body
        assert.equal((await request("DELETE" as "GET", `/listings/${spare.id}`, undefined, seller)).status, 200)
        assert.equal(await prisma.listing.count({ where: { OR: [{ id: spare.id }, { parentId: spare.id }] } }), 0)

        // Taking every option away turns it back into an ordinary listing, which then needs its own stock.
        const flat = (await create([red])).body
        const flatPut = (body: unknown) => request("PUT" as "GET", `/listings/${flat.id}/options`, body, seller)
        assert.equal((await flatPut({ options: [] })).status, 400)
        const back = await flatPut({ options: [], stockQuantity: 12, price: 18000 })
        assert.equal(back.status, 200)
        assert.deepEqual([back.body.hasOptions, back.body.price, back.body.stockQuantity, back.body.options], [false, 18000, 12, []])
        assert.equal((await request("POST", "/cart/items", { listingId: flat.id, quantity: 2 }, shopper)).status, 201)
    })
})

test("an option is paid, shipped, reviewed and refunded like any listing, and its reviews belong to the product", async () => {
    await withPaymentCheckout("listing-options-order", async (context) => {
        const { fixture, request, checkoutId, adminToken } = context
        const product = (await request("POST", "/listings", { ...hoodie, options: [{ label: "Blue", stockQuantity: 5 }] }, fixture.sellerToken)).body
        // The fixture's listing, which the checkout already holds, is made a choice of the product.
        await prisma.listing.update({ where: { id: fixture.listingId }, data: { parentId: product.id, optionLabel: "Fixture", sizeLabel: null } })
        const before = (await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })).stockQuantity
        const orderId = await payShipDeliverConfirm(context)

        // Stock came off the choice, not the product.
        assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })).stockQuantity, before - 2)
        assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: product.id } })).stockQuantity, 0)

        // Reviews are asked for per product, even though an option was bought, and either id is accepted.
        const state = (await request("GET", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`)).body
        assert.deepEqual(state.products.map((item: { listingId: number; title: string }) => [item.listingId, item.title]), [[product.id, hoodieTitle]])
        const created = await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`, { products: [{ listingId: fixture.listingId, rating: 4, comment: "Fits well" }] })
        assert.equal(created.status, 201)
        assert.equal(created.body.products[0].listingId, product.id)
        const again = await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`, { products: [{ listingId: product.id, rating: 5 }] })
        assert.equal(again.status, 409)
        const page = (await request("GET", `/listings/${product.id}`)).body
        assert.deepEqual([page.ratingCount, page.ratingAverage], [1, 4])
        assert.equal((await request("GET", `/listings/${fixture.listingId}/reviews`)).body.reviews.length, 1)
        const viaOrder = (await request("GET", `/orders/${checkoutId}/seller-orders/${orderId}/reviews`)).body
        assert.equal(viaOrder.products[0].review.rating, 4)

        // A refund puts the stock back on the choice.
        const issued = await refundOrder(context, orderId, { restock: true })
        assert.equal(issued.status, 201)
        providerReports(context, issued.body.refund, 300000, "succeeded", "processed")
        await request("POST", `/admin/refunds/${issued.body.refund.id}/sync`, undefined, adminToken)
        assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })).stockQuantity, before)
        assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: product.id } })).stockQuantity, 0)
    })
})

// ---- Administrator team and platform figures ----

test("super administrators manage the administrator team with their password, and everything is in the audit log", async () => {
    await withPaymentCheckout("admin-team", async (context) => {
        const { fixture, request, adminToken } = context
        const superId = (jwt.decode(adminToken) as { id: number }).id
        await prisma.user.update({ where: { id: superId }, data: { passwordHash: await bcrypt.hash(goodPassword, 4), isSuperAdmin: true, emailVerifiedAt: new Date() } })
        const { buyer: targetEmail } = await addressesOf(fixture)
        await prisma.user.update({ where: { id: fixture.consumerId }, data: { emailVerifiedAt: new Date() } })
        const targetToken = fixture.token
        const team = () => request("GET", "/admin/team", undefined, adminToken)

        // Only super administrators reach the team, the audit log and the platform figures.
        for (const path of ["/admin/team", "/admin/audit-log", "/admin/platform"]) {
            assert.equal((await request("GET", path, undefined, targetToken)).status, 403, path)
            assert.equal((await request("GET", path, undefined, fixture.sellerToken)).status, 403, path)
            assert.equal((await request("GET", path, undefined, adminToken)).status, 200, path)
        }
        assert.equal((await request("GET", "/users/check", undefined, adminToken)).body.isSuperAdmin, true)
        assert.equal((await request("GET", "/users/check", undefined, targetToken)).body.isSuperAdmin, false)
        assert.equal((await team()).body.team.some((person: { id: number; isSuperAdmin: boolean }) => person.id === superId && person.isSuperAdmin), true)

        // Adding an administrator needs the actor's own password and an account that exists and is confirmed.
        const add = (body: Record<string, unknown>, token = adminToken) => request("POST", "/admin/team", body, token)
        assert.equal((await add({ email: targetEmail })).status, 400)
        assert.equal((await add({ email: targetEmail, password: "wrong-password-here" })).status, 403)
        assert.equal((await add({ password: goodPassword })).status, 400)
        assert.equal((await add({ email: targetEmail, password: goodPassword, superAdmin: "yes" })).status, 400)
        assert.equal((await add({ email: "nobody-here@example.test", password: goodPassword })).status, 404)
        assert.equal((await add({ email: targetEmail, password: goodPassword }, targetToken)).status, 403)
        const unconfirmed = await prisma.user.create({ data: { name: "New person", email: `unconfirmed-${randomUUID()}@example.test`, passwordHash: "integration-test-not-a-password", role: "CONSUMER" } })

        try {
            assert.equal((await add({ email: unconfirmed.email, password: goodPassword })).status, 409)
        } finally {
            await prisma.user.delete({ where: { id: unconfirmed.id } })
        }

        const added = await add({ email: targetEmail.toUpperCase(), password: goodPassword })
        assert.equal(added.status, 201)
        assert.equal(added.body.team.find((person: { id: number }) => person.id === fixture.consumerId).isSuperAdmin, false)
        assert.equal((await add({ email: targetEmail, password: goodPassword })).status, 409)
        // A new administrator reaches the administrator screens but not the super administrator ones.
        assert.equal((await request("GET", "/admin/summary", undefined, targetToken)).status, 200)
        assert.equal((await request("GET", "/admin/team", undefined, targetToken)).status, 403)

        // Super level can be given and taken away; the last super administrator cannot be removed.
        const makeSuper = (value: unknown, password: unknown = goodPassword, id = fixture.consumerId, token = adminToken) => request("POST", `/admin/team/${id}/super`, { value, password }, token)
        assert.equal((await makeSuper("yes")).status, 400)
        assert.equal((await makeSuper(true, "wrong-password-here")).status, 403)
        assert.equal((await makeSuper(false)).status, 409)
        assert.equal((await makeSuper(true, goodPassword, 999999)).status, 404)
        assert.equal((await makeSuper(true)).body.team.find((person: { id: number }) => person.id === fixture.consumerId).isSuperAdmin, true)
        assert.equal((await makeSuper(true)).status, 409)
        assert.equal((await request("GET", "/admin/team", undefined, targetToken)).status, 200)
        assert.equal((await makeSuper(false, goodPassword, fixture.consumerId, targetToken)).status, 403)
        assert.equal((await makeSuper(false)).status, 200)
        const lastSuper = await makeSuper(false, goodPassword, superId)
        assert.equal(lastSuper.status, 409)
        assert.equal(lastSuper.body.code, "LAST_SUPER_ADMIN")
        const revokeSelf = await request("POST", `/admin/team/${superId}/revoke`, { password: goodPassword }, adminToken)
        assert.equal(revokeSelf.status, 409)
        assert.equal(revokeSelf.body.code, "LAST_SUPER_ADMIN")

        // Removing an administrator takes effect at once.
        const revoke = (password: unknown, id: number | string = fixture.consumerId) => request("POST", `/admin/team/${id}/revoke`, { password }, adminToken)
        assert.equal((await revoke(undefined)).status, 400)
        assert.equal((await revoke("wrong-password-here")).status, 403)
        assert.equal((await revoke(goodPassword, "abc")).status, 404)
        assert.equal((await revoke(goodPassword, fixture.sellerId)).status, 404)
        const revoked = await revoke(goodPassword)
        assert.equal(revoked.status, 200)
        assert.equal(revoked.body.team.some((person: { id: number }) => person.id === fixture.consumerId), false)
        assert.equal((await request("GET", "/admin/summary", undefined, targetToken)).status, 403)
        assert.equal((await revoke(goodPassword)).status, 404)

        // The two people involved are told.
        await waitForNotifications()
        const subjects = subjectsTo(targetEmail)
        for (const subject of ["You are now a StoreHatch administrator", "You are now a StoreHatch super administrator", "Your super administrator access was removed", "Your administrator access was removed"]) {
            assert.ok(subjects.includes(subject), subject)
        }

        // A seller block is in the log too. Newest first, with who did it and to whom.
        assert.equal((await request("POST", `/admin/sellers/${fixture.sellerId}/block`, { note: "Selling items that are not allowed." }, adminToken)).status, 200)
        const log = (await request("GET", "/admin/audit-log", undefined, adminToken)).body
        assert.deepEqual([log.page, log.pageSize], [1, 50])
        const mine = (log.entries as Array<{ action: string; actor: { id: number }; target: { id: number; email: string } | null; detail: string | null }>).filter((entry) => entry.actor.id === superId)
        assert.deepEqual(mine.slice(0, 5).map((entry) => entry.action), ["SELLER_BLOCKED", "ADMIN_REVOKED", "SUPER_ADMIN_REMOVED", "SUPER_ADMIN_GRANTED", "ADMIN_GRANTED"])
        assert.equal(mine[0]!.target!.id, fixture.sellerId)
        assert.equal(mine[0]!.detail, "Selling items that are not allowed.")
        assert.equal(mine[1]!.target!.email, targetEmail)
        assert.equal((await request("GET", "/admin/audit-log?page=0", undefined, adminToken)).status, 400)

        // An administrator whose account has no password (made with Google) must set one before managing the team.
        await prisma.user.update({ where: { id: superId }, data: { passwordHash: null } })
        const noPassword = await add({ email: targetEmail, password: goodPassword })
        assert.equal(noPassword.status, 403)
        assert.equal(noPassword.body.code, "ADMIN_PASSWORD_REQUIRED")
    })
})

test("the platform figures show people, sales, refunds, complaints and what needs attention", async () => {
    await withPaymentCheckout("admin-platform", async (context) => {
        const { fixture, request, adminToken, checkoutId } = context
        const superId = (jwt.decode(adminToken) as { id: number }).id
        await prisma.user.update({ where: { id: superId }, data: { isSuperAdmin: true } })
        const summary = async () => (await request("GET", "/admin/platform", undefined, adminToken)).body
        const before = await summary()

        assert.ok(before.users.total >= 3)
        assert.equal(before.users.total, before.users.buyers + before.users.sellers)
        assert.ok(before.users.admins >= 1 && before.users.joinedLast7Days >= 3 && before.users.joinedLast30Days >= before.users.joinedLast7Days)
        assert.ok(before.shops.total >= 1 && before.shops.listingsOnSale >= 1)
        for (const period of ["allTime", "last30Days", "last7Days", "today"]) {
            const sales = before.sales[period]
            assert.match(sales.paid, /^\d+\.\d{2}$/)
            assert.equal(Number(sales.net).toFixed(2), (Number(sales.paid) - Number(sales.refunded)).toFixed(2), period)
        }
        assert.ok(Array.isArray(before.topSellersLast30Days) && before.topSellersLast30Days.length <= 5)

        // A paid order raises the paid orders and the sales; a complaint raises the ones waiting for the seller.
        const orderId = await payAndShip(context)
        const complaint = await complain(context, orderId)
        assert.equal(complaint.status, 201)
        const after = await summary()
        assert.equal(after.orders.paid, before.orders.paid + 1)
        assert.equal(after.orders.shipped, before.orders.shipped + 1)
        assert.equal(Number(after.sales.allTime.paid) - Number(before.sales.allTime.paid), 3000)
        assert.equal(after.sales.today.payments, before.sales.today.payments + 1)
        assert.equal(after.complaints.awaitingSeller, before.complaints.awaitingSeller + 1)
        assert.equal(after.shops.blocked, before.shops.blocked)
        const top = (after.topSellersLast30Days as Array<{ sellerId: number; orders: number; sales: string }>).find((seller) => seller.sellerId === fixture.sellerId)
        assert.ok(top && top.orders >= 1 && Number(top.sales) >= 3000)

        // An overdue seller answer is counted separately.
        await prisma.dispute.update({ where: { id: complaint.body.dispute.id }, data: { responseDueAt: new Date(Date.now() - 1000) } })
        assert.equal((await summary()).complaints.overdueSellerResponse, before.complaints.overdueSellerResponse + 1)

        // A refund shows as money in progress, then as refunded.
        const issued = await refundOrder(context, orderId)
        assert.equal(issued.status, 201)
        const progress = await summary()
        assert.equal(progress.refunds.processing, before.refunds.processing + 1)
        assert.equal(Number(progress.refunds.amountInProgress) - Number(before.refunds.amountInProgress), 3000)
        providerReports(context, issued.body.refund, 300000, "succeeded", "processed")
        await request("POST", `/admin/refunds/${issued.body.refund.id}/sync`, undefined, adminToken)
        const refunded = await summary()
        assert.equal(Number(refunded.sales.allTime.refunded) - Number(before.sales.allTime.refunded), 3000)
        assert.equal(refunded.orders.refunded, before.orders.refunded + 1)
        assert.equal(refunded.sellerDebts.open, before.sellerDebts.open + 1)
        assert.equal(Number(refunded.sellerDebts.amountStillOwed) - Number(before.sellerDebts.amountStillOwed), 3000)
        assert.equal(checkoutId > 0, true)
    })
})

// ---- Order and debt limits ----

test("an order above the limit cannot be checked out, and the limit can be switched off", async () => {
    await withPaymentCheckout("order-limit", async (context) => {
        const { request } = context
        const original = config.maximumOrderValue

        try {
            // The checkout holds one order of 2 × ₦1,500 = ₦3,000. The limit is not advertised in the review.
            const open = await request("GET", "/checkout/preview")
            assert.equal(open.status, 200)
            assert.equal("orderLimit" in open.body, false)
            assert.equal(JSON.stringify(open.body).includes("100000"), false)

            config.maximumOrderValue = 2500
            const preview = await request("GET", "/checkout/preview")
            assert.equal(preview.status, 409)
            assert.equal(preview.body.code, "CHECKOUT_ORDER_TOO_LARGE")
            assert.equal(preview.body.orderTotal, "3000.00")
            assert.equal(preview.body.limit, "2500.00")
            assert.match(preview.body.message, /at most ₦2,500/)
            assert.equal(typeof preview.body.seller.businessName, "string")
            const creating = await request("POST", "/checkout", { reviewToken: "x", delivery: fixtureDelivery })
            assert.notEqual(creating.status, 201)

            // Exactly the limit is fine, and null means no limit.
            config.maximumOrderValue = 3000
            assert.equal((await request("GET", "/checkout/preview")).status, 200)
            config.maximumOrderValue = null
            assert.equal((await request("GET", "/checkout/preview")).status, 200)
        } finally {
            config.maximumOrderValue = original
        }
    })
})

test("a seller who owes too much for refunds takes no new orders, without the buyer being told why", async () => {
    await withPaymentCheckout("debt-limit", async (context) => {
        const { fixture, request, adminToken } = context
        const original = config.sellerDebtLimit

        try {
            // A refund charged to the seller makes a debt of ₦3,000.
            const orderId = await payAndShip(context)
            const issued = await refundOrder(context, orderId)
            assert.equal(issued.status, 201)
            const standing = async (token: string, path: string) => (await request("GET", path, undefined, token)).body.standing
            let mine = await standing(fixture.sellerToken, "/seller/standing")
            assert.deepEqual(mine.debt, { amountOwed: "3000.00", limit: "50000.00", ordersPaused: false })

            // Under the limit, the next order goes ahead.
            const cart = await prisma.cart.findUniqueOrThrow({ where: { userId: fixture.consumerId } })
            await prisma.cartItem.create({ data: { cartId: cart.id, listingId: fixture.listingId, quantity: 1 } })
            assert.equal((await request("GET", "/checkout/preview")).status, 200)

            // Over the limit, the shop stops taking orders. The buyer sees a plain message with no debt figure.
            config.sellerDebtLimit = 2000
            const paused = await request("GET", "/checkout/preview")
            assert.equal(paused.status, 409)
            assert.equal(paused.body.code, "CHECKOUT_ITEMS_UNAVAILABLE")
            assert.match(paused.body.message, /is not taking new orders at the moment/)
            assert.equal(JSON.stringify(paused.body).includes("3000"), false)
            mine = await standing(fixture.sellerToken, "/seller/standing")
            assert.deepEqual(mine.debt, { amountOwed: "3000.00", limit: "2000.00", ordersPaused: true })
            assert.equal((await standing(adminToken, `/admin/sellers/${fixture.sellerId}/standing`)).debt.ordersPaused, true)

            // Exactly at the limit is allowed; switching the limit off, or raising it, lets orders through again.
            config.sellerDebtLimit = 3000
            assert.equal((await request("GET", "/checkout/preview")).status, 200)
            config.sellerDebtLimit = null
            assert.equal((await request("GET", "/checkout/preview")).status, 200)
            assert.equal((await standing(fixture.sellerToken, "/seller/standing")).debt.limit, null)
        } finally {
            config.sellerDebtLimit = original
        }
    })
})

// ---- Public trust numbers ----

test("shops and products show trust numbers the server works out from real orders", async () => {
    await withPaymentCheckout("trust-numbers", async (context) => {
        const { fixture, request } = context
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId }, select: { title: true, category: true } })
        const slug = (await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })).slug
        const shopTrust = async () => (await request("GET", `/seller/shop/${slug}`)).body.profile.trust
        const productPage = async (id = fixture.listingId) => (await request("GET", `/listings/${id}`)).body

        // A new shop: nothing delivered yet, but its payout account was checked with the provider.
        let trust = await shopTrust()
        assert.deepEqual([trust.confirmedDeliveries, trust.complaintsSettled, trust.complaintsOpen, trust.payoutVerified], [0, 0, 0, true])
        assert.ok(new Date(trust.sellingSince).getTime() <= Date.now())
        assert.equal((await productPage()).deliveredCount, 0)

        // Only a delivery the buyer confirms counts.
        const orderId = await payAndShip(context)
        await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        assert.equal((await shopTrust()).confirmedDeliveries, 0)
        assert.equal((await request("POST", `/orders/${context.checkoutId}/seller-orders/${orderId}/confirm-delivery`, {})).status, 200)
        trust = await shopTrust()
        assert.equal(trust.confirmedDeliveries, 1)
        const page = await productPage()
        assert.equal(page.deliveredCount, 1)
        assert.equal(page.shopTrust.confirmedDeliveries, 1)
        assert.equal(page.shopTrust.payoutVerified, true)

        // The same numbers on the shop's product cards, in search and on the category's shop cards (with no account id).
        const shopCards = (await request("GET", `/seller/shop/${slug}`)).body.listings as Array<{ id: number; deliveredCount: number }>
        assert.equal(shopCards.find((card) => card.id === fixture.listingId)?.deliveredCount, 1)
        const found = (await request("GET", `/listings?search=${encodeURIComponent(listing.title)}`)).body.listings as Array<{ id: number; deliveredCount: number }>
        assert.equal(found.find((card) => card.id === fixture.listingId)?.deliveredCount, 1)
        const shops = (await request("GET", `/seller/shops?category=${encodeURIComponent(listing.category)}`)).body as Array<{ slug: string; trust: { confirmedDeliveries: number }; userId?: number }>
        const shop = shops.find((candidate) => candidate.slug === slug)
        assert.equal(shop?.trust.confirmedDeliveries, 1)
        assert.equal(shop && "userId" in shop, false)

        // Complaints show as open, then settled once withdrawn.
        const complaint = await complain(context, orderId)
        assert.equal(complaint.status, 201)
        trust = await shopTrust()
        assert.deepEqual([trust.complaintsOpen, trust.complaintsSettled], [1, 0])
        assert.equal((await request("POST", `/disputes/${complaint.body.dispute.id}/withdraw`, {})).status, 200)
        trust = await shopTrust()
        assert.deepEqual([trust.complaintsOpen, trust.complaintsSettled], [0, 1])

        // A product with options counts the deliveries of all its options together.
        const product = (await request("POST", "/listings", { title: `Trust product ${randomUUID().slice(0, 6)}`, description: "A product with options", price: 1000, category: "Electronics", imageUrls: ["https://img.example.test/p.jpg"], options: [{ label: "Blue", stockQuantity: 3 }] }, fixture.sellerToken)).body
        assert.equal((await productPage(product.id)).deliveredCount, 0)
        await prisma.listing.update({ where: { id: fixture.listingId }, data: { parentId: product.id, optionLabel: "Fixture", sizeLabel: null } })
        assert.equal((await productPage(product.id)).deliveredCount, 1)

        // A delivery closed automatically (no word from the buyer) does not count, and neither does an unchecked bank account.
        await prisma.order.update({ where: { id: orderId }, data: { deliveryConfirmedAt: null, deliveryAutoClosedAt: new Date() } })
        await prisma.sellerPayoutAccount.updateMany({ where: { sellerProfile: { userId: fixture.sellerId } }, data: { status: "PENDING" } })
        trust = await shopTrust()
        assert.deepEqual([trust.confirmedDeliveries, trust.payoutVerified], [0, false])
    })
})

// ---- Delivery fee by state ----

test("a seller can charge a different delivery fee per state, and checkout charges the buyer's state", async () => {
    await withPaymentCheckout("shipping-by-state", async (context) => {
        const { fixture, request } = context
        const seller = fixture.sellerToken
        const slug = (await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })).slug
        const put = (body: unknown, token = seller) => request("PUT" as "GET", "/seller/shipping-rates", body, token)
        const preview = (state?: string) => request("GET", state === undefined ? "/checkout/preview" : `/checkout/preview?state=${encodeURIComponent(state)}`)

        // The default: the shop's own policy (free here) everywhere.
        assert.deepEqual((await request("GET", "/seller/shipping-rates", undefined, seller)).body, { shippingPolicy: "FREE", shippingCost: null, deliversEverywhere: true, rates: [] })

        // Bad lists are refused with a reason, and only sellers can set fees.
        for (const [body, message] of [
            [{ rates: "Lagos" }, /must be a list/],
            [{ rates: [{ state: "Atlantis", cost: 100 }] }, /not a Nigerian state/],
            [{ rates: [{ state: "Lagos", cost: 100 }, { state: "Lagos", cost: 200 }] }, /listed twice/],
            [{ rates: [{ state: "Lagos", cost: -5 }] }, /amount in naira/],
            [{ rates: [{ state: "Lagos", cost: "1.234" }] }, /amount in naira/],
            [{ rates: [{ state: "Lagos", cost: true }] }, /amount in naira/],
            [{ deliversEverywhere: "no", rates: [] }, /true or false/],
            [{ deliversEverywhere: false, rates: [{ state: "Kano", cost: null }] }, /at least one/]
        ] as const) {
            const refused = await put(body)
            assert.equal(refused.status, 400, JSON.stringify(body))
            assert.match(refused.body.message, message)
        }
        assert.equal((await put({ rates: [] }, fixture.token)).status, 403)

        const saved = await put({ rates: [{ state: "Lagos", cost: 1500 }, { state: "Kano", cost: null }, { state: "Oyo", cost: "2000.50" }] })
        assert.equal(saved.status, 200)
        assert.deepEqual(saved.body.rates, [{ state: "Kano", cost: null }, { state: "Lagos", cost: "1500.00" }, { state: "Oyo", cost: "2000.50" }])
        const shop = (await request("GET", `/seller/shop/${slug}`)).body.profile
        assert.deepEqual([shop.deliversEverywhere, shop.shippingRates], [true, saved.body.rates])

        // Without a state the default fee shows, flagged as depending on the state.
        const open = await preview()
        assert.equal(open.status, 200)
        assert.deepEqual([open.body.sellers[0].shipping, open.body.sellers[0].shippingVaries, open.body.deliveryState], ["0.00", true, null])

        // With the buyer's state, that state's fee; a state not listed gets the default; a state with no delivery is refused.
        const lagos = await preview("Lagos")
        assert.deepEqual([lagos.body.sellers[0].shipping, lagos.body.total, lagos.body.sellers[0].shippingVaries, lagos.body.deliveryState], ["1500.00", "4500.00", false, "Lagos"])
        assert.equal((await preview("Abia")).body.sellers[0].shipping, "0.00")
        const kano = await preview("Kano")
        assert.equal(kano.status, 409)
        assert.equal(kano.body.code, "CHECKOUT_DELIVERY_UNAVAILABLE")
        assert.equal(kano.body.state, "Kano")
        assert.match(kano.body.message, /does not deliver to Kano/)
        assert.equal((await preview("Atlantis")).status, 400)

        // Paying needs the price for the delivery state: a review made without the state is out of date.
        const stale = await request("POST", "/checkout", { reviewToken: open.body.reviewToken, delivery: fixtureDelivery })
        assert.equal(stale.status, 409)
        assert.equal(stale.body.code, "CHECKOUT_REVIEW_REQUIRED")
        const placed = await request("POST", "/checkout", { reviewToken: lagos.body.reviewToken, delivery: fixtureDelivery })
        assert.ok(placed.status === 200 || placed.status === 201, String(placed.status))
        const order = await prisma.order.findFirstOrThrow({ where: { checkoutId: placed.body.checkout.id } })
        assert.equal(order.shippingCost.toFixed(2), "1500.00")
        assert.equal(order.total.toFixed(2), "4500.00")

        // Delivering only to listed states: everywhere else is refused, and the cheapest listed fee stands in until the state is known.
        await put({ deliversEverywhere: false, rates: [{ state: "Lagos", cost: 1500 }, { state: "Oyo", cost: 2500 }] })
        assert.deepEqual([(await preview()).body.sellers[0].shipping, (await preview()).body.sellers[0].shippingVaries], ["1500.00", true])
        assert.equal((await preview("Abia")).body.code, "CHECKOUT_DELIVERY_UNAVAILABLE")
        assert.equal((await preview("Oyo")).body.sellers[0].shipping, "2500.00")
        assert.equal((await request("GET", `/seller/shop/${slug}`)).body.profile.deliversEverywhere, false)

        // Clearing the list and delivering everywhere again goes back to the default.
        const cleared = await put({ deliversEverywhere: true, rates: [] })
        assert.deepEqual([cleared.body.deliversEverywhere, cleared.body.rates], [true, []])
        assert.deepEqual([(await preview("Lagos")).body.sellers[0].shipping, (await preview()).body.sellers[0].shippingVaries], ["0.00", false])
    })
})

// ---- Shop branding ----

test("a seller can brand their shop with a banner, a preset colour, an about text, socials and a WhatsApp button", async () => {
    await withPaymentCheckout("shop-branding", async (context) => {
        const { fixture, request } = context
        const seller = fixture.sellerToken
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })
        const patch = (body: unknown, token = seller) => request("PATCH" as "GET", "/seller/profile", body, token)
        const publicShop = async () => (await request("GET", `/seller/shop/${profile.slug}`)).body.profile

        // A new shop is forest green with nothing else set.
        const fresh = (await request("GET", "/seller/profile", undefined, seller)).body.branding
        assert.equal(fresh.brandColor.key, "forest")
        assert.deepEqual([fresh.bannerUrl, fresh.about, fresh.whatsapp, fresh.social.instagram], [null, null, null, null])

        // Each field is checked.
        for (const [body, message] of [
            [{ bannerUrl: "http://img.example.test/banner.jpg" }, /https link/],
            [{ brandColor: "pink" }, /one of: forest, navy, teal, indigo, plum, wine, terracotta, charcoal, brown, cream, beige/],
            [{ about: "x".repeat(501) }, /500 characters or fewer/],
            [{ about: "Order at https://elsewhere.example.test" }, /cannot contain links/],
            [{ about: "Find us at mystore.com for cheaper prices" }, /cannot contain links/],
            [{ instagram: "bad handle!" }, /Instagram username only/],
            [{ tiktok: "@a" }, /TikTok username only/],
            [{ x: "a_name_that_is_far_too_long" }, /X username only/],
            [{ whatsappNumber: "12345" }, /Nigerian mobile number/]
        ] as const) {
            const refused = await patch(body)
            assert.equal(refused.status, 400, JSON.stringify(body))
            assert.match(refused.body.message, message)
        }
        assert.equal((await patch({ brandColor: "navy" }, fixture.token)).status, 403)

        // Branding alone is a valid update. Handles lose their @, the number is stored in one form, blank lines are tidied.
        const saved = await patch({
            bannerUrl: "https://img.example.test/banner.jpg",
            brandColor: "cream",
            about: "Handmade Ankara pieces.\n\n\n\nCustom sizes in 5 days.",
            instagram: "@adaskloset",
            tiktok: "adas.kloset",
            facebook: "adaskloset",
            x: "ada_kloset",
            whatsappNumber: "0801 234 5678"
        })
        assert.equal(saved.status, 200)
        const branding = saved.body.branding
        assert.deepEqual(branding.brandColor, { key: "cream", name: "Cream", background: "#F3EBDD", text: "#242923", tint: "#FBF8F3", light: true })
        assert.equal(branding.about, "Handmade Ankara pieces.\n\nCustom sizes in 5 days.")
        assert.deepEqual(branding.social.instagram, { handle: "adaskloset", url: "https://instagram.com/adaskloset" })
        assert.deepEqual(branding.social.tiktok, { handle: "adas.kloset", url: "https://www.tiktok.com/@adas.kloset" })
        assert.equal(branding.social.x.url, "https://x.com/ada_kloset")
        assert.equal(branding.whatsapp.number, "+2348012345678")
        assert.match(branding.whatsapp.url, /^https:\/\/wa\.me\/2348012345678\?text=Hi%20/)
        assert.ok(decodeURIComponent(branding.whatsapp.url).endsWith("I found your shop on StoreHatch."))

        // Shoppers see the same branding, and nothing private: no raw columns and no payout phone.
        const shop = await publicShop()
        assert.deepEqual(shop.branding, branding)
        for (const key of ["whatsappNumber", "instagramHandle", "bannerUrl", "brandColor", "businessPhone"]) {
            assert.equal(key in shop, false, key)
        }
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId }, select: { category: true } })
        const cards = (await request("GET", `/seller/shops?category=${encodeURIComponent(listing.category)}`)).body as Array<{ slug: string; branding: { bannerUrl: string; brandColor: { key: string } } }>
        const card = cards.find((candidate) => candidate.slug === profile.slug)
        assert.deepEqual([card?.branding.bannerUrl, card?.branding.brandColor.key], ["https://img.example.test/banner.jpg", "cream"])

        // Any form of a Nigerian number works; blank or null clears a field, and the colour stays.
        assert.equal((await patch({ whatsappNumber: "+234 703 000 1111" })).body.branding.whatsapp.number, "+2347030001111")
        const cleared = (await patch({ bannerUrl: null, instagram: "", whatsappNumber: null, about: "" })).body.branding
        assert.deepEqual([cleared.bannerUrl, cleared.social.instagram, cleared.whatsapp, cleared.about, cleared.brandColor.key], [null, null, null, null, "cream"])
        assert.equal(cleared.social.tiktok.handle, "adas.kloset")
    })
})

// ---- Share links and sitemap ----

test("share links give WhatsApp and Facebook a title, picture and description, and send people on to the app", async () => {
    await withPaymentCheckout("share-links", async (context) => {
        const { fixture, request, baseUrl } = context
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
        const page = async (path: string) => {
            const response = await fetch(`${baseUrl}${path}`)
            return { status: response.status, type: response.headers.get("content-type") ?? "", html: await response.text() }
        }
        const meta = (html: string, property: string) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1]

        // A shop: its name, about text and banner (resized to 1200 by 630 when it is a Cloudinary picture).
        await request("PATCH" as "GET", "/seller/profile", { about: 'Best "Ankara" <b>deals</b> in Lagos', bannerUrl: "https://res.cloudinary.com/demo/image/upload/v1/banner.jpg" }, fixture.sellerToken)
        const shop = await page(`/share/shop/${profile.slug}`)
        assert.equal(shop.status, 200)
        assert.match(shop.type, /text\/html/)
        assert.equal(meta(shop.html, "og:title"), `${profile.businessName} on StoreHatch`)
        assert.equal(meta(shop.html, "og:description"), "Best &quot;Ankara&quot; &lt;b&gt;deals&lt;/b&gt; in Lagos")
        assert.equal(shop.html.includes("<b>"), false)
        assert.equal(meta(shop.html, "og:image"), "https://res.cloudinary.com/demo/image/upload/c_pad,b_white,w_1200,h_630,f_jpg,q_auto/v1/banner.jpg")
        assert.equal(meta(shop.html, "og:url"), `${config.publicApiUrl}/share/shop/${profile.slug}`)
        assert.match(shop.html, new RegExp(`<meta http-equiv="refresh" content="0; url=${config.frontendUrl}/shop/${profile.slug}">`))
        assert.equal((await request("GET", `/seller/shop/${profile.slug}`)).body.profile.shareUrl, `${config.publicApiUrl}/share/shop/${profile.slug}`)

        // A product: its title and price, the shop's name, and its photo.
        const product = await page(`/share/product/${listing.id}`)
        assert.equal(product.status, 200)
        assert.equal(meta(product.html, "og:type"), "product")
        assert.match(meta(product.html, "og:title") ?? "", new RegExp(`₦`))
        assert.ok((meta(product.html, "og:title") ?? "").startsWith(listing.title.replace(/&/g, "&amp;")))
        assert.ok((meta(product.html, "og:description") ?? "").startsWith(`${profile.businessName} on StoreHatch.`))
        assert.equal(meta(product.html, "og:image"), listing.imageUrl)
        assert.match(product.html, new RegExp(`url=${config.frontendUrl}/product/${listing.id}"`))
        assert.equal((await request("GET", `/listings/${listing.id}`)).body.shareUrl, `${config.publicApiUrl}/share/product/${listing.id}`)

        // A product with options shares as the product, priced "from" its lowest option.
        const withOptions = (await request("POST", "/listings", { title: "Share hoodie", description: "Soft", price: 5000, category: "Electronics", imageUrls: ["https://img.example.test/h.jpg"], options: [{ label: "Blue", price: 5000, stockQuantity: 2 }, { label: "Red", price: 7000, stockQuantity: 2 }] }, fixture.sellerToken)).body
        const optionPage = await page(`/share/product/${withOptions.options[1].listingId}`)
        assert.equal(meta(optionPage.html, "og:title"), "Share hoodie · from ₦5,000")
        assert.equal(meta(optionPage.html, "og:url"), `${config.publicApiUrl}/share/product/${withOptions.id}`)

        // Anything that cannot be shared gives a tidy page that goes to the home page.
        for (const path of ["/share/product/999999999", "/share/product/abc", "/share/shop/no-such-shop"]) {
            const missing = await page(path)
            assert.equal(missing.status, 404, path)
            assert.match(missing.html, new RegExp(`url=${config.frontendUrl}/"`))
        }
        await prisma.listing.update({ where: { id: withOptions.id }, data: { archivedAt: new Date() } })
        assert.equal((await page(`/share/product/${withOptions.id}`)).status, 404)
    })
})

test("the sitemap lists shops and products that are on sale, and leaves out blocked shops", async () => {
    await withPaymentCheckout("sitemap", async (context) => {
        const { fixture, baseUrl } = context
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })
        const sitemap = async () => {
            const response = await fetch(`${baseUrl}/sitemap.xml`)
            return { type: response.headers.get("content-type") ?? "", xml: await response.text() }
        }

        const first = await sitemap()
        assert.match(first.type, /application\/xml/)
        assert.ok(first.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
        assert.ok(first.xml.includes(`<loc>${config.frontendUrl}/</loc>`))
        assert.ok(first.xml.includes(`<loc>${config.frontendUrl}/shop/${profile.slug}</loc>`))
        assert.match(first.xml, new RegExp(`<loc>${config.frontendUrl}/product/${fixture.listingId}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`))

        await prisma.sellerProfile.update({ where: { id: profile.id }, data: { blockedAt: new Date(), blockReason: "test" } })
        const blocked = (await sitemap()).xml
        assert.equal(blocked.includes(`/shop/${profile.slug}<`), false)
        assert.equal(blocked.includes(`/product/${fixture.listingId}<`), false)
    })
})

// ---- One account can buy and sell ----

test("a seller can shop like a buyer, but never from their own shop", async () => {
    await withPaymentCheckout("buy-and-sell", async (context) => {
        const { fixture, request } = context
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })

        // Another seller buys from this shop: a cart is made for them on the first add.
        await withStrangerSeller(async (otherSeller) => {
            assert.equal((await request("GET", "/cart", undefined, otherSeller)).body.cart, null)
            assert.equal((await request("POST", "/cart/items", { listingId: fixture.listingId, quantity: 1 }, otherSeller)).status, 201)
            assert.equal((await request("GET", "/cart", undefined, otherSeller)).body.cart.cartItems.length, 1)
            assert.equal((await request("GET", "/checkout/preview", undefined, otherSeller)).status, 200)
            for (const path of ["/orders", "/disputes", "/pre-orders"]) {
                assert.equal((await request("GET", path, undefined, otherSeller)).status, 200, path)
            }
            const strangerCarts = { cart: { user: { email: { startsWith: "dispute-stranger-" } } } }
            await prisma.cartItem.deleteMany({ where: strangerCarts })
            await prisma.cart.deleteMany({ where: strangerCarts.cart })
        })

        // Their own products cannot go in the cart.
        const own = await request("POST", "/cart/items", { listingId: fixture.listingId, quantity: 1 }, fixture.sellerToken)
        assert.equal(own.status, 409)
        assert.equal(own.body.code, "CART_OWN_LISTING")

        // Nor be checked out, should one get into the cart some other way.
        const cart = await prisma.cart.upsert({ where: { userId: fixture.sellerId }, create: { userId: fixture.sellerId }, update: {} })
        await prisma.cartItem.create({ data: { cartId: cart.id, listingId: fixture.listingId, quantity: 1 } })
        const preview = await request("GET", "/checkout/preview", undefined, fixture.sellerToken)
        assert.equal(preview.status, 409)
        assert.equal(preview.body.code, "CHECKOUT_OWN_LISTING")
        assert.equal(preview.body.listingId, fixture.listingId)

        // Nor pre-ordered.
        const readyAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
        const preOrder = await request("POST", "/pre-orders", { sellerSlug: profile.slug, readyAt }, fixture.sellerToken)
        assert.equal(preOrder.status, 409)
        assert.match(preOrder.body.message, /your own shop/)
        await prisma.cartItem.deleteMany({ where: { cartId: cart.id } })
        await prisma.cart.delete({ where: { id: cart.id } })
    })
})

test("a buyer can become a seller on the same account and keep their cart and orders", async () => {
    await withPaymentCheckout("become-seller", async (context) => {
        const { fixture, request } = context
        const buyer = await fixture.addConsumer(1)
        const cartBefore = (await request("GET", "/cart", undefined, buyer.token)).body.cart

        assert.equal((await fetch(`${context.baseUrl}/users/become-seller`, { method: "POST" })).status, 401)

        const changed = await request("POST", "/users/become-seller", {}, buyer.token)
        assert.equal(changed.status, 200)
        assert.equal(changed.body.role, "SELLER")
        assert.equal((await request("GET", "/users/check", undefined, buyer.token)).body.role, "SELLER")
        // Asking again changes nothing.
        assert.equal((await request("POST", "/users/become-seller", {}, buyer.token)).body.role, "SELLER")

        // Still a shopper, and now allowed into the seller screens.
        assert.deepEqual((await request("GET", "/cart", undefined, buyer.token)).body.cart, cartBefore)
        assert.equal((await request("GET", "/orders", undefined, buyer.token)).status, 200)
        assert.equal((await request("GET", "/seller/payout/banks", undefined, buyer.token)).status === 403, false)
    })
})

// ---- My orders: photos, shop branding, tabs ----

test("my orders can be filtered by tab, and every tab shows its count", async () => {
    await withPaymentCheckout("my-orders-tabs", async (context) => {
        const { fixture, checkoutId, request } = context
        const orderId = await payForCheckout(context)
        const list = async (query = "") => (await request("GET", `/orders${query}`)).body
        const expectTabs = async (counts: Record<string, number>) => {
            const all = await list()
            assert.deepEqual(all.counts, counts)
            for (const [name, count] of Object.entries(counts)) {
                const tab = await list(`?status=${name}`)
                assert.equal(tab.total, count, name)
                assert.deepEqual(tab.orders.map((order: { id: number }) => order.id), count ? [checkoutId] : [], name)
                // The counts never change with the open tab.
                assert.deepEqual(tab.counts, counts, name)
            }
        }

        // Paid, then shipped and reported delivered: in progress either way.
        await expectTabs({ all: 1, progress: 1, delivered: 0, issues: 0 })
        await prisma.order.update({ where: { id: orderId }, data: { status: "SHIPPED", shippedAt: new Date(), deliveryReportedAt: new Date() } })
        await expectTabs({ all: 1, progress: 1, delivered: 0, issues: 0 })

        // A complaint is an issue until it is withdrawn.
        assert.equal((await complain(context, orderId)).status, 201)
        await expectTabs({ all: 1, progress: 1, delivered: 0, issues: 1 })
        // The complaint's amount, reply deadline and opening time, on both order endpoints.
        const saved = await prisma.dispute.findFirstOrThrow({ where: { orderId } })
        for (const dispute of [
            (await list()).orders[0].sellerOrders[0].dispute,
            (await request("GET", `/orders/${checkoutId}`)).body.sellerOrders[0].dispute
        ]) {
            assert.equal(dispute.id, saved.id)
            assert.equal(dispute.requestedAmount, saved.requestedAmount.toFixed(2))
            assert.match(dispute.requestedAmount, /^\d+\.\d{2}$/)
            assert.equal(dispute.responseDueAt, saved.responseDueAt.toISOString())
            assert.equal(dispute.createdAt, saved.createdAt.toISOString())
            assert.ok(saved.responseDueAt > saved.createdAt)
        }
        await prisma.dispute.updateMany({ where: { orderId }, data: { status: "WITHDRAWN" } })
        await expectTabs({ all: 1, progress: 1, delivered: 0, issues: 0 })

        // Delivered, and then partly refunded.
        await prisma.order.update({ where: { id: orderId }, data: { status: "DELIVERED", deliveryConfirmedAt: new Date() } })
        await expectTabs({ all: 1, progress: 0, delivered: 1, issues: 0 })
        await prisma.order.update({ where: { id: orderId }, data: { refundedAmount: 500 } })
        await expectTabs({ all: 1, progress: 0, delivered: 1, issues: 1 })

        for (const bad of ["paid", "ALL", ""]) {
            const refused = await request("GET", `/orders?status=${bad}`)
            assert.equal(refused.status, 400, bad)
            assert.equal(refused.body.message, "Status must be all, progress, delivered or issues")
        }

        // Someone else's orders are not counted.
        const other = await fixture.addConsumer(1)
        assert.deepEqual((await request("GET", "/orders", undefined, other.token)).body.counts, { all: 0, progress: 0, delivered: 0, issues: 0 })
    })
})

test("my orders show each item's photo and option, and the shop's logo and colour", async () => {
    await withPaymentCheckout("my-orders-photos", async (context) => {
        const { fixture, checkoutId, request } = context
        const orderId = await payForCheckout(context)
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })

        // An ordinary product: its own photo, no option.
        const plain = (await request("GET", "/orders")).body.orders[0].sellerOrders[0]
        assert.deepEqual(
            [plain.items[0].imageUrl, plain.items[0].optionLabel, plain.items[0].sizeLabel, plain.items[0].productTitle],
            [listing.imageUrl, null, null, null]
        )
        assert.equal(plain.items[0].title, listing.title)
        assert.deepEqual(Object.keys(plain.seller).sort(), ["brandColor", "businessName", "location", "logoUrl", "slug"])
        assert.equal(plain.seller.logoUrl, profile.logoUrl || null)
        assert.equal(plain.seller.brandColor.key, "forest")
        assert.equal(typeof plain.seller.brandColor.background, "string")

        // A chosen option with no photo of its own shows the product's photo.
        const product = (await request("POST", "/listings", {
            title: "Orders hoodie", description: "Soft", price: 1500, category: "Electronics",
            imageUrls: ["https://img.example.test/orders-hoodie.jpg"],
            options: [{ label: "Blue", price: 1500, sizes: [{ label: "M", stockQuantity: 5 }] }]
        }, fixture.sellerToken))
        assert.equal(product.status, 201, JSON.stringify(product.body))
        const choiceId = product.body.options[0].sizes[0].listingId as number
        await prisma.listing.update({ where: { id: choiceId }, data: { imageUrl: "" } })
        await prisma.orderItem.updateMany({ where: { orderId }, data: { listingId: choiceId } })

        for (const sellerOrder of [
            (await request("GET", "/orders")).body.orders[0].sellerOrders[0],
            (await request("GET", `/orders/${checkoutId}`)).body.sellerOrders[0]
        ]) {
            const [item] = sellerOrder.items
            assert.deepEqual(
                [item.imageUrl, item.optionLabel, item.sizeLabel, item.productTitle],
                ["https://img.example.test/orders-hoodie.jpg", "Blue", "M", "Orders hoodie"]
            )
            assert.equal(sellerOrder.seller.brandColor.key, "forest")
            assert.equal("logoUrl" in sellerOrder.seller, true)
        }
        await prisma.orderItem.updateMany({ where: { orderId }, data: { listingId: fixture.listingId } })

        // The shop's area on both order endpoints, or null when it is empty.
        const sellersOf = async () => [
            (await request("GET", "/orders")).body.orders[0].sellerOrders[0].seller,
            (await request("GET", `/orders/${checkoutId}`)).body.sellerOrders[0].seller
        ]
        await prisma.sellerProfile.update({ where: { id: profile.id }, data: { location: "Yaba, Lagos" } })
        assert.deepEqual((await sellersOf()).map((seller) => seller.location), ["Yaba, Lagos", "Yaba, Lagos"])
        await prisma.sellerProfile.update({ where: { id: profile.id }, data: { location: "" } })
        assert.deepEqual((await sellersOf()).map((seller) => seller.location), [null, null])
    })
})

// ---- Complaints and pre-orders: photos, shop cards, tabs ----

// A product with one option ("Blue") whose photo is left empty, so pages must fall back to the product's photo.
async function optionWithoutPhoto(context: PaymentTestContext, title: string) {
    const product = await context.request("POST", "/listings", {
        title, description: "Soft", price: 1500, category: "Electronics",
        imageUrls: ["https://img.example.test/parent-photo.jpg"],
        options: [{ label: "Blue", price: 1500, stockQuantity: 5 }]
    }, context.fixture.sellerToken)
    assert.equal(product.status, 201, JSON.stringify(product.body))
    const choiceId = product.body.options[0].listingId as number
    await prisma.listing.update({ where: { id: choiceId }, data: { imageUrl: "" } })
    return choiceId
}

test("complaint lists have open and closed tabs with counts, and show photos and the shop's card", async () => {
    await withPaymentCheckout("dispute-tabs", async (context) => {
        const { fixture, request, adminToken } = context
        const orderId = await payAndShip(context)
        assert.equal((await complain(context, orderId)).status, 201)
        const dispute = await prisma.dispute.findFirstOrThrow({ where: { orderId } })
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })

        const lists = [
            { path: "/disputes", token: fixture.token },
            { path: "/seller/disputes", token: fixture.sellerToken }
        ]
        const expectTabs = async (counts: { all: number; open: number; closed: number }) => {
            for (const { path, token } of lists) {
                const all = (await request("GET", path, undefined, token)).body
                assert.deepEqual(all.counts, counts, path)
                assert.equal(all.total, counts.all, path)
                for (const group of ["open", "closed"] as const) {
                    const tab = (await request("GET", `${path}?group=${group}`, undefined, token)).body
                    assert.equal(tab.total, counts[group], `${path} ${group}`)
                    assert.deepEqual(tab.disputes.map((item: { id: number }) => item.id), counts[group] ? [dispute.id] : [], `${path} ${group}`)
                    assert.deepEqual(tab.counts, counts, `${path} ${group}`)
                }
            }
        }

        await expectTabs({ all: 1, open: 1, closed: 0 })
        await prisma.dispute.update({ where: { id: dispute.id }, data: { status: "UNDER_REVIEW" } })
        await expectTabs({ all: 1, open: 1, closed: 0 })
        await prisma.dispute.update({ where: { id: dispute.id }, data: { status: "WITHDRAWN" } })
        await expectTabs({ all: 1, open: 0, closed: 1 })
        await prisma.dispute.update({ where: { id: dispute.id }, data: { status: "RESOLVED" } })
        await expectTabs({ all: 1, open: 0, closed: 1 })
        // ?status= still works on its own.
        assert.equal((await request("GET", "/disputes?status=RESOLVED")).body.total, 1)
        assert.equal((await request("GET", "/disputes?status=OPEN")).body.total, 0)

        for (const { path, token } of lists) {
            const unknown = await request("GET", `${path}?group=pending`, undefined, token)
            assert.equal(unknown.status, 400)
            assert.equal(unknown.body.message, "Group must be open or closed")
            const both = await request("GET", `${path}?group=open&status=OPEN`, undefined, token)
            assert.equal(both.status, 400)
        }
        // The administrator list is unchanged.
        assert.equal("counts" in (await request("GET", "/admin/disputes", undefined, adminToken)).body, false)

        // Photos: an option with no photo shows the product's, on the list and the detail.
        const choiceId = await optionWithoutPhoto(context, "Complaint hoodie")
        await prisma.orderItem.updateMany({ where: { orderId }, data: { listingId: choiceId } })
        await prisma.sellerProfile.update({ where: { id: profile.id }, data: { logoUrl: "", location: "" } })
        const listed = (await request("GET", "/disputes")).body.disputes[0]
        const detail = (await request("GET", `/disputes/${dispute.id}`)).body.dispute
        for (const item of [listed.items[0], detail.order.items[0]]) {
            assert.deepEqual([item.imageUrl, item.optionLabel, item.sizeLabel], ["https://img.example.test/parent-photo.jpg", "Blue", null])
        }
        assert.equal(detail.order.items[0].unitPrice, "1500.00")
        // The shop's card, with no logo or area set.
        for (const seller of [listed.seller, detail.order.seller]) {
            assert.deepEqual([seller.businessName, seller.slug, seller.logoUrl, seller.location], [profile.businessName, profile.slug, null, null])
            assert.equal(seller.brandColor.key, "forest")
        }
        await prisma.orderItem.updateMany({ where: { orderId }, data: { listingId: fixture.listingId } })
    })
})

test("pre-order lists have tabs with counts and a waiting-for-payment number, and show photos and the shop's card", async () => {
    await withPaymentCheckout("preorder-tabs", async (context) => {
        const { fixture, request } = context
        await makeFoodShop(context, "PRE_ORDER")
        const asked = await askForPreOrder(context)
        assert.equal(asked.status, 201)
        const id = asked.body.preOrder.id as number
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })

        const lists = [
            { path: "/pre-orders", token: fixture.token },
            { path: "/seller/pre-orders", token: fixture.sellerToken }
        ]
        const groups = { waiting: "waiting", "to-pay": "toPay", paid: "paid", ended: "ended" } as const
        const expectTabs = async (counts: Record<"all" | "waiting" | "toPay" | "paid" | "ended", number>, awaitingPayment: number) => {
            for (const { path, token } of lists) {
                const all = (await request("GET", path, undefined, token)).body
                assert.deepEqual(all.counts, counts, path)
                // Only the buyer gets the waiting-for-payment number.
                if (path === "/pre-orders") {
                    assert.equal(all.awaitingPayment, awaitingPayment)
                } else {
                    assert.equal("awaitingPayment" in all, false)
                }
                for (const [group, key] of Object.entries(groups)) {
                    const tab = (await request("GET", `${path}?group=${group}`, undefined, token)).body
                    assert.equal(tab.total, counts[key], `${path} ${group}`)
                    assert.deepEqual(tab.preOrders.map((item: { id: number }) => item.id), counts[key] ? [id] : [], `${path} ${group}`)
                    assert.deepEqual(tab.counts, counts, `${path} ${group}`)
                }
            }
        }
        const setStatus = (data: Record<string, unknown>) => prisma.preOrderRequest.update({ where: { id }, data })

        await expectTabs({ all: 1, waiting: 1, toPay: 0, paid: 0, ended: 0 }, 0)
        await setStatus({ status: "APPROVED", payBy: new Date(Date.now() + 60 * 60 * 1000) })
        await expectTabs({ all: 1, waiting: 0, toPay: 1, paid: 0, ended: 0 }, 1)
        // Past its pay-by time it no longer counts as waiting for payment.
        await setStatus({ payBy: new Date(Date.now() - 60 * 1000) })
        await expectTabs({ all: 1, waiting: 0, toPay: 1, paid: 0, ended: 0 }, 0)
        await setStatus({ status: "USED" })
        await expectTabs({ all: 1, waiting: 0, toPay: 0, paid: 1, ended: 0 }, 0)
        for (const status of ["DECLINED", "EXPIRED", "CANCELLED"]) {
            await setStatus({ status })
            await expectTabs({ all: 1, waiting: 0, toPay: 0, paid: 0, ended: 1 }, 0)
        }
        // ?status= still works on its own.
        assert.equal((await request("GET", "/pre-orders?status=CANCELLED")).body.total, 1)

        for (const { path, token } of lists) {
            const unknown = await request("GET", `${path}?group=open`, undefined, token)
            assert.equal(unknown.status, 400)
            assert.equal(unknown.body.message, "Group must be waiting, to-pay, paid or ended")
            assert.equal((await request("GET", `${path}?group=ended&status=CANCELLED`, undefined, token)).status, 400)
        }

        // Photos and options, read from the listing; an option with no photo shows the product's.
        const plain = (await request("GET", "/pre-orders")).body.preOrders[0].items[0]
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
        assert.deepEqual([plain.imageUrl, plain.optionLabel, plain.sizeLabel], [listing.imageUrl, null, null])
        const choiceId = await optionWithoutPhoto(context, "Pre-order hoodie")
        await setStatus({ items: [{ listingId: choiceId, quantity: 1, unitPrice: "1500.00" }] })
        await prisma.sellerProfile.update({ where: { id: profile.id }, data: { logoUrl: "", location: "" } })
        for (const view of [
            (await request("GET", "/pre-orders")).body.preOrders[0],
            (await request("GET", `/pre-orders/${id}`)).body.preOrder,
            (await request("GET", "/seller/pre-orders", undefined, fixture.sellerToken)).body.preOrders[0],
            (await request("GET", `/seller/pre-orders/${id}`, undefined, fixture.sellerToken)).body.preOrder
        ]) {
            assert.deepEqual([view.items[0].imageUrl, view.items[0].optionLabel, view.items[0].sizeLabel], ["https://img.example.test/parent-photo.jpg", "Blue", null])
            assert.deepEqual([view.seller.businessName, view.seller.slug, view.seller.logoUrl, view.seller.location], [profile.businessName, profile.slug, null, null])
            assert.equal(view.seller.brandColor.key, "forest")
        }
    })
})

// ---- Photo reviews ----

test("buyers can add up to three photos to a review, and shoppers can see and filter by them", async () => {
    await withPaymentCheckout("review-photos", async (context) => {
        const { fixture, request, checkoutId, adminToken } = context
        const orderId = await payAndShip(context)
        await request("POST", `/seller/orders/${orderId}/delivered`, {}, fixture.sellerToken)
        await request("POST", `/orders/${checkoutId}/seller-orders/${orderId}/confirm-delivery`, {})
        const path = `/orders/${checkoutId}/seller-orders/${orderId}/reviews`
        const listingId = fixture.listingId
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })
        const photo = (name: string) => `https://res.cloudinary.com/demo/image/upload/v1/${name}.jpg`

        // Only a list of up to three https links.
        for (const photoUrls of [[photo("a"), photo("b"), photo("c"), photo("d")], ["http://img.example.test/a.jpg"], ["not a link"], [42], "https://img.example.test/a.jpg", null]) {
            for (const body of [{ shop: { rating: 5, photoUrls } }, { products: [{ listingId, rating: 5, photoUrls }] }]) {
                const refused = await request("POST", path, body)
                assert.equal(refused.status, 400, JSON.stringify(body))
                assert.equal(refused.body.message, "Photos must be up to 3 https links")
            }
        }

        // Saved with the review (a repeated link is kept once).
        const created = await request("POST", path, {
            shop: { rating: 5, photoUrls: [photo("parcel")] },
            products: [{ listingId, rating: 4, comment: "Same as the pictures", photoUrls: [photo("front"), photo("back"), photo("front")] }]
        })
        assert.equal(created.status, 201)
        assert.deepEqual(created.body.shop.photoUrls, [photo("parcel")])
        assert.deepEqual(created.body.products[0].photoUrls, [photo("front"), photo("back")])
        const state = (await request("GET", path)).body
        assert.deepEqual(state.shop.photoUrls, [photo("parcel")])
        assert.deepEqual(state.products[0].review.photoUrls, [photo("front"), photo("back")])
        const productReviewId = created.body.products[0].id as number

        // Shoppers see them, with how many reviews have photos, and can list only those.
        const others = await addOtherReviewers(context, orderId, [3])
        try {
            const reviews = (query = "") => request("GET", `/listings/${listingId}/reviews${query}`)
            const all = (await reviews()).body
            assert.equal(all.summary.count, 2)
            assert.equal(all.summary.withPhotos, 1)
            assert.deepEqual(all.reviews.map((review: { photoUrls: string[] }) => review.photoUrls.length).sort(), [0, 2])
            const onlyPhotos = (await reviews("?withPhotos=true")).body
            assert.deepEqual(onlyPhotos.reviews.map((review: { id: number }) => review.id), [productReviewId])
            assert.equal(onlyPhotos.summary.count, 2)
            const shop = (await request("GET", `/seller/shop/${profile.slug}/reviews?withPhotos=true`)).body
            assert.deepEqual(shop.reviews.map((review: { photoUrls: string[] }) => review.photoUrls), [[photo("parcel")]])
            assert.equal(shop.summary.withPhotos, 1)

            // The seller and administrators see the photos too.
            const sellerList = (await request("GET", "/seller/reviews?type=product", undefined, fixture.sellerToken)).body.reviews
            assert.deepEqual(sellerList.find((review: { id: number }) => review.id === productReviewId).photoUrls, [photo("front"), photo("back")])
            const adminList = (await request("GET", "/admin/reviews?type=product&status=all", undefined, adminToken)).body.reviews
            assert.deepEqual(adminList.find((review: { id: number }) => review.id === productReviewId).photoUrls, [photo("front"), photo("back")])

            // The buyer can change the photos while the review can still be changed; an empty list removes them.
            const change = (body: unknown) => request("PATCH" as "GET", `/reviews/products/${productReviewId}`, body)
            assert.equal((await change({ photoUrls: ["ftp://img.example.test/a.jpg"] })).status, 400)
            assert.deepEqual((await change({ photoUrls: [photo("side")] })).body.review.photoUrls, [photo("side")])
            assert.equal((await change({ photoUrls: [] })).body.review.photoUrls.length, 0)
            assert.equal((await reviews()).body.summary.withPhotos, 0)
            await change({ photoUrls: [photo("side")] })

            // A hidden review's photos are hidden with it.
            assert.equal((await request("POST", `/admin/reviews/products/${productReviewId}/hide`, { reason: "Not a photo of the product" }, adminToken)).status, 200)
            const afterHiding = (await reviews("?withPhotos=true")).body
            assert.deepEqual([afterHiding.reviews.length, afterHiding.summary.withPhotos], [0, 0])
        } finally {
            await removeUsers(others)
        }
    })
})

// ---- Low-stock alerts ----

test("a sale that takes stock to the seller's alert line emails them once, and the seller's list shows what is low", async () => {
    await withPaymentCheckout("low-stock", async (context) => {
        const { fixture, request } = context
        const seller = await prisma.user.findUniqueOrThrow({ where: { id: fixture.sellerId } })
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
        const mine = async () => (await request("GET", "/listings/Mylisting", undefined, fixture.sellerToken)).body as Array<{ id: number; stockStatus: string; effectiveLowStockThreshold: number; lowStockThreshold: number | null; lowStockOptions: Array<{ listingId: number; stockStatus: string; effectiveLowStockThreshold: number }> }>
        const mineListing = async (id: number) => (await mine()).find((item) => item.id === id)!

        // The shop's number is 3 unless changed; 5 in stock is fine.
        assert.equal((await request("GET", "/seller/profile", undefined, fixture.sellerToken)).body.lowStockThreshold, 3)
        assert.deepEqual([(await mineListing(listing.id)).stockStatus, (await mineListing(listing.id)).effectiveLowStockThreshold], ["in_stock", 3])

        // The buyer pays for 2 of the 5: 3 left reaches the line, and the seller gets one email.
        const before = emailsTo(seller.email).length
        await payForCheckout(context)
        await waitForNotifications()
        const alerts = emailsTo(seller.email).slice(before).filter((email) => /Running low|Sold out/.test(email.subject))
        assert.equal(alerts.length, 1)
        assert.equal(alerts[0]!.subject, `Running low: ${listing.title}`)
        assert.match(alerts[0]!.text, new RegExp(`${listing.title}: 3 left`))
        assert.match(alerts[0]!.text, /\/seller\/myListing/)
        assert.equal((await mineListing(listing.id)).stockStatus, "low")

        // The alert comes from the sale that crosses the line: once per drop, again after a restock.
        const sell = async (id: number, stockAfter: number, quantity: number) => {
            await prisma.listing.update({ where: { id }, data: { stockQuantity: stockAfter } })
            return prisma.$transaction((tx) => findStockAlerts(tx, new Map([[id, quantity]])))
        }
        assert.deepEqual(await sell(listing.id, 2, 1), [])
        assert.deepEqual((await sell(listing.id, 0, 2)).map((alert) => [alert.kind, alert.left]), [["sold_out", 0]])
        assert.equal((await mineListing(listing.id)).stockStatus, "sold_out")
        assert.deepEqual((await sell(listing.id, 3, 7)).map((alert) => [alert.kind, alert.left]), [["low", 3]])
        // Selling out in one go only sends the sold-out alert.
        assert.deepEqual((await sell(listing.id, 0, 10)).map((alert) => alert.kind), ["sold_out"])

        // The shop's number can be changed (0 turns alerts off); bad values are refused.
        const patchShop = (body: unknown) => request("PATCH" as "GET", "/seller/profile", body, fixture.sellerToken)
        for (const bad of [-1, 1.5, "3", null, 1001]) {
            const refused = await patchShop({ lowStockThreshold: bad })
            assert.equal(refused.status, 400, String(bad))
            assert.equal(refused.body.message, "Low-stock alert must be a whole number from 0 to 1000")
        }
        assert.equal((await patchShop({ lowStockThreshold: 0 })).body.lowStockThreshold, 0)
        assert.deepEqual(await sell(listing.id, 1, 9), [])

        // A product's own number wins over the shop's; null goes back to the shop's.
        const patchListing = (id: number, body: unknown) => request("PATCH" as "GET", `/listings/${id}`, body, fixture.sellerToken)
        assert.equal((await patchListing(listing.id, { lowStockThreshold: 2000 })).status, 400)
        assert.equal((await patchListing(listing.id, { lowStockThreshold: 10 })).status, 200)
        assert.deepEqual((await sell(listing.id, 8, 4)).map((alert) => [alert.kind, alert.left]), [["low", 8]])
        assert.deepEqual([(await mineListing(listing.id)).lowStockThreshold, (await mineListing(listing.id)).effectiveLowStockThreshold], [10, 10])
        assert.equal((await patchListing(listing.id, { lowStockThreshold: null })).status, 200)
        assert.equal((await mineListing(listing.id)).effectiveLowStockThreshold, 0)

        // Options: each is tracked on its own. An option uses its own number, else its product's, else the shop's.
        await patchShop({ lowStockThreshold: 3 })
        const product = (await request("POST", "/listings", {
            title: "Stock hoodie", description: "Soft", price: 1500, category: "Electronics",
            imageUrls: ["https://img.example.test/stock-hoodie.jpg"],
            options: [{ label: "Blue", price: 1500, stockQuantity: 2 }, { label: "Red", price: 1500, stockQuantity: 9 }]
        }, fixture.sellerToken)).body
        const [blue, red] = product.options.map((option: { listingId: number }) => option.listingId) as [number, number]
        const hoodie = await mineListing(product.id)
        assert.equal(hoodie.stockStatus, "low")
        assert.deepEqual(hoodie.lowStockOptions.map((option) => [option.listingId, option.stockStatus]), [[blue, "low"]])
        // The product's number applies to its options; an option's own number wins.
        assert.equal((await patchListing(product.id, { lowStockThreshold: 10 })).status, 200)
        assert.deepEqual((await mineListing(product.id)).lowStockOptions.map((option) => [option.listingId, option.effectiveLowStockThreshold]), [[blue, 10], [red, 10]])
        assert.equal((await patchListing(red, { lowStockThreshold: 4 })).status, 200)
        assert.deepEqual((await mineListing(product.id)).lowStockOptions.map((option) => option.listingId), [blue])
        assert.deepEqual((await sell(red, 4, 5)).map((alert) => [alert.listingId, alert.kind]), [[red, "low"]])
        assert.equal((await sell(blue, 0, 2))[0]!.title, "Stock hoodie — Blue")
        const soldOutBlue = await mineListing(product.id)
        assert.deepEqual([soldOutBlue.stockStatus, soldOutBlue.lowStockOptions.map((option) => option.stockStatus)], ["low", ["sold_out", "low"]])
    })
})

// ---- "Ask about this product" ----

test("a product page offers a WhatsApp chat with the shop that already names the product, only when the shop has WhatsApp on", async () => {
    await withPaymentCheckout("product-enquiry", async (context) => {
        const { fixture, request } = context
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
        const page = async (id: number) => (await request("GET", `/listings/${id}`)).body
        const messageOf = (url: string) => decodeURIComponent(new URL(url).searchParams.get("text") ?? "")

        // No WhatsApp number, no link.
        assert.equal((await page(listing.id)).whatsappEnquiry, null)

        assert.equal((await request("PATCH" as "GET", "/seller/profile", { whatsappNumber: "0803 123 4567" }, fixture.sellerToken)).status, 200)
        const plain = await page(listing.id)
        assert.equal(plain.whatsappEnquiry.number, "+2348031234567")
        assert.ok(plain.whatsappEnquiry.url.startsWith("https://wa.me/2348031234567?text="))
        assert.equal(messageOf(plain.whatsappEnquiry.url), plain.whatsappEnquiry.message)
        assert.equal(plain.whatsappEnquiry.message, `Hi ${profile.businessName}, I'm interested in "${listing.title}" (₦${listing.price.toLocaleString("en-NG")}) on StoreHatch: ${plain.shareUrl}`)
        // The seller's own low-stock setting is not shown to shoppers.
        assert.equal("lowStockThreshold" in plain, false)

        // A product whose options cost different amounts says "from"; opened from one option, it names that option.
        const product = (await request("POST", "/listings", {
            title: "Enquiry hoodie", description: "Soft", price: 5000, category: "Electronics",
            imageUrls: ["https://img.example.test/enquiry-hoodie.jpg"],
            options: [{ label: "Blue", price: 5000, stockQuantity: 2 }, { label: "Red", price: 7000, stockQuantity: 2 }]
        }, fixture.sellerToken)).body
        assert.match((await page(product.id)).whatsappEnquiry.message, /"Enquiry hoodie" \(from ₦5,000\)/)
        const red = await page(product.options[1].listingId)
        assert.match(red.whatsappEnquiry.message, /"Enquiry hoodie — Red" \(₦7,000\)/)
        assert.ok(red.whatsappEnquiry.message.endsWith(`/share/product/${product.id}`))

        // Turning WhatsApp off removes the link.
        await request("PATCH" as "GET", "/seller/profile", { whatsappNumber: "" }, fixture.sellerToken)
        assert.equal((await page(listing.id)).whatsappEnquiry, null)
    })
})

// ---- The seller's reviews page: rating summary and tab counts ----

test("the seller's reviews come with a rating summary for the open tab and the count on both tabs", async () => {
    await withPaymentCheckout("seller-review-summary", async (context) => {
        const { fixture, request, adminToken } = context
        const profile = await prisma.sellerProfile.findUniqueOrThrow({ where: { userId: fixture.sellerId } })
        const mine = async (type: "shop" | "product") => (await request("GET", `/seller/reviews?type=${type}`, undefined, fixture.sellerToken)).body
        const empty = { average: null, count: 0, distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }, withPhotos: 0 }

        // No reviews yet.
        for (const type of ["shop", "product"] as const) {
            const body = await mine(type)
            assert.deepEqual(body.summary, empty, type)
            assert.deepEqual(body.counts, { shop: 0, product: 0 }, type)
            assert.equal(body.total, 0)
        }

        // Reviews on two of the seller's products are summed up together.
        const orderId = await payForCheckout(context)
        const reviewers = await addOtherReviewers(context, orderId, [5, 4, 3])
        const listing = await prisma.listing.findUniqueOrThrow({ where: { id: fixture.listingId } })
        const second = await prisma.listing.create({
            data: { userId: fixture.sellerId, title: "Second summary product", description: listing.description, price: 900, stockQuantity: 4, category: listing.category, imageUrl: listing.imageUrl }
        })

        try {
            await prisma.productReview.create({ data: { listingId: second.id, buyerId: reviewers[0]!.id, orderId, rating: 1, photoUrls: ["https://img.example.test/review.jpg"] } })
            const products = await mine("product")
            assert.deepEqual(products.summary, { average: 3.3, count: 4, distribution: { "1": 1, "2": 0, "3": 1, "4": 1, "5": 1 }, withPhotos: 1 })
            assert.deepEqual(products.counts, { shop: 3, product: 4 })
            assert.equal(products.total, 4)
            assert.equal(products.reviews.length, 4)

            // A hidden review leaves the summary but stays in the list, the counts and the total.
            const five = await prisma.productReview.findFirstOrThrow({ where: { listingId: listing.id, rating: 5 } })
            assert.equal((await request("POST", `/admin/reviews/products/${five.id}/hide`, { reason: "Breaks the rules" }, adminToken)).status, 200)
            const afterHiding = await mine("product")
            assert.deepEqual([afterHiding.summary.count, afterHiding.summary.average, afterHiding.summary.distribution["5"]], [3, 2.7, 0])
            assert.deepEqual([afterHiding.counts.product, afterHiding.total, afterHiding.reviews.length], [4, 4, 4])

            // The shop's summary is the one shoppers see.
            const shopReview = await prisma.shopReview.findFirstOrThrow({ where: { sellerProfileId: profile.id, rating: 3 } })
            assert.equal((await request("POST", `/admin/reviews/shops/${shopReview.id}/hide`, { reason: "Breaks the rules" }, adminToken)).status, 200)
            const shop = await mine("shop")
            const publicSummary = (await request("GET", `/seller/shop/${profile.slug}/reviews`)).body.summary
            assert.deepEqual(shop.summary, publicSummary)
            assert.deepEqual([shop.summary.count, shop.summary.average], [2, 4.5])
            assert.deepEqual([shop.counts, shop.total], [{ shop: 3, product: 4 }, 3])
        } finally {
            await removeUsers(reviewers)
            await prisma.listing.delete({ where: { id: second.id } })
        }

        // The same errors as before.
        assert.equal((await request("GET", "/seller/reviews?type=both", undefined, fixture.sellerToken)).status, 400)
        assert.equal((await request("GET", "/seller/reviews?page=0", undefined, fixture.sellerToken)).status, 400)
        await withStrangerSeller(async (stranger) => {
            assert.equal((await request("GET", "/seller/reviews?type=shop", undefined, stranger)).status, 404)
        })
    })
})
