import { base58, base64 } from "@scure/base"
import { z } from "zod"
import { SOLANA_PROGRAMS, TOKEN_PROGRAMS } from "../chains/solana"
import { ToolError } from "../errors"
import type { JsonRpcClient } from "../rpc/client"
import { isPlainObject } from "../rpc/mask"
import { SOLANA_ADDRESS_BYTES } from "./address"

/** The commitment every read is made at. */
const COMMITMENT = { commitment: "confirmed" } as const

/** The size of a nonce account: the System program owns it, and SOL sent to it is not spendable. */
const NONCE_ACCOUNT_BYTES = 80

/** A refusal quotes the cluster's error up to this many characters of JSON. */
const MAX_ERROR_CHARS = 200

/** A refusal quotes this many of the last log lines, each up to {@link MAX_ERROR_CHARS} characters. */
const MAX_LOG_LINES = 6

/** A whole number from 0, as JSON carries it: above 2^53 it is a float and inexact, which no lamport figure read here depends on. */
const wholeNumber = z.number().refine((value) => Number.isInteger(value) && value >= 0)

function isBase58Of32Bytes(text: string): boolean {
  try {
    return base58.decode(text).length === SOLANA_ADDRESS_BYTES
  } catch {
    return false
  }
}

const parsedDataSchema = z.object({
  program: z.string(),
  parsed: z.object({ type: z.string(), info: z.unknown() }),
  space: wholeNumber.optional(),
})

const accountValueSchema = z.object({
  lamports: wholeNumber,
  owner: z.string(),
  executable: z.boolean(),
  space: wholeNumber.optional(),
  data: z.union([z.tuple([z.string(), z.literal("base64")]), parsedDataSchema]),
})

const statusSchema = z.object({
  slot: wholeNumber,
  confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullish(),
  err: z.unknown().optional(),
})

const simulationSchema = z.object({
  value: z.object({
    err: z.unknown().optional(),
    logs: z.array(z.string()).nullish(),
    unitsConsumed: wholeNumber.optional(),
  }),
})

/** What the node parsed of an account's data (`jsonParsed`): the program's name, the kind of account and its fields. */
export type ParsedAccountData = { program: string; type: string; info: Record<string, unknown> }

/** An account as the cluster holds it. */
export type SolanaAccount = {
  lamports: bigint
  /** The program that owns the account. */
  owner: string
  executable: boolean
  /** The bytes of data the account holds. */
  space: number
  /** What the node parsed of the data, when it knows the owner's layout. */
  parsed?: ParsedAccountData
  /** The raw data, when the node answered it (always from {@link rawAccountOf}). */
  data?: Uint8Array
}

/** What recipient an address is: see {@link classifyRecipient}. */
export type RecipientKind = "new" | "wallet" | "program" | "token_account" | "mint" | "nonce" | "other"

/** How a cluster's own answer ended: its slot, how settled it is and its error, `null` when it succeeded. */
export type SignatureStatus = {
  slot: bigint
  confirmationStatus: "processed" | "confirmed" | "finalized" | null
  err: unknown
}

/** What a dry run of a transaction cost and said. */
export type Simulation = { unitsConsumed: number; logs: string[] }

/** The blockhash a transaction is dated by and the last block height it may land at. */
export type LatestBlockhash = { blockhash: string; lastValidBlockHeight: bigint }

/** The `upstream_error` for an answer of `method` that is not `noun`, naming the cluster and never quoting the answer. */
export function unreadable(client: JsonRpcClient, method: string, noun: string): ToolError {
  return new ToolError("upstream_error", `${client.name} answered ${method} with something that is not ${noun}.`)
}

/**
 * Calls `method` and checks the answer against `schema`; an answer of another shape is `upstream_error` naming the
 * cluster, the method and what was expected (`noun`), and never quoting the answer.
 */
export async function readAnswer<T>(
  client: JsonRpcClient,
  method: string,
  params: readonly unknown[],
  schema: z.ZodType<T>,
  noun: string,
): Promise<T> {
  const parsed = schema.safeParse(await client.call<unknown>(method, params))
  if (!parsed.success) throw unreadable(client, method, noun)
  return parsed.data
}

function decodeData(client: JsonRpcClient, text: string): Uint8Array {
  try {
    return base64.decode(text)
  } catch {
    throw unreadable(client, "getAccountInfo", "account data")
  }
}

async function fetchAccount(
  client: JsonRpcClient,
  address: string,
  encoding: "jsonParsed" | "base64",
): Promise<SolanaAccount | null> {
  const schema = z.object({ value: accountValueSchema.nullable() })
  const { value } = await readAnswer(
    client,
    "getAccountInfo",
    [address, { ...COMMITMENT, encoding }],
    schema,
    "an account",
  )
  if (value === null) return null
  const { lamports, owner, executable, data } = value
  const base = { lamports: BigInt(lamports), owner, executable }
  if (Array.isArray(data)) {
    const bytes = decodeData(client, data[0])
    return { ...base, space: value.space ?? bytes.length, data: bytes }
  }
  if (encoding === "base64") throw unreadable(client, "getAccountInfo", "raw account data")
  const { program, parsed, space } = data
  const info = isPlainObject(parsed.info) ? parsed.info : {}
  const knownSpace = value.space ?? space
  if (knownSpace === undefined) throw unreadable(client, "getAccountInfo", "an account with a size")
  return { ...base, space: knownSpace, parsed: { program, type: parsed.type, info } }
}

/**
 * The account at `address`, with its data parsed when the node knows the owner's layout and as raw bytes when it does
 * not; `null` when there is none.
 */
