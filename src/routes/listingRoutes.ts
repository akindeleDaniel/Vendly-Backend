import { Router } from "express";
import { getAllListings } from "../controllers/listingController.js";

const router = Router()

router.get("/listings", getAllListings)

export default router