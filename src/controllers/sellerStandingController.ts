import type { Request, Response } from "express"
import { maximumMessageLength, minimumMessageLength, parseMessageBody } from "../lib/disputes.js"
import { logAdminAction } from "../lib/adminTeam.js"
import { blockSeller, getSellerStanding, SellerStandingError, unblockSeller } from "../lib/sellerStanding.js"

function parseUserId(value: unknown): number | null {
    return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2_147_483_647 ? Number(value) : null
}

function sendStandingError(error: unknown, res: Response): boolean {
    if (error instanceof SellerStandingError) {
        res.status(error.status).send({ message: error.message })
        return true
    }

    return false
}

// What the seller sees about their own standing: lost complaints in the last 90 days, a warning, or a block.
export const getMyStanding = async (req: Request, res: Response) => {
    try {
        res.send({ standing: await getSellerStanding(req.user!.id) })
    } catch (error) {
        if (!sendStandingError(error, res)) {
            throw error
        }
    }
}

export const getAdminSellerStanding = async (req: Request, res: Response) => {
    const sellerId = parseUserId(req.params.userId)

    try {
        if (sellerId === null) {
            throw new SellerStandingError(404, "Seller not found")
        }

        res.send({ standing: await getSellerStanding(sellerId) })
    } catch (error) {
        if (!sendStandingError(error, res)) {
            throw error
        }
    }
}

// An administrator blocks or unblocks a shop by hand. Blocking needs a note so there is always a reason on record.
export const setSellerBlocked = (blocked: boolean) => async (req: Request, res: Response) => {
    const sellerId = parseUserId(req.params.userId)
    const note = parseMessageBody(req.body?.note)

    if (blocked && note === null) {
        res.status(400).send({ message: `A note of ${minimumMessageLength} to ${maximumMessageLength} characters is required` })
        return
    }

    try {
        if (sellerId === null) {
            throw new SellerStandingError(404, "Seller not found")
        }

        if (blocked) {
            await blockSeller(sellerId, note!)
        } else {
            await unblockSeller(sellerId)
        }

        await logAdminAction(req.user!.id, blocked ? "SELLER_BLOCKED" : "SELLER_UNBLOCKED", sellerId, blocked ? note! : undefined)

        res.send({ standing: await getSellerStanding(sellerId) })
    } catch (error) {
        if (!sendStandingError(error, res)) {
            throw error
        }
    }
}
