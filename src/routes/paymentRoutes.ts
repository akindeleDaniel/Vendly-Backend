import { Router } from "express"
import { getPayment } from "../controllers/paymentController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireBuyer } from "../middleware/requireRole.js"

const router = Router()

router.get("/:reference", authMiddleware, requireBuyer, getPayment)

export default router
