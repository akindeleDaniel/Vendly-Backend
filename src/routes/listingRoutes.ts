import { Router } from "express"
import { getAllListings, getListingById, createListing, updateListing, deleteListing, getMyListings } from "../controllers/listingController.js"
import { authMiddleware } from "../middleware/authMiddleware.js"
import { requireRole } from "../middleware/requireRole.js"

const router = Router()

router.get("/", getAllListings)
router.get("/Mylisting", authMiddleware, requireRole("SELLER"), getMyListings)
router.get("/:id", getListingById)
router.post("/", authMiddleware, requireRole("SELLER"), createListing)
router.patch("/:id", authMiddleware, requireRole("SELLER"), updateListing)
router.delete("/:id", authMiddleware, requireRole("SELLER"), deleteListing)

export default router