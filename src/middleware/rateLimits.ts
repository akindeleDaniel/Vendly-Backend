import type { Request, RequestHandler } from "express"
import { ipKeyGenerator, rateLimit } from "express-rate-limit"
import { normaliseEmail } from "../lib/accountRules.js"

// Counters live in this server's memory. That is right for one server; with several servers behind a load
// balancer they need a shared store (for example Redis), or each server would allow its own full quota.
let enabled = true

// Tests switch limiting off so thousands of requests from one address do not trip it, and on again for the tests of the limits.
export function setRateLimitingForTesting(value: boolean) {
    enabled = value
}

const minute = 60 * 1000
const tooManyRequests = { message: "Too many attempts. Please wait a few minutes and try again." }

function ipKey(req: Request): string {
    return ipKeyGenerator(req.ip ?? "unknown")
}

function limiter(windowMs: number, limit: number, key: (req: Request) => string = ipKey): RequestHandler {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: tooManyRequests,
        skip: () => !enabled,
        keyGenerator: key,
        // Our own wrong-proxy-setup warnings are handled at startup; do not also log on every request.
        validate: { xForwardedForHeader: false }
    })
}

// The address in the request body, so one account cannot be attacked from many IP addresses.
function emailKey(prefix: string) {
    return (req: Request) => `${prefix}:${normaliseEmail(req.body?.email) ?? ipKey(req)}`
}

// The logged-in user, so one account cannot flood the others. Must run after authMiddleware.
function userKey(prefix: string) {
    return (req: Request) => `${prefix}:${req.user?.id ?? ipKey(req)}`
}

// Everything, per address: a ceiling that no normal visitor reaches.
export const generalLimiter = limiter(15 * minute, 1000)

// Password and code checks: per address and per account.
export const loginByIpLimiter = limiter(15 * minute, 40)
export const loginByEmailLimiter = limiter(15 * minute, 10, emailKey("login"))

// Creating accounts and asking for emails (each one sends mail), per address and per account.
export const registrationLimiter = limiter(60 * minute, 10)
export const codeRequestByIpLimiter = limiter(60 * minute, 15)
export const codeRequestByEmailLimiter = limiter(60 * minute, 5, emailKey("code"))

export const refreshLimiter = limiter(15 * minute, 120)

// Changing the password or starting to: per user.
export const passwordChangeLimiter = limiter(60 * minute, 10, userKey("password"))

// Writing in a complaint thread, opening complaints and offering refunds: per user.
export const messageLimiter = limiter(10 * minute, 30, userKey("message"))
export const complaintLimiter = limiter(60 * minute, 10, userKey("complaint"))

// Starting a checkout or a payment: per user.
export const paymentStartLimiter = limiter(10 * minute, 30, userKey("payment"))
