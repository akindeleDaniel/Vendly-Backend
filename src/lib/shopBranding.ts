import { isHttpsUrl } from "./inputRules.js"

// A shop's own look: a banner, one preset colour, an "about" text, social handles and an optional WhatsApp button.
// Colours are presets rather than any colour, so every shop stays readable: each pairs a background with the text
// colour that passes contrast on it (white on the dark ones, charcoal on the light ones). Checkout and payment always
// use StoreHatch's own colours.

export type BrandColor = { key: string; name: string; background: string; text: string; tint: string; light: boolean }

const charcoal = "#242923"
const white = "#FFFFFF"

// Contrast of the text colour on the background, checked when chosen (WCAG; 4.5:1 is the minimum for text):
// forest 9.98, navy 11.48, teal 7.50, indigo 9.16, plum 11.13, wine 10.20, terracotta 6.77, charcoal 13.49,
// brown 8.97 (all white text); cream 12.52, beige 10.08 (charcoal text).
export const brandColors: BrandColor[] = [
    { key: "forest", name: "Forest", background: "#174B3A", text: white, tint: "#E8EEEB", light: false },
    { key: "navy", name: "Navy", background: "#1F3A5F", text: white, tint: "#E9EBEF", light: false },
    { key: "teal", name: "Teal", background: "#0F5E63", text: white, tint: "#E7EFEF", light: false },
    { key: "indigo", name: "Indigo", background: "#3B3F8F", text: white, tint: "#EBECF4", light: false },
    { key: "plum", name: "Plum", background: "#5B2A4E", text: white, tint: "#EFEAED", light: false },
    { key: "wine", name: "Wine", background: "#7A1F2B", text: white, tint: "#F2E9EA", light: false },
    { key: "terracotta", name: "Terracotta", background: "#9C3D22", text: white, tint: "#F5ECE9", light: false },
    { key: "charcoal", name: "Charcoal", background: "#2B2F33", text: white, tint: "#EAEAEB", light: false },
    { key: "brown", name: "Brown", background: "#6B3E26", text: white, tint: "#F0ECE9", light: false },
    // The light ones are very close to the page background: show them with a thin border.
    { key: "cream", name: "Cream", background: "#F3EBDD", text: charcoal, tint: "#FBF8F3", light: true },
    { key: "beige", name: "Beige", background: "#E3D3B8", text: charcoal, tint: "#F8F3EB", light: true }
]

export const maximumAboutLength = 500

const handleRules = {
    instagram: { column: "instagramHandle", pattern: /^[A-Za-z0-9._]{1,30}$/, url: (handle: string) => `https://instagram.com/${handle}`, label: "Instagram" },
    tiktok: { column: "tiktokHandle", pattern: /^[A-Za-z0-9._]{2,24}$/, url: (handle: string) => `https://www.tiktok.com/@${handle}`, label: "TikTok" },
    facebook: { column: "facebookHandle", pattern: /^[A-Za-z0-9.]{5,50}$/, url: (handle: string) => `https://facebook.com/${handle}`, label: "Facebook" },
    x: { column: "xHandle", pattern: /^[A-Za-z0-9_]{1,15}$/, url: (handle: string) => `https://x.com/${handle}`, label: "X" }
} as const

export type BrandingData = {
    bannerUrl?: string | null
    brandColor?: string
    about?: string | null
    instagramHandle?: string | null
    tiktokHandle?: string | null
    facebookHandle?: string | null
    xHandle?: string | null
    whatsappNumber?: string | null
}

export const brandingFields = ["bannerUrl", "brandColor", "about", "instagram", "tiktok", "facebook", "x", "whatsappNumber"] as const

export function hasBrandingFields(body: Record<string, unknown>): boolean {
    return brandingFields.some((field) => body[field] !== undefined)
}

// Turns a Nigerian mobile number in any usual form (0801..., 234801..., +234801...) into +234XXXXXXXXXX.
export function normaliseNigerianMobile(value: string): string | null {
    const digits = value.replace(/[\s-]/g, "")
    const match = /^(?:\+?234|0)([789][01]\d{8})$/.exec(digits)
    return match ? `+234${match[1]}` : null
}

