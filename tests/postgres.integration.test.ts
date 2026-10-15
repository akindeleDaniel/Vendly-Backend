import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import { after, before, test } from "node:test"
import cookieParser from "cookie-parser"
import express from "express"
import jwt from "jsonwebtoken"
import { Prisma, PrismaClient } from "../src/generated/prisma/client.js"
import { connectTestDatabase } from "../scripts/testDatabase.js"
import checkoutRoutes from "../src/routes/checkoutRoutes.js"
import cartRoutes from "../src/routes/cartRoutes.js"
import listingRoutes from "../src/routes/listingRoutes.js"

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
                await prisma.orderItem.deleteMany({ where: { order: { checkoutId: { in: checkoutIds } } } })
                await prisma.order.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.checkoutItem.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
                await prisma.inventoryReservation.deleteMany({ where: { checkoutId: { in: checkoutIds } } })
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
    table: "Checkout" | "OrderItem"
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
                    provider: "PAYSTACK",
                    providerRef: `checkout-protected-failed-${randomUUID()}`,
                    amount: new Prisma.Decimal("3000.00"),
                    status: "FAILED"
                },
                {
                    checkoutId,
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
