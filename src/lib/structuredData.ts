import config from "../config.js"

// Product details in the form Google reads (schema.org Product, as JSON-LD). With them, Google can show the price,
// whether it is in stock and the star rating under a product in its results, at no cost. Google reads the app's own
// product page, so the app puts this object in a <script type="application/ld+json"> tag there; the share pages carry
// it too. Google decides when to show these details.

type ProductFacts = {
    id: number
    title: string
    description: string
    images: string[]
    // The price, or the lowest price when the options cost different amounts.
    price: number
    highestPrice: number
    optionCount: number
    stockQuantity: number
    shopName: string | null
    ratingCount: number
    ratingAverage: number | null
}

const naira = (amount: number) => amount.toFixed(2)

export function productStructuredData(product: ProductFacts) {
    const url = `${config.frontendUrl}/product/${product.id}`
    const availability = product.stockQuantity > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
    const seller = product.shopName ? { "@type": "Organization", name: product.shopName } : undefined
    const offers = product.optionCount > 1 && product.highestPrice !== product.price
        ? { "@type": "AggregateOffer", priceCurrency: "NGN", lowPrice: naira(product.price), highPrice: naira(product.highestPrice), offerCount: product.optionCount, availability, url, ...(seller ? { seller } : {}) }
        : { "@type": "Offer", priceCurrency: "NGN", price: naira(product.price), availability, url, ...(seller ? { seller } : {}) }

    return {
        "@context": "https://schema.org/",
        "@type": "Product",
        name: product.title,
        ...(product.description.trim() ? { description: product.description.trim().slice(0, 5000) } : {}),
        image: product.images,
        sku: String(product.id),
        url,
        ...(product.shopName ? { brand: { "@type": "Brand", name: product.shopName } } : {}),
        offers,
        // Only real, visible reviews from buyers whose orders were delivered count, so the rating can be shown.
        ...(product.ratingCount > 0 && product.ratingAverage !== null
            ? { aggregateRating: { "@type": "AggregateRating", ratingValue: product.ratingAverage, reviewCount: product.ratingCount, bestRating: 5, worstRating: 1 } }
            : {})
    }
}

// JSON inside an HTML <script> tag: "<" is escaped so the text can never close the tag.
export function jsonLdScript(data: unknown): string {
    return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`
}
