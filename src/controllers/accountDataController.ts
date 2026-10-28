import bcrypt from "bcrypt"
import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { collectAccountData } from "../lib/accountData.js"
import { deleteAccount, deletionBlockers } from "../lib/accountDeletion.js"
import { clearSessionCookies } from "../lib/sessions.js"

// "Download my data": everything StoreHatch holds about the signed-in person, as a JSON file.
export const downloadMyData = async (req: Request, res: Response) => {
    const data = await collectAccountData(req.user!.id)
    const day = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10)

    res.set("Cache-Control", "no-store")
        .attachment(`storehatch-my-data-${day}.json`)
        .type("application/json")
        .send(JSON.stringify(data, null, 2))
}

// Whether the account can be deleted now, and if not, what has to be finished first (for the settings page).
export const getDeletionCheck = async (req: Request, res: Response) => {
    const blockers = await deletionBlockers(req.user!.id)
    res.send({ canDelete: blockers.length === 0, blockers })
}

// Deletes the signed-in account after checking the password. Orders, payments and complaints are kept without the
// person's details (see lib/accountDeletion.ts).
export const deleteMyAccount = async (req: Request, res: Response) => {
    const userId = req.user!.id
    const { password } = req.body
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } })

    if (!user.passwordHash) {
        res.status(400).send({ message: "Set a password for your account first, then delete it", code: "PASSWORD_REQUIRED" })
        return
    }

    if (typeof password !== "string" || password.length === 0 || password.length > 200 || !(await bcrypt.compare(password, user.passwordHash))) {
        res.status(400).send({ message: "Your password is not right" })
        return
    }

    const blockers = await deletionBlockers(userId)

    if (blockers.length > 0) {
        res.status(409).send({ message: "Your account cannot be deleted yet. Finish these first", code: "ACCOUNT_HAS_OPEN_ITEMS", blockers })
        return
    }

    await deleteAccount(userId)
    clearSessionCookies(res)
    res.send({ message: "Your account has been deleted" })
}
