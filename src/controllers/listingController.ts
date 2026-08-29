import type { Request, Response } from "express";

export const getAllListings = (req:Request, res:Response) =>{
    res.send("This will be the listing endpoint")
}