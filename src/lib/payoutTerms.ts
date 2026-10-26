// Sellers must accept the current wording before payout accounts are created, and before StoreHatch may
// recover refunds from their future payments. Change the version whenever the wording or the fee
// arrangement changes, so sellers accept it again.
export const payoutFeeTerms = {
    version: "2026-10-27",
    text: "Payment providers (Paystack or Flutterwave) deduct their transaction fees, VAT on those fees, " +
        "and any government stamp duty (₦50 on payments of ₦10,000 or more) from your share of each sale " +
        "before paying you. StoreHatch takes no commission. Fees vary by provider and payment method. " +
        "Example: a ₦20,000 sale with a 1.5% + ₦100 card fee has ₦400 deducted, so you receive about ₦19,600, " +
        "less stamp duty where it applies. Each paid order will show the fee actually deducted. " +
        "Refunds: if a buyer is refunded for one of your orders after you have been paid, StoreHatch does not take " +
        "the money from your bank account. Instead it keeps part of your future sales until the refunded amount " +
        "is paid back: never more than half of your share of any one order, and every deduction is shown on your " +
        "orders. You will be told when a refund is charged to you and when money is deducted. Anything that cannot " +
        "be recovered this way, for example if you have no further sales, stays owed to StoreHatch."
}
