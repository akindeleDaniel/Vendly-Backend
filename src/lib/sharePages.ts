import { jsonLdScript } from "./structuredData.js"

// Small HTML pages that WhatsApp, Facebook, X, Telegram and Google can read. The app itself is a single-page app,
// so a pasted shop or product link shows no picture or title. A share link points here instead: link-preview robots
// read the title, description and picture from this page, and people are sent straight on to the app.

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

export function shorten(text: string, length: number): string {
    const clean = text.replace(/\s+/g, " ").trim()
    return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean
}

// Link previews look best as a 1200 by 630 picture. Cloudinary pictures (where sellers' photos live) can be resized
// on the fly by adding settings to their address; any other picture is used as it is.
export function previewImage(url: string): string {
    const marker = "/image/upload/"

    if (!/^https:\/\/res\.cloudinary\.com\//.test(url) || !url.includes(marker)) {
        return url
    }

    return url.replace(marker, `${marker}c_pad,b_white,w_1200,h_630,f_jpg,q_auto/`)
}

export type SharePage = {
    title: string
    description: string
    imageUrl: string | null
    // This page's own address. Facebook re-reads the address named in og:url, so it must be this page, not the app.
    shareUrl: string
    // Where people are sent: the shop or product page in the app.
    targetUrl: string
    type: "website" | "product"
    // Product details for Google (schema.org JSON-LD), when the page is a product.
    structuredData?: unknown
}

export function renderSharePage(page: SharePage): string {
    const title = escapeHtml(page.title)
    const description = escapeHtml(page.description)
    const target = escapeHtml(page.targetUrl)
    const image = page.imageUrl ? escapeHtml(previewImage(page.imageUrl)) : null

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:site_name" content="StoreHatch">
<meta property="og:type" content="${page.type}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${escapeHtml(page.shareUrl)}">
${image ? `<meta property="og:image" content="${image}">\n<meta property="og:image:alt" content="${title}">\n` : ""}<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
${image ? `<meta name="twitter:image" content="${image}">\n` : ""}<link rel="canonical" href="${target}">
<meta http-equiv="refresh" content="0; url=${target}">
${page.structuredData ? `${jsonLdScript(page.structuredData)}\n` : ""}</head>
<body style="font-family:system-ui,sans-serif;padding:24px">
<p><a href="${target}">Continue to ${title}</a></p>
</body>
</html>`
}