export function accountOf(client: JsonRpcClient, address: string): Promise<SolanaAccount | null> {
  return fetchAccount(client, address, "jsonParsed")
}

/** The account at `address` with its raw data (`encoding: "base64"`), for layouts the node does not parse; `null` when there is none. */
export function rawAccountOf(client: JsonRpcClient, address: string): Promise<SolanaAccount | null> {
  return fetchAccount(client, address, "base64")
}

/**
 * What kind of recipient `account`, as {@link accountOf} read it, is. Only `"new"` (no account) and `"wallet"` (the
 * System program owns it, it holds no data and is not executable) can be sent to; for a new address the caller checks
 * it is on the curve. The rest are refusals, each its own kind: a `"program"`, a `"token_account"`, a `"mint"`, a
 * `"nonce"` account (the System program's, 80 bytes) and `"other"`, which is any other owner or data.
 */
export function classifyRecipient(account: SolanaAccount | null): RecipientKind {
  if (account === null) return "new"
  if (account.executable) return "program"
  if (TOKEN_PROGRAMS.includes(account.owner)) {
    if (account.parsed?.type === "account") return "token_account"
    return account.parsed?.type === "mint" ? "mint" : "other"
  }
  if (account.owner !== SOLANA_PROGRAMS.systemProgram) return "other"
  if (account.space === 0) return "wallet"
  return account.space === NONCE_ACCOUNT_BYTES ? "nonce" : "other"
}

/** The lamports of `address`; 0 for an address with no account. */
export async function balanceOf(client: JsonRpcClient, address: string): Promise<bigint> {
  const { value } = await readAnswer(
    client,
    "getBalance",
    [address, COMMITMENT],
    z.object({ value: wholeNumber }),
    "a balance",
  )
  return BigInt(value)
}

/** The lamports an account of `space` bytes must hold to be rent exempt, at the rate the cluster has now. */
export async function rentExemptMinimum(client: JsonRpcClient, space: number): Promise<bigint> {
  const lamports = await readAnswer(
    client,
    "getMinimumBalanceForRentExemption",
    [space, COMMITMENT],
    wholeNumber,
    "a number of lamports",
  )
  return BigInt(lamports)
}

/** The blockhash to date a transaction by and the last block height at which the cluster still takes it. */
export async function latestBlockhash(client: JsonRpcClient): Promise<LatestBlockhash> {
  const schema = z.object({
    value: z.object({ blockhash: z.string().refine(isBase58Of32Bytes), lastValidBlockHeight: wholeNumber }),
  })
  const { value } = await readAnswer(client, "getLatestBlockhash", [COMMITMENT], schema, "a blockhash")
  return { blockhash: value.blockhash, lastValidBlockHeight: BigInt(value.lastValidBlockHeight) }
}

/** The cluster's block height now. */
export async function blockHeight(client: JsonRpcClient): Promise<bigint> {
  return BigInt(await readAnswer(client, "getBlockHeight", [COMMITMENT], wholeNumber, "a block height"))
}

/** What the cluster says of `signature`, searching its history; `null` when it does not know it. */
export async function signatureStatus(client: JsonRpcClient, signature: string): Promise<SignatureStatus | null> {
  const schema = z.object({ value: z.array(statusSchema.nullable()).length(1) })
  const { value } = await readAnswer(
    client,
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
    schema,
    "a signature status",
  )
  const [status] = value
  if (status === null) return null
  return { slot: BigInt(status.slot), confirmationStatus: status.confirmationStatus ?? null, err: status.err ?? null }
}

/**
 * The prices, in micro-lamports per compute unit, that recent blocks' transactions paid on the `writableAccounts`,
 * one for each block in the order the node answers; a block that took no priority fee is 0.
 */
export async function recentPriorityFees(
  client: JsonRpcClient,
  writableAccounts: readonly string[],
): Promise<bigint[]> {
  const schema = z.array(z.object({ slot: wholeNumber, prioritizationFee: wholeNumber }))
  const fees = await readAnswer(
    client,
    "getRecentPrioritizationFees",
    [writableAccounts],
    schema,
    "a list of prioritization fees",
  )
  return fees.map((fee) => BigInt(fee.prioritizationFee))
}

function refusalOf(err: unknown, logs: readonly string[]): ToolError {
  const reason = (JSON.stringify(err) ?? "null").slice(0, MAX_ERROR_CHARS)
  const lines = logs.slice(-MAX_LOG_LINES).map((line) => line.slice(0, MAX_ERROR_CHARS))
  const quoted = lines.length === 0 ? "" : `; ${JSON.stringify(lines)}`
  return new ToolError("invalid_argument", `The cluster would fail this transaction: ${reason}${quoted}`)
}

/**
 * Dry-runs the transaction `unsignedBase64` (zero signatures; the cluster neither checks them nor the blockhash) and
 * returns the compute units it consumed and its log. A transaction the cluster would fail is `invalid_argument`,
 * quoting its error as JSON up to 200 characters and its last six log lines: both are text from the network, data
 * to show, never instructions.
 */
export async function simulate(client: JsonRpcClient, unsignedBase64: string): Promise<Simulation> {
  const config = { ...COMMITMENT, sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" }
  const { value } = await readAnswer(
    client,
    "simulateTransaction",
    [unsignedBase64, config],
    simulationSchema,
    "a simulation",
  )
  const logs = value.logs ?? []
  if (value.err !== null && value.err !== undefined) throw refusalOf(value.err, logs)
  if (value.unitsConsumed === undefined) throw unreadable(client, "simulateTransaction", "a simulation with its units")
  return { unitsConsumed: value.unitsConsumed, logs }
}
