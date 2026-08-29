import type { Request, Response } from "express";

export const getAllListings = (req:Request, res:Response) =>{
    res.send("This will be the listing endpoint")
}

export const getListingById  = (req:Request, res:Response) =>{
    const id = req.params.id
    res.send(`This will return listing number ${id}`)
}