import { z } from "zod"
import { SOLANA_PROGRAMS, TOKEN_PROGRAMS } from "../chains/solana"
import { ToolError } from "../errors"
import type { JsonRpcClient } from "../rpc/client"
import { metadataAddress } from "./address"
import { accountOf, rawAccountOf, unreadable, type SolanaAccount } from "./reads"
import { metadataTokenStandard, type MetadataFacts } from "./token-rules"

/** An extension of a Token-2022 mint or token account, as the node parses it: its camelCase name and its state (empty for one that has none). */
export type TokenExtension = { name: string; state: Record<string, unknown> }

/** What a send needs of a token mint. */
export type MintFacts = {
  /** The token program that owns the mint. */
  program: string
  decimals: number
  supply: bigint
  freezeAuthority: string | null
  extensions: TokenExtension[]
}

/** What a send needs of a token account. */
export type TokenAccountFacts = {
  mint: string
  /** The wallet that owns the token account, which may sign for it. */
  owner: string
  amount: bigint
  delegate: string | null
  /** What the delegate may still move; 0 when there is none. */
  delegatedAmount: bigint
  state: "initialized" | "frozen"
  extensions: TokenExtension[]
}

/** The method whose answer holds a mint or a token account. */
const METHOD = "getAccountInfo"

/** A u64 as the node writes it: 1 to 20 digits. */
const AMOUNT_PATTERN = /^\d{1,20}$/

const MAX_DECIMALS = 255

/** What a refusal adds about an address that is no token mint, for the asset that never has one. */
const NO_SPL_MINT = "a compressed NFT or a Core asset has no SPL mint and is not sent"

const amountSchema = z.string().regex(AMOUNT_PATTERN)

const extensionsSchema = z
  .array(z.object({ extension: z.string(), state: z.record(z.string(), z.unknown()).optional() }))
  .default([])

const mintInfoSchema = z.object({
  decimals: z.number().int().min(0).max(MAX_DECIMALS),
  supply: amountSchema,
  freezeAuthority: z.string().nullish(),
  isInitialized: z.boolean(),
  extensions: extensionsSchema,
})

const tokenAmountSchema = z.object({ amount: amountSchema })

const tokenAccountInfoSchema = z.object({
  mint: z.string(),
  owner: z.string(),
  tokenAmount: tokenAmountSchema,
  delegate: z.string().nullish(),
  delegatedAmount: tokenAmountSchema.nullish(),
  state: z.enum(["uninitialized", "initialized", "frozen"]),
  extensions: extensionsSchema,
})

function toExtensions(list: { extension: string; state?: Record<string, unknown> }[]): TokenExtension[] {
  return list.map(({ extension, state }) => ({ name: extension, state: state ?? {} }))
}

function isTokenOwned(account: SolanaAccount): boolean {
  return TOKEN_PROGRAMS.includes(account.owner)
}

/**
 * The facts of the token mint at `mint`. An address with no account, an account a token program does not own (a
 * compressed or Core asset has no mint) and a token account or multisig are `invalid_argument`: "not a token mint".
 */
export async function mintFacts(client: JsonRpcClient, mint: string): Promise<MintFacts> {
  const account = await accountOf(client, mint)
  const notAMint = new ToolError(
    "invalid_argument",
    `The address ${mint} on ${client.name} is not a token mint: ${account === null ? "no account is there" : "the account is not a Token or Token-2022 mint"}; ${NO_SPL_MINT}.`,
  )
  if (account === null || !isTokenOwned(account)) throw notAMint
  if (account.parsed === undefined) throw unreadable(client, METHOD, "a parsed token account")
  if (account.parsed.type !== "mint") throw notAMint
  const info = mintInfoSchema.safeParse(account.parsed.info)
  if (!info.success) throw unreadable(client, METHOD, "a token mint")
  if (!info.data.isInitialized) throw notAMint
  const { decimals, supply, freezeAuthority, extensions } = info.data
  return {
    program: account.owner,
    decimals,
    supply: BigInt(supply),
    freezeAuthority: freezeAuthority ?? null,
    extensions: toExtensions(extensions),
  }
}

/**
 * The facts of the token account at `address`; `null` when there is no account. An account that is not an initialized
 * token account of a token program is `invalid_argument`.
 */
export async function tokenAccountFacts(client: JsonRpcClient, address: string): Promise<TokenAccountFacts | null> {
  const account = await accountOf(client, address)
  if (account === null) return null
  const notAnAccount = new ToolError(
    "invalid_argument",
    `The address ${address} on ${client.name} is not an initialized token account.`,
  )
  if (!isTokenOwned(account)) throw notAnAccount
  if (account.parsed === undefined) throw unreadable(client, METHOD, "a parsed token account")
  if (account.parsed.type !== "account") throw notAnAccount
  const info = tokenAccountInfoSchema.safeParse(account.parsed.info)
  if (!info.success) throw unreadable(client, METHOD, "a token account")
  const { mint, owner, tokenAmount, delegate, delegatedAmount, state, extensions } = info.data
  if (state === "uninitialized") throw notAnAccount
  return {
    mint,
    owner,
    amount: BigInt(tokenAmount.amount),
    delegate: delegate ?? null,
    delegatedAmount: BigInt(delegatedAmount?.amount ?? "0"),
    state,
    extensions: toExtensions(extensions),
  }
}

/**
 * What the Token Metadata account of `mint` says: its declared symbol and token standard. `null` when the mint has none
 * (the address holds no account of Token Metadata's); an account whose data cannot be read is `upstream_error`.
 */
export async function metadataFacts(client: JsonRpcClient, mint: string): Promise<MetadataFacts | null> {
  const account = await rawAccountOf(client, metadataAddress(mint))
  if (account?.owner !== SOLANA_PROGRAMS.tokenMetadataProgram || account.data === undefined) return null
  return metadataTokenStandard(account.data)
}
