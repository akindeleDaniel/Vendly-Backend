import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { ratesView, readShippingRates } from "../lib/shippingRates.js"

async function loadSettings(userId: number) {
    return prisma.sellerProfile.findUnique({
        where: { userId },
        select: { id: true, shippingPolicy: true, shippingCost: true, deliversEverywhere: true, shippingRates: { select: { state: true, cost: true } } }
    })
}

function toView(profile: NonNullable<Awaited<ReturnType<typeof loadSettings>>>) {
    return {
        // The default fee (FREE, or FIXED with shippingCost) applies to every state not listed below.
        shippingPolicy: profile.shippingPolicy,
        shippingCost: profile.shippingCost === null ? null : profile.shippingCost.toFixed(2),
        // When false, only the listed states with a fee can order.
        deliversEverywhere: profile.deliversEverywhere,
        // A fee per state; cost null means "we do not deliver there".
        rates: ratesView(profile.shippingRates)
    }
}

export const getMyShippingRates = async (req: Request, res: Response) => {
    const profile = await loadSettings(req.user!.id)

    if (!profile) {
        res.status(404).send({ message: "Set up your store first" })
        return
    }

    res.send(toView(profile))
}

// Replaces all of the seller's state fees at once with the list sent.
export const setMyShippingRates = async (req: Request, res: Response) => {
    const profile = await loadSettings(req.user!.id)

    if (!profile) {
        res.status(404).send({ message: "Set up your store first" })
        return
    }

    const input = readShippingRates(req.body, profile.deliversEverywhere)

    if ("error" in input) {
        res.status(400).send({ message: input.error })
        return
    }

    await prisma.$transaction(async (tx) => {
        await tx.sellerShippingRate.deleteMany({ where: { sellerProfileId: profile.id } })

        if (input.rates.length > 0) {
            await tx.sellerShippingRate.createMany({
                data: input.rates.map((rate) => ({ sellerProfileId: profile.id, state: rate.state, cost: rate.cost }))
            })
        }

        await tx.sellerProfile.update({ where: { id: profile.id }, data: { deliversEverywhere: input.deliversEverywhere } })
    })

    res.send(toView((await loadSettings(req.user!.id))!))
}
