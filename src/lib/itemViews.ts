import { brandColorFor } from "./shopBranding.js"

// The shapes that order, complaint and pre-order pages share: an item's photo and chosen option, and the shop's
// card (name, logo, colour and area). Anything empty is sent as null.

export const itemListingSelect = {
    imageUrl: true,
    optionLabel: true,
    sizeLabel: true,
    parent: { select: { title: true, imageUrl: true } }
} as const

type ItemListing = {
    imageUrl: string
    optionLabel: string | null
    sizeLabel: string | null
    parent: { title: string; imageUrl: string } | null
}

// A chosen option with no photo of its own shows the product's photo.
export function itemListingView(listing: ItemListing | null | undefined) {
    return {
        imageUrl: listing?.imageUrl || listing?.parent?.imageUrl || null,
        optionLabel: listing?.optionLabel || null,
        sizeLabel: listing?.sizeLabel || null
    }
}

export const shopCardSelect = { businessName: true, slug: true, logoUrl: true, brandColor: true, location: true } as const

type ShopCardColumns = { businessName: string; slug: string; logoUrl: string; brandColor: string; location: string }

// The shop with its colour as the resolved preset, the same as the cart and the shop page.
export function shopCardView(profile: ShopCardColumns) {
    return {
        businessName: profile.businessName,
        slug: profile.slug,
        logoUrl: profile.logoUrl.trim() || null,
        brandColor: brandColorFor(profile.brandColor),
        location: profile.location.trim() || null
    }
}
