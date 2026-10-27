import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import config from "../config.js"
import { loadChoices, withOptionSummary } from "../lib/listingOptions.js"
import { renderSharePage, shorten, escapeHtml } from "../lib/sharePages.js"

const naira = (amount: number) => `₦${amount.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`

function sendPage(res: Response, status: number, html: string) {
    res.status(status).set("Cache-Control", "public, max-age=300").type("html").send(html)
}

// Something that cannot be shared (missing, taken off sale, or a blocked shop) still gives a tidy preview and sends
// people to the home page.
function sendMissing(res: Response, shareUrl: string) {
    sendPage(res, 404, renderSharePage({
        title: "StoreHatch",
        description: "Shops with safe checkout and buyer protection.",
        imageUrl: null,
        shareUrl,
        targetUrl: `${config.frontendUrl}/`,
        type: "website"
    }))
}

export function shopShareUrl(slug: string): string {
    return `${config.publicApiUrl}/share/shop/${encodeURIComponent(slug)}`
}

export function productShareUrl(id: number): string {
    return `${config.publicApiUrl}/share/product/${id}`
}

export const shareShop = async (req: Request, res: Response) => {
    const slug = String(req.params.slug)
    const shareUrl = shopShareUrl(slug)
    const shop = await prisma.sellerProfile.findUnique({
        where: { slug },
        select: { businessName: true, slug: true, logoUrl: true, bannerUrl: true, about: true, state: true, blockedAt: true }
    })

    if (!shop || shop.blockedAt) {
        sendMissing(res, shareUrl)
        return
    }

    sendPage(res, 200, renderSharePage({
        title: `${shop.businessName} on StoreHatch`,
        description: shop.about
            ? shorten(shop.about, 160)
            : `Shop ${shop.businessName} online (${shop.state}). Safe checkout and buyer protection on StoreHatch.`,
        imageUrl: shop.bannerUrl ?? shop.logoUrl,
        shareUrl,
        targetUrl: `${config.frontendUrl}/shop/${encodeURIComponent(shop.slug)}`,
        type: "website"
    }))
}

export const shareProduct = async (req: Request, res: Response) => {
    const raw = String(req.params.id)
    const id = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null
    const shareUrl = `${config.publicApiUrl}/share/product/${encodeURIComponent(raw)}`

    if (id === null) {
        sendMissing(res, shareUrl)
        return
    }

    const select = {
        id: true, title: true, description: true, price: true, stockQuantity: true, imageUrl: true, archivedAt: true, parentId: true,
        user: { select: { sellerProfile: { select: { businessName: true, blockedAt: true } } } }
    } as const
    const found = await prisma.listing.findUnique({ where: { id }, select })
    // One choice of a product shares the product.
    const listing = found?.parentId ? await prisma.listing.findUnique({ where: { id: found.parentId }, select }) : found
    const shop = listing?.user.sellerProfile

    if (!listing || listing.archivedAt || !shop || shop.blockedAt) {
        sendMissing(res, shareUrl)
        return
    }

    const summary = withOptionSummary(listing, (await loadChoices([listing.id])).get(listing.id))
    const price = summary.hasPriceRange ? `from ${naira(summary.price)}` : naira(summary.price)

    sendPage(res, 200, renderSharePage({
        title: `${listing.title} · ${price}`,
        description: shorten(`${shop.businessName} on StoreHatch. ${listing.description}`, 180),
        imageUrl: listing.imageUrl,
        shareUrl: productShareUrl(listing.id),
        targetUrl: `${config.frontendUrl}/product/${listing.id}`,
        type: "product"
    }))
}

const maximumSitemapProducts = 45000

// Every shop and product page that search engines should know about. It lists the app's own addresses. It lives on
// the backend, so the app's robots.txt must name it ("Sitemap: <backend address>/sitemap.xml") for Google to accept it.
export const sitemap = async (_req: Request, res: Response) => {
    const [shops, products] = await Promise.all([
        prisma.sellerProfile.findMany({
            where: { blockedAt: null, user: { listings: { some: { archivedAt: null, parentId: null } } } },
            select: { slug: true },
            orderBy: { id: "asc" }
        }),
        prisma.listing.findMany({
            where: { archivedAt: null, parentId: null, user: { sellerProfile: { is: { blockedAt: null } } } },
            select: { id: true, createdAt: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: maximumSitemapProducts
        })
    ])
    const entry = (path: string, lastmod?: Date) =>
        `<url><loc>${escapeHtml(`${config.frontendUrl}${path}`)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : ""}</url>`
    const xml = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
        entry("/"),
        ...shops.map((shop) => entry(`/shop/${encodeURIComponent(shop.slug)}`)),
        ...products.map((product) => entry(`/product/${product.id}`, product.createdAt)),
        `</urlset>`
    ].join("\n")

    res.set("Cache-Control", "public, max-age=3600").type("application/xml").send(xml)
}
