import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import type { PaymentProvider, SellerPayoutAccount } from "../generated/prisma/client.js"
import { findPayoutBank, payoutBanks, type PayoutBank } from "../lib/payoutBanks.js"
import { getPaymentProvider, paymentProviderNames, paymentProviders } from "../lib/payments/providers.js"
import { PaymentProviderError } from "../lib/payments/types.js"

// Sellers must accept the current wording before payout accounts are created. Change the
// version whenever the wording or the fee arrangement changes, so sellers accept it again.
export const payoutFeeTerms = {
    version: "2026-10-18",
    text: "Payment providers (Paystack or Flutterwave) deduct their transaction fees, VAT on those fees, " +
        "and any government stamp duty (₦50 on payments of ₦10,000 or more) from your share of each sale " +
        "before paying you. Vendly takes no commission. Fees vary by provider and payment method. " +
        "Example: a ₦20,000 sale with a 1.5% + ₦100 card fee has ₦400 deducted, so you receive about ₦19,600, " +
        "less stamp duty where it applies. Each paid order will show the fee actually deducted."
}

export type PayoutErrorCode =
    | "PAYOUT_ACCOUNT_INVALID"
    | "PAYOUT_PROVIDER_UNAVAILABLE"
    | "PAYOUT_FEE_TERMS_OUTDATED"
    | "PAYOUT_ACCOUNTS_ACTIVE"
    | "PAYOUT_ACCOUNT_MISMATCH"
    | "PAYOUT_SETUP_IN_PROGRESS"
    | "PAYOUT_SETUP_INCOMPLETE"

class PayoutRequestError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
        readonly code?: PayoutErrorCode
    ) {
        super(message)
    }
}

// A PENDING account younger than this is treated as a setup still running in another request.
// Older PENDING accounts (for example after a crash) may be retried.
const pendingSetupTimeoutMs = 2 * 60 * 1000
const payoutAdvisoryLockNamespace = 1447380557

function parseBank(value: unknown): PayoutBank {
    const bank = findPayoutBank(value)

    if (!bank) {
        throw new PayoutRequestError(400, "Choose a supported bank")
    }

    return bank
}

function parseAccountNumber(value: unknown): string {
    if (typeof value !== "string" || !/^\d{10}$/.test(value.trim())) {
        throw new PayoutRequestError(400, "Account number must be exactly 10 digits")
    }

    return value.trim()
}

// Accepts 0XXXXXXXXXX, 234XXXXXXXXXX or +234XXXXXXXXXX (spaces and dashes allowed) and
// returns the local 11-digit format.
function parseBusinessPhone(value: unknown): string {
    const digits = typeof value === "string" ? value.replace(/[\s-]/g, "") : ""
    const match = /^(?:\+?234|0)([789][01]\d{8})$/.exec(digits)

    if (!match) {
        throw new PayoutRequestError(400, "Business phone must be a valid Nigerian mobile number")
    }

    return `0${match[1]}`
}

// Bank account numbers are never logged, even if a provider echoes one back.
function redactAccountNumbers(message: string | undefined): string | undefined {
    return message?.replace(/\d{10}/g, "[redacted]")
}

async function resolveAccountName(bank: PayoutBank, accountNumber: string): Promise<string> {
    try {
        const { accountName } = await getPaymentProvider("PAYSTACK").resolveAccount({
            bankCode: bank.paystackCode,
            accountNumber
        })
        return accountName
    } catch (error) {
        if (error instanceof PaymentProviderError && error.kind === "rejected") {
            throw new PayoutRequestError(400, "Account details are invalid", "PAYOUT_ACCOUNT_INVALID")
        }

        console.error("Payout account resolution failed", {
            provider: "PAYSTACK",
            reason: error instanceof PaymentProviderError ? redactAccountNumbers(error.providerMessage) : undefined
        })
        throw new PayoutRequestError(
            502,
            "We could not verify the account right now. Try again.",
            "PAYOUT_PROVIDER_UNAVAILABLE"
        )
    }
}

function sendPayoutRequestError(error: unknown, res: Response): boolean {
    if (!(error instanceof PayoutRequestError)) {
        return false
    }

    res.status(error.statusCode).send({
        message: error.message,
        ...(error.code ? { code: error.code } : {})
    })
    return true
}

function toPayoutAccountResponse(account: SellerPayoutAccount) {
    return {
        provider: account.provider,
        status: account.status,
        bankId: account.bankId,
        bankName: account.bankName,
        accountName: account.accountName,
        accountNumberLast4: account.accountNumberLast4,
        failureReason: account.failureReason,
        updatedAt: account.updatedAt
    }
}

export const getPayoutBanks = (_req: Request, res: Response) => {
    res.send(payoutBanks.map(({ id, name }) => ({ id, name })))
}

export const resolvePayoutAccount = async (req: Request, res: Response) => {
    try {
        const bank = parseBank(req.body.bankId)
        const accountNumber = parseAccountNumber(req.body.accountNumber)
        const accountName = await resolveAccountName(bank, accountNumber)

        res.send({ accountName })
    } catch (error) {
        if (!sendPayoutRequestError(error, res)) {
            throw error
        }
    }
}

export const getPayoutAccounts = async (req: Request, res: Response) => {
    const profile = await prisma.sellerProfile.findUnique({
        where: { userId: req.user!.id },
        include: { payoutAccounts: { orderBy: { provider: "asc" } } }
    })

    if (!profile) {
        res.status(404).send({ message: "Store profile not found" })
        return
    }

    res.send({
        feeTerms: payoutFeeTerms,
        acceptedFeeTermsVersion: profile.payoutTermsVersion,
        feeTermsAcceptedAt: profile.payoutTermsAcceptedAt,
        businessPhone: profile.businessPhone,
        accounts: profile.payoutAccounts.map(toPayoutAccountResponse)
    })
}

