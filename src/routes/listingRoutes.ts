import { Router } from "express";
import { getAllListings, getListingById, createListing, updateListing, deleteListing } from "../controllers/listingController.js";

const router = Router()

router.get("/", getAllListings)
router.get("/:id", getListingById)
router.post("/", createListing)
router.patch("/:id", updateListing)
router.delete("/:id", deleteListing)

export default router