-- Cream and beige are no longer offered as shop colours. Shops that had them move to the default, forest.
UPDATE "SellerProfile" SET "brandColor" = 'forest' WHERE "brandColor" IN ('cream', 'beige');
