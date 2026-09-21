import { Router } from "express";
import { createSeller, getMySellerProfile, updateSeller } from "../controllers/sellerController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router()

router.post("/profile", authMiddleware, createSeller)
router.get("/profile", authMiddleware, getMySellerProfile)
router.patch("/profile", authMiddleware, updateSeller)

export default router