export function makeSlug(businessName: string) {
    const slug = businessName
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

    return slug || "shop"
}