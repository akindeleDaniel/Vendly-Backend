import { Router } from "express";
import { checkAuth, createUser, loginUser, logout, logoutEverywhere, refresh } from "../controllers/userController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router()

router.post("/register", createUser)
router.post("/login", loginUser)
router.post("/logout", logout)
router.post("/logout-all", authMiddleware, logoutEverywhere)
router.post("/refresh", refresh)
router.get("/check", authMiddleware, checkAuth)

export default router