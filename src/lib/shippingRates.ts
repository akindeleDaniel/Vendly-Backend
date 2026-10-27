import { states } from "nigerian-states-and-lgas"
import { Prisma } from "../generated/prisma/client.js"

// Delivery fees by the buyer's state. A seller has a default (free, or one fixed fee) and may set a different fee
// for some states, or say they do not deliver to a state. They can also deliver only to the states they list.

const maximumShippingCost = new Prisma.Decimal("9999999999.99")

export type RateInput = { state: string; cost: Prisma.Decimal | null }
export type ShippingRatesInput = { deliversEverywhere: boolean; rates: RateInput[] }

export type SellerShippingSettings = {
    shippingPolicy: "FREE" | "FIXED"
    shippingCost: Prisma.Decimal | null
    deliversEverywhere: boolean
    shippingRates: Array<{ state: string; cost: Prisma.Decimal | null }>
}

export function isNigerianState(value: unknown): value is string {
    return typeof value === "string" && states().includes(value)
}

// The request body for replacing a seller's state fees: { deliversEverywhere?, rates: [{ state, cost }] }, where
// cost is a naira amount (0 or more) or null for "no delivery to this state".
export function readShippingRates(body: unknown, currentDeliversEverywhere: boolean): ShippingRatesInput | { error: string } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { error: "Send the delivery fees as { rates: [...] }" }
    }

    const fields = body as Record<string, unknown>

    if (fields.deliversEverywhere !== undefined && typeof fields.deliversEverywhere !== "boolean") {
        return { error: "deliversEverywhere must be true or false" }
    }

    if (!Array.isArray(fields.rates)) {
        return { error: "rates must be a list" }
    }

    if (fields.rates.length > states().length) {
        return { error: "There are only 37 states to set a fee for" }
    }

    const seen = new Set<string>()
    const rates: RateInput[] = []

    for (const raw of fields.rates) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            return { error: "Each fee must be { state, cost }" }
        }

        const { state, cost } = raw as Record<string, unknown>

        if (!isNigerianState(state)) {
            return { error: `"${String(state)}" is not a Nigerian state` }
        }

        if (seen.has(state)) {
            return { error: `${state} is listed twice` }
        }

        seen.add(state)

        if (cost === null) {
            rates.push({ state, cost: null })
            continue
        }

        if ((typeof cost !== "number" && typeof cost !== "string") || (typeof cost === "string" && !/^\d+(\.\d{1,2})?$/.test(cost.trim()))) {
            return { error: `The fee for ${state} must be an amount in naira, or null for no delivery` }
        }

        let amount: Prisma.Decimal

        try {
            amount = new Prisma.Decimal(typeof cost === "string" ? cost.trim() : cost)
        } catch {
            return { error: `The fee for ${state} must be an amount in naira, or null for no delivery` }
        }

        if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 2 || amount.greaterThan(maximumShippingCost)) {
            return { error: `The fee for ${state} must be an amount in naira, or null for no delivery` }
        }

        rates.push({ state, cost: amount.toDecimalPlaces(2) })
    }

    const deliversEverywhere = typeof fields.deliversEverywhere === "boolean" ? fields.deliversEverywhere : currentDeliversEverywhere

    if (!deliversEverywhere && !rates.some((rate) => rate.cost !== null)) {
        return { error: "If you only deliver to some states, give a fee for at least one of them" }
    }

    return { deliversEverywhere, rates }
}

function defaultFee(settings: SellerShippingSettings): Prisma.Decimal | null {
    if (settings.shippingPolicy === "FREE") {
        return new Prisma.Decimal(0)
    }

    return settings.shippingCost !== null && settings.shippingCost.greaterThanOrEqualTo(0) ? settings.shippingCost.toDecimalPlaces(2) : null
}

// The fee for delivering to one state, "unavailable" when the seller does not deliver there, or "unknown" when the
// seller's fees are incomplete. Without a state (the buyer has not chosen one yet) it is the default fee, and
// `varies` says whether the final fee may be different once the state is known.
export function shippingFor(settings: SellerShippingSettings, state: string | null):
    | { kind: "fee"; cost: Prisma.Decimal; varies: boolean }
    | { kind: "unavailable" }
    | { kind: "unknown" } {
    const varies = settings.shippingRates.length > 0 || !settings.deliversEverywhere

    if (state === null) {
        // A seller who only delivers to listed states has no default; the cheapest listed fee stands in.
        const fee = settings.deliversEverywhere ? defaultFee(settings) ?? lowestListedFee(settings) : lowestListedFee(settings)
        return fee === null ? { kind: "unknown" } : { kind: "fee", cost: fee, varies }
    }

    const rate = settings.shippingRates.find((candidate) => candidate.state === state)

    if (rate) {
        return rate.cost === null ? { kind: "unavailable" } : { kind: "fee", cost: rate.cost.toDecimalPlaces(2), varies: false }
    }

    if (!settings.deliversEverywhere) {
        return { kind: "unavailable" }
    }

    const fee = defaultFee(settings)
    return fee === null ? { kind: "unknown" } : { kind: "fee", cost: fee, varies: false }
}

// For a seller who only delivers to listed states, the cheapest of those fees stands in until the buyer's state is known.
function lowestListedFee(settings: SellerShippingSettings): Prisma.Decimal | null {
    const fees = settings.shippingRates.filter((rate) => rate.cost !== null).map((rate) => rate.cost as Prisma.Decimal)
    return fees.length === 0 ? null : fees.reduce((lowest, fee) => (fee.lessThan(lowest) ? fee : lowest)).toDecimalPlaces(2)
}

export function ratesView(rates: Array<{ state: string; cost: Prisma.Decimal | null }>) {
    return [...rates]
        .sort((left, right) => left.state.localeCompare(right.state))
        .map((rate) => ({ state: rate.state, cost: rate.cost === null ? null : rate.cost.toFixed(2) }))
}
