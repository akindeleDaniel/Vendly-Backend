export const categories = [
    "Food & Grocery",
    "Fashion & Clothing",
    "Electronics",
    "Phones & Accessories",
    "Beauty & Personal Care",
    "Health & Wellness",
    "Home & Furniture",
    "Computers & Accessories",
    "Sports & Fitness",
    "Books & Stationery",
    "Baby & Kids",
    "Automotive",
    "Jewelry & Accessories",
    "Toys & Games",
    "Pet Supplies",
    "Arts, Crafts & Hobbies",
    "Tools & Hardware",
    "Other"
] as const

export function getCanonicalCategory(value: unknown): string | null {
    if (typeof value !== "string") {
        return null
    }

    const normalizedValue = value.trim().toLocaleLowerCase()
    return categories.find((category) => category.toLocaleLowerCase() === normalizedValue) ?? null
}
