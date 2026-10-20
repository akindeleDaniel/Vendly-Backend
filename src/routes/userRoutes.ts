import { Router } from "express";
import { checkAuth, createUser, loginUser, logout, logoutEverywhere, refresh } from "../controllers/userController.js";
import { changePassword, forgotPassword, resendCode, resetPassword, sendSetPasswordCode, setPassword, verifyEmail, verifyLogin } from "../controllers/accountController.js";
import { googleLink, googleSignIn } from "../controllers/googleController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router()

router.post("/register", createUser)
router.post("/login", loginUser)
router.post("/login/verify", verifyLogin)
router.post("/verify-email", verifyEmail)
router.post("/resend-code", resendCode)
router.post("/forgot-password", forgotPassword)
router.post("/reset-password", resetPassword)
router.post("/change-password", authMiddleware, changePassword)
router.post("/set-password/send-code", authMiddleware, sendSetPasswordCode)
router.post("/set-password", authMiddleware, setPassword)
router.post("/google", googleSignIn)
router.post("/google/link", googleLink)
router.post("/logout", logout)
router.post("/logout-all", authMiddleware, logoutEverywhere)
router.post("/refresh", refresh)
router.get("/check", authMiddleware, checkAuth)

export default router