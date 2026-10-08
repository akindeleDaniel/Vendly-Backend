import { Router } from "express"
import { getCheckoutPreview } from "../controllers/checkoutController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.get("/preview", authMiddleware, requireRole("CONSUMER"), getCheckoutPreview)

export default router
