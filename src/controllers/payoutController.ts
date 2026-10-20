import bcrypt from "bcrypt"
import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import { Prisma, type PaymentProvider, type SellerPayoutAccount } from "../generated/prisma/client.js"
import { findPayoutBank, payoutBanks, type PayoutBank } from "../lib/payoutBanks.js"
import { getPaymentProvider, paymentProviderNames, paymentProviders } from "../lib/payments/providers.js"
import { PaymentProviderError, type ProviderSubaccount } from "../lib/payments/types.js"
import { liabilityDeductionCapPercent } from "../lib/liabilities.js"
import { payoutFeeTerms } from "../lib/payoutTerms.js"

// The wording sellers accept lives in src/lib/payoutTerms.ts; it is re-exported here for the routes and tests.
export { payoutFeeTerms }

export type PayoutErrorCode =
    | "PAYOUT_ACCOUNT_INVALID"
    | "PAYOUT_PROVIDER_UNAVAILABLE"
    | "PAYOUT_FEE_TERMS_OUTDATED"
    | "PAYOUT_ACCOUNTS_ACTIVE"
    | "PAYOUT_ACCOUNT_MISMATCH"
    | "PAYOUT_SETUP_IN_PROGRESS"
    | "PAYOUT_SETUP_INCOMPLETE"
    | "PAYOUT_PASSWORD_INCORRECT"
    | "PAYOUT_ACCOUNTS_NOT_SET_UP"
    | "PAYOUT_ACCOUNT_UNCHANGED"

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

type BankDetailsChange = {
    profile: { id: number; businessName: string; email: string }
    bank: PayoutBank
    accountNumber: string
    accountName: string
    businessPhone: string
    // Picks the providers to configure from the seller's current accounts, or throws.
    selectProviders(existingAccounts: SellerPayoutAccount[]): PaymentProvider[]
    profileUpdate?: Prisma.SellerProfileUpdateInput
}

