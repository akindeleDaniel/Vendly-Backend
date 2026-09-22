import { Router } from "express"
import { createSeller, getMySellerProfile, updateSeller, getPublicShop } from "../controllers/sellerController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.post("/profile", authMiddleware, requireRole("SELLER"), createSeller)
router.get("/profile", authMiddleware, requireRole("SELLER"), getMySellerProfile)
router.patch("/profile", authMiddleware, requireRole("SELLER"), updateSeller)
router.get("/shop/:slug", getPublicShop)

export default router