import { Router } from "express";
import { checkAuth, createUser, loginUser, logout, logoutEverywhere, refresh } from "../controllers/userController.js";
import { changePassword, forgotPassword, resendCode, resetPassword, sendSetPasswordCode, setPassword, verifyEmail, verifyLogin } from "../controllers/accountController.js";
import { googleLink, googleSignIn } from "../controllers/googleController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
    codeRequestByEmailLimiter,
    codeRequestByIpLimiter,
    loginByEmailLimiter,
    loginByIpLimiter,
    passwordChangeLimiter,
    refreshLimiter,
    registrationLimiter
} from "../middleware/rateLimits.js";

const router = Router()

// Anything that checks a password or a code is limited per address and per account; anything that sends an email is limited harder.
const passwordAttemptLimits = [loginByIpLimiter, loginByEmailLimiter]
const emailRequestLimits = [codeRequestByIpLimiter, codeRequestByEmailLimiter]

router.post("/register", registrationLimiter, createUser)
router.post("/login", ...passwordAttemptLimits, loginUser)
router.post("/login/verify", ...passwordAttemptLimits, verifyLogin)
router.post("/verify-email", ...passwordAttemptLimits, verifyEmail)
router.post("/resend-code", ...emailRequestLimits, resendCode)
router.post("/forgot-password", ...emailRequestLimits, forgotPassword)
router.post("/reset-password", ...passwordAttemptLimits, resetPassword)
router.post("/change-password", authMiddleware, passwordChangeLimiter, changePassword)
router.post("/set-password/send-code", authMiddleware, passwordChangeLimiter, sendSetPasswordCode)
router.post("/set-password", authMiddleware, passwordChangeLimiter, setPassword)
router.post("/google", loginByIpLimiter, googleSignIn)
router.post("/google/link", loginByIpLimiter, googleLink)
router.post("/logout", logout)
router.post("/logout-all", authMiddleware, logoutEverywhere)
router.post("/refresh", refreshLimiter, refresh)
router.get("/check", authMiddleware, checkAuth)

export default router