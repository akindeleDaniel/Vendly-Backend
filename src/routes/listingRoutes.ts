import { Router } from "express";
import { getAllListings, getListingById, createListing, updateListing, deleteListing, getMyListings } from "../controllers/listingController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router()

router.get("/", getAllListings)
router.get("/Mylisting", authMiddleware, getMyListings)
router.get("/:id", getListingById)
router.post("/", authMiddleware, createListing)
router.patch("/:id", authMiddleware, updateListing)
router.delete("/:id", authMiddleware, deleteListing)

export default router