// The branding fields from a request body, each optional; null or an empty string clears one (except the colour).
export function readBranding(body: Record<string, unknown>): BrandingData | { error: string } {
    const data: BrandingData = {}
    const blank = (value: unknown) => value === null || (typeof value === "string" && value.trim() === "")

    if (body.bannerUrl !== undefined) {
        if (blank(body.bannerUrl)) {
            data.bannerUrl = null
        } else if (!isHttpsUrl(body.bannerUrl)) {
            return { error: "The banner must be an https link to an image" }
        } else {
            data.bannerUrl = body.bannerUrl as string
        }
    }

    if (body.brandColor !== undefined) {
        if (typeof body.brandColor !== "string" || !brandColors.some((color) => color.key === body.brandColor)) {
            return { error: `The colour must be one of: ${brandColors.map((color) => color.key).join(", ")}` }
        }

        data.brandColor = body.brandColor
    }

    if (body.about !== undefined) {
        if (blank(body.about)) {
            data.about = null
        } else if (typeof body.about !== "string") {
            return { error: "About must be text" }
        } else {
            const about = body.about.trim().replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n")

            if (about.length > maximumAboutLength) {
                return { error: `About must be ${maximumAboutLength} characters or fewer` }
            }

            // No links, so the about text cannot be used to send shoppers somewhere else to pay.
            if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ng|net|org|shop|store|co|io|me|link|xyz)\b/i.test(about)) {
                return { error: "About cannot contain links. Use the social fields for your pages" }
            }

            data.about = about
        }
    }

    for (const [field, rule] of Object.entries(handleRules)) {
        const value = body[field]

        if (value === undefined) {
            continue
        }

        if (blank(value)) {
            data[rule.column] = null
            continue
        }

        const handle = typeof value === "string" ? value.trim().replace(/^@/, "") : null

        if (!handle || !rule.pattern.test(handle)) {
            return { error: `Enter your ${rule.label} username only, for example @yourshop` }
        }

        data[rule.column] = handle
    }

    if (body.whatsappNumber !== undefined) {
        if (blank(body.whatsappNumber)) {
            data.whatsappNumber = null
        } else {
            const number = typeof body.whatsappNumber === "string" ? normaliseNigerianMobile(body.whatsappNumber) : null

            if (!number) {
                return { error: "Enter a Nigerian mobile number for WhatsApp, for example 08012345678" }
            }

            data.whatsappNumber = number
        }
    }

    return data
}

type BrandingColumns = {
    businessName: string
    bannerUrl: string | null
    brandColor: string
    about: string | null
    instagramHandle: string | null
    tiktokHandle: string | null
    facebookHandle: string | null
    xHandle: string | null
    whatsappNumber: string | null
}

export function brandColorFor(key: string): BrandColor {
    return brandColors.find((color) => color.key === key) ?? brandColors[0]!
}

// The branding as shoppers see it. The WhatsApp link opens a chat with a message saying where they found the shop.
export function brandingView(profile: BrandingColumns) {
    const social = Object.fromEntries(
        Object.entries(handleRules).map(([field, rule]) => {
            const handle = profile[rule.column]
            return [field, handle ? { handle, url: rule.url(handle) } : null]
        })
    )
    const message = `Hi ${profile.businessName}, I found your shop on StoreHatch.`

    return {
        bannerUrl: profile.bannerUrl,
        brandColor: brandColorFor(profile.brandColor),
        about: profile.about,
        social,
        whatsapp: profile.whatsappNumber
            ? { number: profile.whatsappNumber, url: `https://wa.me/${profile.whatsappNumber.slice(1)}?text=${encodeURIComponent(message)}` }
            : null
    }
}

// "Ask about this product": a WhatsApp chat with the shop that already names the product and links to it, so the
// shopper does not have to explain which one they mean. Only for shops that switched their WhatsApp number on.
export function productEnquiry(whatsappNumber: string | null, shop: string, product: { title: string; price: number; from: boolean }, shareUrl: string) {
    if (!whatsappNumber) {
        return null
    }

    const price = `₦${product.price.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`
    const message = `Hi ${shop}, I'm interested in "${product.title}" (${product.from ? `from ${price}` : price}) on StoreHatch: ${shareUrl}`

    return { number: whatsappNumber, message, url: `https://wa.me/${whatsappNumber.slice(1)}?text=${encodeURIComponent(message)}` }
}

export const brandingSelect = {
    bannerUrl: true,
    brandColor: true,
    about: true,
    instagramHandle: true,
    tiktokHandle: true,
    facebookHandle: true,
    xHandle: true,
    whatsappNumber: true
} as const