// Points the seller's payout accounts on the selected providers at the given bank details.
// The accounts are first claimed as PENDING under a per-seller lock, then each provider is
// called outside any database transaction (creating a subaccount, or updating the existing
// one so its code stays the same), then each result is saved.
async function applyBankDetails(change: BankDetailsChange) {
    const { profile, bank, accountNumber, accountName, businessPhone } = change

    const claimedAccounts = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${payoutAdvisoryLockNamespace}::integer, ${profile.id}::integer)`

        const existingAccounts = await tx.sellerPayoutAccount.findMany({
            where: { sellerProfileId: profile.id }
        })
        const pendingCutoff = Date.now() - pendingSetupTimeoutMs

        if (existingAccounts.some((account) => account.status === "PENDING" && account.updatedAt.getTime() > pendingCutoff)) {
            throw new PayoutRequestError(
                409,
                "Payout setup is already in progress. Try again shortly.",
                "PAYOUT_SETUP_IN_PROGRESS"
            )
        }

        const providers = change.selectProviders(existingAccounts)
        const accountDetails = {
            status: "PENDING" as const,
            bankId: bank.id,
            bankName: bank.name,
            accountName,
            accountNumberLast4: accountNumber.slice(-4),
            failureReason: null
        }
        const claimed: Array<{ provider: PaymentProvider; subaccount: ProviderSubaccount | null }> = []

        // An existing subaccount code is kept so the provider's subaccount is updated in place.
        for (const provider of providers) {
            const account = await tx.sellerPayoutAccount.upsert({
                where: { sellerProfileId_provider: { sellerProfileId: profile.id, provider } },
                create: { sellerProfileId: profile.id, provider, ...accountDetails },
                update: accountDetails
            })
            claimed.push({
                provider,
                subaccount: account.subaccountCode
                    ? { subaccountCode: account.subaccountCode, providerAccountId: account.providerAccountId }
                    : null
            })
        }

        if (change.profileUpdate) {
            await tx.sellerProfile.update({ where: { id: profile.id }, data: change.profileUpdate })
        }

        return claimed
    })

    const results = await Promise.all(claimedAccounts.map(async ({ provider, subaccount }) => {
        const input = {
            businessName: profile.businessName,
            businessEmail: profile.email,
            businessPhone,
            bankCode: provider === "PAYSTACK" ? bank.paystackCode : bank.flutterwaveCode,
            accountNumber
        }

        try {
            if (subaccount) {
                await getPaymentProvider(provider).updateSubaccount(subaccount, input)
                return { provider, subaccount, failureReason: null }
            }

            const created = await getPaymentProvider(provider).createSubaccount(input)
            return { provider, subaccount: created, failureReason: null }
        } catch (error) {
            const rejected = error instanceof PaymentProviderError && error.kind === "rejected"
            console.error(subaccount ? "Payout account update failed" : "Payout account creation failed", {
                provider,
                sellerProfileId: profile.id,
                reason: error instanceof PaymentProviderError
                    ? redactAccountNumbers(error.providerMessage)
                    : error instanceof Error ? error.name : undefined
            })
            return {
                provider,
                subaccount,
                failureReason: rejected
                    ? `${paymentProviderNames[provider]} rejected these account details`
                    : `${paymentProviderNames[provider]} could not be reached. Try again.`
            }
        }
    }))

    // A failed update keeps its subaccount code so a retry updates the same subaccount. The
    // account stays FAILED, and so unusable for payments, until the provider accepts the new details.
    for (const result of results) {
        await prisma.sellerPayoutAccount.update({
            where: { sellerProfileId_provider: { sellerProfileId: profile.id, provider: result.provider } },
            data: result.failureReason
                ? { status: "FAILED", failureReason: result.failureReason }
                : {
                    status: "ACTIVE",
                    subaccountCode: result.subaccount?.subaccountCode ?? null,
                    providerAccountId: result.subaccount?.providerAccountId ?? null,
                    failureReason: null
                }
        })
    }

    const accounts = await prisma.sellerPayoutAccount.findMany({
        where: { sellerProfileId: profile.id },
        orderBy: { provider: "asc" }
    })

    return {
        accounts: accounts.map(toPayoutAccountResponse),
        failedProviders: results.filter((result) => result.failureReason).map((result) => result.provider)
    }
}

function sendIncompleteBankDetails(
    res: Response,
    action: string,
    result: Awaited<ReturnType<typeof applyBankDetails>>
) {
    const providerNames = result.failedProviders.map((provider) => paymentProviderNames[provider]).join(" and ")

    res.status(502).send({
        message: `${action} failed for ${providerNames}. Try again.`,
        code: "PAYOUT_SETUP_INCOMPLETE",
        accounts: result.accounts
    })
}

function matchesBankDetails(account: SellerPayoutAccount, bank: PayoutBank, accountNumber: string, accountName: string) {
    return account.bankId === bank.id &&
        account.accountNumberLast4 === accountNumber.slice(-4) &&
        account.accountName === accountName
}

// Creates the seller's payout accounts on every provider that does not have an active one yet.
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
        const result = await applyBankDetails({
            profile: { id: profile.id, businessName: profile.businessName, email: profile.user.email },
            bank,
            accountNumber,
            accountName,
            businessPhone,
            selectProviders(existingAccounts) {
                const activeAccounts = existingAccounts.filter((account) => account.status === "ACTIVE")
                const providers = paymentProviders.filter(
                    (provider) => !activeAccounts.some((account) => account.provider === provider)
                )

                if (providers.length === 0) {
                    throw new PayoutRequestError(409, "Your payout accounts are already set up", "PAYOUT_ACCOUNTS_ACTIVE")
                }

                // Every provider must pay into the same bank account. Changing it is a separate action.
                if (activeAccounts.some((account) => !matchesBankDetails(account, bank, accountNumber, accountName))) {
                    throw new PayoutRequestError(
                        409,
                        "Use the same bank account as your active payout account, or change your bank account instead",
                        "PAYOUT_ACCOUNT_MISMATCH"
                    )
                }

                return providers
            },
            profileUpdate: {
                businessPhone,
                payoutTermsVersion: payoutFeeTerms.version,
                payoutTermsAcceptedAt: new Date()
            }
        })

        if (result.failedProviders.length > 0) {
            sendIncompleteBankDetails(res, "Payout setup", result)
            return
        }

        res.status(201).send({ accounts: result.accounts })
    } catch (error) {
        if (!sendPayoutRequestError(error, res)) {
            throw error
        }
    }
}

// Moves the seller's payouts to a different bank account on both providers. Changing where money
// goes is what someone with a stolen session would try, so the current password is required.
export const changePayoutBankAccount = async (req: Request, res: Response) => {
    try {
        const bank = parseBank(req.body.bankId)
        const accountNumber = parseAccountNumber(req.body.accountNumber)

        if (typeof req.body.password !== "string" || !req.body.password) {
            throw new PayoutRequestError(400, "Enter your current password to change your bank account")
        }

        const profile = await prisma.sellerProfile.findUnique({
            where: { userId: req.user!.id },
            include: {
                user: { select: { email: true, passwordHash: true } },
                payoutAccounts: { select: { id: true } }
            }
        })

        if (!profile) {
            res.status(404).send({ message: "Store profile not found" })
            return
        }

        // 403 rather than 401: the session is valid, and the frontend signs the user out on 401.
        if (!await bcrypt.compare(req.body.password, profile.user.passwordHash)) {
            throw new PayoutRequestError(403, "Password is incorrect", "PAYOUT_PASSWORD_INCORRECT")
        }

        if (profile.payoutAccounts.length === 0 || !profile.businessPhone) {
            throw new PayoutRequestError(409, "Set up your payout accounts first", "PAYOUT_ACCOUNTS_NOT_SET_UP")
        }

        const accountName = await resolveAccountName(bank, accountNumber)
        const result = await applyBankDetails({
            profile: { id: profile.id, businessName: profile.businessName, email: profile.user.email },
            bank,
            accountNumber,
            accountName,
            businessPhone: profile.businessPhone,
            selectProviders(existingAccounts) {
                const providers = paymentProviders.filter((provider) => {
                    const account = existingAccounts.find((existing) => existing.provider === provider)
                    return !(account?.status === "ACTIVE" && matchesBankDetails(account, bank, accountNumber, accountName))
                })

                if (providers.length === 0) {
                    throw new PayoutRequestError(409, "This is already your payout bank account", "PAYOUT_ACCOUNT_UNCHANGED")
                }

                return providers
            }
        })

        if (result.failedProviders.length > 0) {
            sendIncompleteBankDetails(res, "Changing your bank account", result)
            return
        }

        res.send({ accounts: result.accounts })
    } catch (error) {
        if (!sendPayoutRequestError(error, res)) {
            throw error
        }
    }
}


// Records that the seller accepts the current payout terms, for example after the wording changed.
// Vendly only recovers refunds from the future payments of sellers who have accepted the current terms.
export const acceptPayoutTerms = async (req: Request, res: Response) => {
    if (req.body.feeTermsVersion !== payoutFeeTerms.version) {
        res.status(409).send({
            message: "The payout terms have changed. Review them and try again.",
            code: "PAYOUT_FEE_TERMS_OUTDATED"
        })
        return
    }

    const accepted = await prisma.sellerProfile.updateMany({
        where: { userId: req.user!.id },
        data: { payoutTermsVersion: payoutFeeTerms.version, payoutTermsAcceptedAt: new Date() }
    })

    if (accepted.count === 0) {
        res.status(404).send({ message: "Store profile not found" })
        return
    }

    res.send({ acceptedFeeTermsVersion: payoutFeeTerms.version })
}

// What the seller owes Vendly for refunds, and each deduction taken from their sales so far, so a
// seller can always see why money was deducted. Nothing is deducted until they accept the terms.
export const getMyLiabilities = async (req: Request, res: Response) => {
    const profile = await prisma.sellerProfile.findUnique({
        where: { userId: req.user!.id },
        select: { payoutTermsVersion: true }
    })

    if (!profile) {
        res.status(404).send({ message: "Store profile not found" })
        return
    }

    const liabilities = await prisma.sellerLiability.findMany({
        where: { sellerId: req.user!.id },
        orderBy: { id: "desc" },
        take: 100,
        include: {
            refund: { select: { orderId: true, reason: true } },
            recoveries: { orderBy: { id: "asc" }, select: { orderId: true, amount: true, note: true, createdAt: true } }
        }
    })
    const outstanding = liabilities
        .filter((liability) => liability.status === "OPEN")
        .reduce((sum, liability) => sum.plus(liability.amount).minus(liability.recovered), new Prisma.Decimal(0))

    res.send({
        termsAccepted: profile.payoutTermsVersion === payoutFeeTerms.version,
        feeTerms: payoutFeeTerms,
        deductionCapPercent: liabilityDeductionCapPercent,
        outstanding: outstanding.toFixed(2),
        liabilities: liabilities.map((liability) => ({
            id: liability.id,
            orderId: liability.refund.orderId,
            reason: liability.refund.reason,
            amount: liability.amount.toFixed(2),
            recovered: liability.recovered.toFixed(2),
            remaining: liability.amount.minus(liability.recovered).toFixed(2),
            status: liability.status,
            createdAt: liability.createdAt,
            closedAt: liability.closedAt,
            recoveries: liability.recoveries.map((recovery) => ({
                orderId: recovery.orderId,
                amount: recovery.amount.toFixed(2),
                note: recovery.note,
                createdAt: recovery.createdAt
            }))
        }))
    })
}
