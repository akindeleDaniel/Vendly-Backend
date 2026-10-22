import { Router } from "express"
import { getAllListings, getListingById, createListing, updateListing, deleteListing, getMyListings, archiveListing, unarchiveListing, setListingOptions } from "../controllers/listingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { listListingReviews } from "../controllers/reviewController.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.get("/", getAllListings)
router.get("/Mylisting", authMiddleware, requireRole("SELLER"), getMyListings)
router.get("/:id", getListingById)
router.get("/:id/reviews", listListingReviews)
router.post("/", authMiddleware, requireRole("SELLER"), createListing)
router.patch("/:id", authMiddleware, requireRole("SELLER"), updateListing)
router.put("/:id/options", authMiddleware, requireRole("SELLER"), setListingOptions)
router.delete("/:id", authMiddleware, requireRole("SELLER"), deleteListing)
router.post("/:id/archive", authMiddleware, requireRole("SELLER"), archiveListing)
router.post("/:id/unarchive", authMiddleware, requireRole("SELLER"), unarchiveListing)

export default router