// Creates the seller's payout accounts on every provider that does not have an active one yet.
// The provider calls happen outside database transactions: the accounts are first claimed as
// PENDING, then each provider is called, then each result is saved.
export const createPayoutAccounts = async (req: Request, res: Response) => {
    try {
        const bank = parseBank(req.body.bankId)
        const accountNumber = parseAccountNumber(req.body.accountNumber)
        const businessPhone = parseBusinessPhone(req.body.businessPhone)

        if (req.body.acceptFeeTerms !== true) {
            throw new PayoutRequestError(400, "You must accept the payout fee terms")
        }

        if (req.body.feeTermsVersion !== payoutFeeTerms.version) {
            throw new PayoutRequestError(
                409,
                "The payout fee terms have changed. Review them and try again.",
                "PAYOUT_FEE_TERMS_OUTDATED"
            )
        }

        const profile = await prisma.sellerProfile.findUnique({
            where: { userId: req.user!.id },
            include: { user: { select: { email: true } } }
        })

        if (!profile) {
            res.status(404).send({ message: "Store profile not found" })
            return
        }

        const accountName = await resolveAccountName(bank, accountNumber)
        const accountNumberLast4 = accountNumber.slice(-4)

        const providersToSetUp = await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${payoutAdvisoryLockNamespace}::integer, ${profile.id}::integer)`

            const existingAccounts = await tx.sellerPayoutAccount.findMany({
                where: { sellerProfileId: profile.id }
            })
            const activeAccounts = existingAccounts.filter((account) => account.status === "ACTIVE")
            const pendingCutoff = Date.now() - pendingSetupTimeoutMs

            if (existingAccounts.some((account) => account.status === "PENDING" && account.updatedAt.getTime() > pendingCutoff)) {
                throw new PayoutRequestError(
                    409,
                    "Payout setup is already in progress. Try again shortly.",
                    "PAYOUT_SETUP_IN_PROGRESS"
                )
            }

            const pendingProviders = paymentProviders.filter(
                (provider) => !activeAccounts.some((account) => account.provider === provider)
            )

            if (pendingProviders.length === 0) {
                throw new PayoutRequestError(409, "Your payout accounts are already set up", "PAYOUT_ACCOUNTS_ACTIVE")
            }

            // Every provider must pay into the same bank account.
            if (activeAccounts.some((account) =>
                account.bankId !== bank.id ||
                account.accountNumberLast4 !== accountNumberLast4 ||
                account.accountName !== accountName
            )) {
                throw new PayoutRequestError(
                    409,
                    "Use the same bank account as your active payout account",
                    "PAYOUT_ACCOUNT_MISMATCH"
                )
            }

            const accountDetails = {
                status: "PENDING" as const,
                subaccountCode: null,
                bankId: bank.id,
                bankName: bank.name,
                accountName,
                accountNumberLast4,
                failureReason: null
            }

            for (const provider of pendingProviders) {
                await tx.sellerPayoutAccount.upsert({
                    where: { sellerProfileId_provider: { sellerProfileId: profile.id, provider } },
                    create: { sellerProfileId: profile.id, provider, ...accountDetails },
                    update: accountDetails
                })
            }

            await tx.sellerProfile.update({
                where: { id: profile.id },
                data: {
                    businessPhone,
                    payoutTermsVersion: payoutFeeTerms.version,
                    payoutTermsAcceptedAt: new Date()
                }
            })

            return pendingProviders
        })

        const results = await Promise.all(providersToSetUp.map(async (provider) => {
            try {
                const { subaccountCode } = await getPaymentProvider(provider).createSubaccount({
                    businessName: profile.businessName,
                    businessEmail: profile.user.email,
                    businessPhone,
                    bankCode: provider === "PAYSTACK" ? bank.paystackCode : bank.flutterwaveCode,
                    accountNumber
                })
                return { provider, subaccountCode, failureReason: null }
            } catch (error) {
                const rejected = error instanceof PaymentProviderError && error.kind === "rejected"
                console.error("Payout account creation failed", {
                    provider,
                    sellerProfileId: profile.id,
                    reason: error instanceof PaymentProviderError
                        ? redactAccountNumbers(error.providerMessage)
                        : error instanceof Error ? error.name : undefined
                })
                return {
                    provider,
                    subaccountCode: null,
                    failureReason: rejected
                        ? `${paymentProviderNames[provider]} rejected these account details`
                        : `${paymentProviderNames[provider]} could not be reached. Try again.`
                }
            }
        }))

        for (const result of results) {
            await prisma.sellerPayoutAccount.update({
                where: { sellerProfileId_provider: { sellerProfileId: profile.id, provider: result.provider } },
                data: result.subaccountCode
                    ? { status: "ACTIVE", subaccountCode: result.subaccountCode, failureReason: null }
                    : { status: "FAILED", failureReason: result.failureReason }
            })
        }

        const accounts = await prisma.sellerPayoutAccount.findMany({
            where: { sellerProfileId: profile.id },
            orderBy: { provider: "asc" }
        })
        const failedProviders: PaymentProvider[] = results
            .filter((result) => !result.subaccountCode)
            .map((result) => result.provider)

        if (failedProviders.length > 0) {
            res.status(502).send({
                message: `Payout setup failed for ${failedProviders.map((provider) => paymentProviderNames[provider]).join(" and ")}. Try again.`,
                code: "PAYOUT_SETUP_INCOMPLETE",
                accounts: accounts.map(toPayoutAccountResponse)
            })
            return
        }

        res.status(201).send({ accounts: accounts.map(toPayoutAccountResponse) })
    } catch (error) {
        if (!sendPayoutRequestError(error, res)) {
            throw error
        }
    }
}
