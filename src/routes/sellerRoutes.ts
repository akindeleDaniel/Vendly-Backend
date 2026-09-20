import { Router } from "express";
import { createSeller } from "../controllers/sellerController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router()

router.post("/profile", authMiddleware, createSeller)

export default router