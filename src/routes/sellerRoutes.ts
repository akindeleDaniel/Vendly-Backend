import { Router } from "express"
import { createSeller, getMySellerProfile, updateSeller, getPublicShop, getCategoryShops } from "../controllers/sellerController.js"
import { acceptPayoutTerms, changePayoutBankAccount, createPayoutAccounts, getMyLiabilities, getPayoutAccounts, getPayoutBanks, resolvePayoutAccount } from "../controllers/payoutController.js"
import { getSellerOrder, listSellerOrders, reportSellerOrderDelivered, shipSellerOrder } from "../controllers/orderController.js"
import {
    countSellerDisputesAwaitingResponse,
    countSellerUnreadDisputes,
    getSellerDispute,
    listSellerDisputes,
    offerRefund,
    postSellerMessage,
    respondToMyDispute,
    withdrawSellerOffer
} from "../controllers/disputeController.js"
import { getMyEarnings, getMySalesSummary } from "../controllers/sellerEarningsController.js"
import { getMyStanding } from "../controllers/sellerStandingController.js"
import { getMyShippingRates, setMyShippingRates } from "../controllers/shippingRatesController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { approvePreOrder, countPreOrdersAwaitingAnswer, declinePreOrder, getSellerPreOrder, listSellerPreOrders } from "../controllers/preOrderController.js"
import { listMyReviews, listShopReviews, reportReview } from "../controllers/reviewController.js"
import { complaintLimiter, messageLimiter } from "../middleware/rateLimits.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.post("/profile", authMiddleware, requireRole("SELLER"), createSeller)
router.get("/profile", authMiddleware, requireRole("SELLER"), getMySellerProfile)
router.patch("/profile", authMiddleware, requireRole("SELLER"), updateSeller)
router.get("/payout/banks", authMiddleware, requireRole("SELLER"), getPayoutBanks)
router.post("/payout/resolve", authMiddleware, requireRole("SELLER"), resolvePayoutAccount)
router.get("/payout/accounts", authMiddleware, requireRole("SELLER"), getPayoutAccounts)
router.post("/payout/accounts", authMiddleware, requireRole("SELLER"), createPayoutAccounts)
router.put("/payout/accounts", authMiddleware, requireRole("SELLER"), changePayoutBankAccount)
router.post("/payout/terms", authMiddleware, requireRole("SELLER"), acceptPayoutTerms)
router.get("/liabilities", authMiddleware, requireRole("SELLER"), getMyLiabilities)
router.get("/earnings", authMiddleware, requireRole("SELLER"), getMyEarnings)
router.get("/summary", authMiddleware, requireRole("SELLER"), getMySalesSummary)
router.get("/standing", authMiddleware, requireRole("SELLER"), getMyStanding)
router.get("/shipping-rates", authMiddleware, requireRole("SELLER"), getMyShippingRates)
router.put("/shipping-rates", authMiddleware, requireRole("SELLER"), setMyShippingRates)
router.get("/orders", authMiddleware, requireRole("SELLER"), listSellerOrders)
router.get("/orders/:id", authMiddleware, requireRole("SELLER"), getSellerOrder)
router.post("/orders/:id/ship", authMiddleware, requireRole("SELLER"), shipSellerOrder)
router.post("/orders/:id/delivered", authMiddleware, requireRole("SELLER"), reportSellerOrderDelivered)
router.post("/orders/:id/refund-offer", authMiddleware, requireRole("SELLER"), complaintLimiter, offerRefund)
router.get("/disputes", authMiddleware, requireRole("SELLER"), listSellerDisputes)
// Must come before "/disputes/:id", which would otherwise treat "awaiting-response" as a complaint ID.
router.get("/disputes/awaiting-response", authMiddleware, requireRole("SELLER"), countSellerDisputesAwaitingResponse)
router.get("/disputes/unread", authMiddleware, requireRole("SELLER"), countSellerUnreadDisputes)
router.get("/disputes/:id", authMiddleware, requireRole("SELLER"), getSellerDispute)
router.post("/disputes/:id/respond", authMiddleware, requireRole("SELLER"), respondToMyDispute)
router.post("/disputes/:id/messages", authMiddleware, requireRole("SELLER"), messageLimiter, postSellerMessage)
router.post("/disputes/:id/withdraw", authMiddleware, requireRole("SELLER"), withdrawSellerOffer)
router.get("/pre-orders", authMiddleware, requireRole("SELLER"), listSellerPreOrders)
// Must come before "/pre-orders/:id", which would otherwise treat "awaiting-answer" as a request id.
router.get("/pre-orders/awaiting-answer", authMiddleware, requireRole("SELLER"), countPreOrdersAwaitingAnswer)
router.get("/pre-orders/:id", authMiddleware, requireRole("SELLER"), getSellerPreOrder)
router.post("/pre-orders/:id/approve", authMiddleware, requireRole("SELLER"), approvePreOrder)
router.post("/pre-orders/:id/decline", authMiddleware, requireRole("SELLER"), declinePreOrder)
router.get("/shops", getCategoryShops)
router.get("/shop/:slug", getPublicShop)
router.get("/shop/:slug/reviews", listShopReviews)
router.get("/reviews", authMiddleware, requireRole("SELLER"), listMyReviews)
router.post("/reviews/:kind/:reviewId/report", authMiddleware, requireRole("SELLER"), reportReview)

export default router