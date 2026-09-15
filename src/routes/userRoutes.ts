import { Router } from "express";
import { checkAuth, createUser, loginUser } from "../controllers/userController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router()

router.post("/register", createUser)
router.post("/login", loginUser)
router.get("/check", authMiddleware, checkAuth)

export default router