import assert from "node:assert/strict"
import { createHmac, randomUUID } from "node:crypto"
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
            await prisma.listing.delete({ where: { id: listing.id } })
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

        const response = await fetch(`${baseUrl}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: { not: "a string" }, password: "integration-test-not-a-password" })
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
        cookieSameSite: "lax",
        cookieSecure: false
    })
    assert.equal(loadConfig({ NODE_ENV: "production" }).cookieSecure, true)
})

test("reads valid deployment settings from the environment", () => {
    assert.deepEqual(loadConfig({
        PORT: " 8080 ",
        FRONTEND_URL: "https://vendly.example/",
        COOKIE_SAME_SITE: "Strict"
    }), {
        port: 8080,
        frontendUrl: "https://vendly.example",
        cookieSameSite: "strict",
        cookieSecure: false
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
            role: "CONSUMER"
        }
    })

    try {
        await withAppServer(async (baseUrl) => {
            const login = await fetch(`${baseUrl}/users/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password })
            })
            assert.equal(login.status, 200)
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

        const sellerToken = await request("POST", `/checkout/${checkoutId}/payments`, { provider: "PAYSTACK" }, fixture.sellerToken)
        assert.equal(sellerToken.status, 403)
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
        assert.equal((await request("GET", "/orders", undefined, fixture.sellerToken)).status, 403)
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

        assert.equal((await request("POST", confirmPath, undefined, fixture.sellerToken)).status, 403)
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

test("a signed refund webhook makes Vendly check the provider, and a failure asks for redelivery", async (t) => {
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

        // Paystack reports Vendly's share as one lump, after Vendly's part of the fee.
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
        // Flutterwave reports no fee, so it is what is left after the seller's payout and Vendly's part.
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
    const created = await paystackAdapter.createRefund({ transactionReference: "VND-9-abc", transactionId: "555", amountKobo: 150000, customerNote: "Sorry", merchantNote: "Vendly refund RFD-1" })
    assert.deepEqual(requests.at(-1), {
        url: "https://api.paystack.co/refund",
        method: "POST",
        body: { transaction: "VND-9-abc", amount: 150000, currency: "NGN", customer_note: "Sorry", merchant_note: "Vendly refund RFD-1" }
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

    // Paystack: a retained share is whatever the sellers' shares leave over, and Vendly's share is read back.
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
    const flwRefund = await flutterwaveAdapter.createRefund({ transactionReference: "VND-9-abc", transactionId: "908790", amountKobo: 150000, customerNote: null, merchantNote: "Vendly refund RFD-2" })
    assert.deepEqual(requests.at(-1), {
        url: "https://api.flutterwave.com/v3/transactions/908790/refund",
        method: "POST",
        body: { amount: 1500, comments: "Vendly refund RFD-2" }
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
        assert.deepEqual(buyerOrder.body.sellerOrders[0].dispute, { id: dispute.id, status: "OPEN", outcome: null, reason: "DAMAGED" })
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
        assert.equal((await request("GET", `/disputes/${dispute.id}`, undefined, fixture.sellerToken)).status, 403)
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
        assert.equal((await post(`/disputes/${id}/messages`, fixture.sellerToken)).status, 403)
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
        data: { name: "Session user", email, passwordHash: await bcrypt.hash(password, 4), role: "CONSUMER" }
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

async function loginForSession(context: SessionContext) {
    const response = await fetch(`${context.baseUrl}/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: context.email, password: context.password })
    })
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

test("registering also starts a session", async () => {
    await withSessionUser(async (context) => {
        const email = `registered-${randomUUID()}@example.test`
        const response = await fetch(`${context.baseUrl}/users/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "New person", email, password: "a-long-test-password", role: "CONSUMER" })
        })

        try {
            assert.equal(response.status, 200)
            const cookies = cookiesFrom(response)
            assert.ok(cookies.token?.value)
            assert.ok(cookies.refreshToken?.value)
        } finally {
            await prisma.cart.deleteMany({ where: { user: { email } } })
            await prisma.user.deleteMany({ where: { email } })
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
