import { Router } from "express"
import { createSeller, getMySellerProfile, updateSeller, getPublicShop, getCategoryShops } from "../controllers/sellerController.js"
import { changePayoutBankAccount, createPayoutAccounts, getPayoutAccounts, getPayoutBanks, resolvePayoutAccount } from "../controllers/payoutController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.post("/profile", authMiddleware, requireRole("SELLER"), createSeller)
router.get("/profile", authMiddleware, requireRole("SELLER"), getMySellerProfile)
router.patch("/profile", authMiddleware, requireRole("SELLER"), updateSeller)
router.get("/payout/banks", authMiddleware, requireRole("SELLER"), getPayoutBanks)
router.post("/payout/resolve", authMiddleware, requireRole("SELLER"), resolvePayoutAccount)
router.get("/payout/accounts", authMiddleware, requireRole("SELLER"), getPayoutAccounts)
router.post("/payout/accounts", authMiddleware, requireRole("SELLER"), createPayoutAccounts)
router.put("/payout/accounts", authMiddleware, requireRole("SELLER"), changePayoutBankAccount)
router.get("/shops", getCategoryShops)
router.get("/shop/:slug", getPublicShop)

export default router