import { Router } from "express";
import { checkAuth, createUser, loginUser, logout } from "../controllers/userController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router()

router.post("/register", createUser)
router.post("/login", loginUser)
router.post("/logout", logout)
router.get("/check", authMiddleware, checkAuth)

export default router