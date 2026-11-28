import { base58 } from "@scure/base"
import { formatAmount, parseAmount, parseUnits } from "../amount"
import { solanaChain, type SolanaChain } from "../chains/solana"
import { ToolError } from "../errors"
import { solanaClient, type JsonRpcClient, type RpcDeps } from "../rpc/client"
import { requireRuntime, type ToolRuntime } from "../runtime"
import { resolveAccount } from "../signer/accounts"
import type { ToolContext } from "../tool"
import { SEND_SUBJECT, type LedgerEntry, type WriteSender } from "../write/types"
import {
  associatedTokenAddress,
  isOnCurve,
  parseSolanaAddress,
  SOLANA_ADDRESS_BYTES,
  solanaAddressBytes,
} from "./address"
import type { ComputeBudget } from "./fees"
import {
  createIdempotentAta,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
  type SolanaInstruction,
} from "./instructions"
import type { SolanaMessage } from "./message"
import { accountOf, classifyRecipient, type RecipientKind } from "./reads"
import { metadataFacts, mintFacts, tokenAccountFacts } from "./reads.token"
import type { SolanaSendArgs } from "./send.schema"
import { checkTransferable, tokenPromptSymbol } from "./token-rules"

/** What a send reaches the cluster and the wallets through: the cluster, a client for it, and the call's runtime and state directory. */
export type SendEnv = {
  chain: SolanaChain
  client: JsonRpcClient
  runtime: ToolRuntime
  stateDir: string
}

/** What a send moves: SOL, or an SPL token. */
export type SendKind = "sol" | "spl"

/** The part of a write that is signed and recorded, whichever tool built it. */
export type LockedPlan = {
  sender: WriteSender
  /** The instructions to sign, without the compute budget, which is set when the transaction is signed. */
  instructions: SolanaInstruction[]
  /** The ceiling on the whole fee, in lamports. */
  maxFee: bigint
  ledger: LedgerEntry
}

/** Everything a send is, resolved once: the one transaction `describe`, `gate` and `execute` all mean. */
export type SendPlan = {
  chain: SolanaChain
  sender: WriteSender
  /** The wallet that receives: for a token, the owner of the token account. */
  recipient: string
  /** Whether the recipient has no account yet. */
  recipientIsNew: boolean
  kind: SendKind
  /** The token mint; `null` for SOL. */
  mint: string | null
  /** The token account the instructions make for the recipient, because it is missing now; `null` when none is made. */
  createdAccount: string | null
  /** The mint's permanent delegate, who can move any holder's tokens; `null` when it has none. */
  permanentDelegate: string | null
  decimals: number
  /** SOL, or the token's declared symbol when a prompt may show it. */
  symbol: string | null
  /** The amount in the smallest unit. */
  units: bigint
  /** The ceiling on the whole fee, in lamports. */
  maxFee: bigint
  /** The instructions to sign, without the compute budget. */
  instructions: SolanaInstruction[]
}

/** The blockhash a message is simulated with: the cluster replaces it, so only its shape counts. */
export const SIMULATED_BLOCKHASH = base58.encode(new Uint8Array(SOLANA_ADDRESS_BYTES))

/** What each kind of recipient that cannot be sent to is, as a reason the refusal gives. */
const REFUSED_RECIPIENTS: Readonly<Record<Exclude<RecipientKind, "new" | "wallet">, string>> = {
  program: "a program, which may keep what is sent to it for good; give a wallet address",
  token_account: "a token account; give the owner's wallet address, and its token account is found or made",
  mint: "a token mint; give the owner's wallet address",
  nonce: "a nonce account, which cannot spend what it receives; give a wallet address",
  other: "an account that another program owns or that holds data; give a wallet address",
}

function refusal(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** The cluster, its client and the call's runtime; the client is cancelled with the call. */
export function sendEnv(chainKey: string, ctx: ToolContext, deps: RpcDeps): SendEnv {
  const { runtime, stateDir } = requireRuntime(ctx, SEND_SUBJECT)
  const chain = solanaChain(chainKey)
  return { chain, client: solanaClient(chain, { ...deps, signal: ctx.signal }), runtime, stateDir }
}

/** What a send signs and records, as the part every write shares. */
export function lockedPlanOf({ sender, instructions, maxFee, kind, recipient, mint, units }: SendPlan): LockedPlan {
  return { sender, instructions, maxFee, ledger: { kind, recipient, token: mint, amount: String(units) } }
}

/** The message of `plan` dated by `blockhash`, with the compute budget `budget` set before its instructions. */
export function messageOf(
  { sender, instructions }: LockedPlan,
  blockhash: string,
  budget: ComputeBudget,
): SolanaMessage {
  return {
    feePayer: sender.address,
    recentBlockhash: blockhash,
    instructions: [setComputeUnitLimit(budget.unitLimit), setComputeUnitPrice(budget.unitPrice), ...instructions],
  }
}

/** The accounts the plan's instructions write to besides its fee payer, which prioritization fees are priced on. */
export function writableOf({ sender, instructions }: LockedPlan): string[] {
  const writable = instructions.flatMap(({ accounts }) => accounts.filter((meta) => meta.writable))
  return [...new Set([sender.address, ...writable.map((meta) => meta.address)])]
}

/** The recipient as the cluster holds it: refused unless it is a wallet, or an address with no account that a key can own. */
async function checkRecipient(
  { client }: SendEnv,
  recipient: string,
  sender: WriteSender,
): Promise<{ isNew: boolean }> {
  if (recipient === sender.address) {
    throw refusal("The recipient is the sending wallet itself; a send to oneself moves nothing.")
  }
  const kind = classifyRecipient(await accountOf(client, recipient))
  if (kind === "wallet") return { isNew: false }
  if (kind !== "new") throw refusal(`The recipient ${recipient} is ${REFUSED_RECIPIENTS[kind]}.`)
  if (!isOnCurve(solanaAddressBytes(recipient, "recipient"))) {
    throw refusal(
      `The recipient ${recipient} has no account and is not an address a key can own, so anything sent to it would be lost; give a wallet address.`,
    )
  }
  return { isNew: true }
}

type SendBase = Pick<SendPlan, "chain" | "sender" | "recipient" | "recipientIsNew" | "maxFee">

function buildSolSend(chain: SolanaChain, base: SendBase, amount: string): SendPlan {
  const { decimals, symbol } = chain.native
  const units = parseAmount(amount, decimals)
  const instructions = [systemTransfer(base.sender.address, base.recipient, units)]
  return {
    ...base,
    kind: "sol",
    mint: null,
    createdAccount: null,
    permanentDelegate: null,
    decimals,
    symbol,
    units,
    instructions,
  }
}

async function buildTokenSend({ client }: SendEnv, base: SendBase, mint: string, amount: string): Promise<SendPlan> {
  const { sender, recipient } = base
  const facts = await mintFacts(client, mint)
  const units = parseAmount(amount, facts.decimals)
  const sourceAccount = associatedTokenAddress(sender.address, mint, facts.program)
  const destinationAccount = associatedTokenAddress(recipient, mint, facts.program)
  const source = await tokenAccountFacts(client, sourceAccount)
  if (source === null) {
    throw refusal(`${sender.address} holds none of the token ${mint}: it has no token account for it.`)
  }
  if (source.amount < units) {
    throw refusal(
      `${sender.address} holds ${formatAmount(source.amount, facts.decimals)} of the token ${mint} (${source.amount} in its smallest unit), less than the ${formatAmount(units, facts.decimals)} to send. Send a smaller amount.`,
    )
  }
  const destination = await tokenAccountFacts(client, destinationAccount)
  const { permanentDelegate } = checkTransferable(facts, source, destination)
  const symbol = tokenPromptSymbol(facts, await metadataFacts(client, mint))
  const instructions = [
    createIdempotentAta(sender.address, destinationAccount, recipient, mint, facts.program),
    transferChecked(facts.program, sourceAccount, mint, destinationAccount, sender.address, units, facts.decimals),
  ]
  return {
    ...base,
    kind: "spl",
    mint,
    createdAccount: destination === null ? destinationAccount : null,
    permanentDelegate,
    decimals: facts.decimals,
    symbol,
    units,
    instructions,
  }
}

/**
 * The transaction a call to `execute` would sign, from the arguments and the cluster as it stands. The sender has a
 * key here, the recipient is a wallet other than the sender, a token is a mint the token rules allow whose sender
 * holds the amount, and the amount is no more precise than the token: else `invalid_argument`.
 */
export async function buildSend(args: SolanaSendArgs, env: SendEnv): Promise<SendPlan> {
  const { chain, runtime, stateDir } = env
  const sender = await resolveAccount(args.account, "solana", runtime, stateDir)
  const recipient = parseSolanaAddress(args.to, "recipient")
  const mint = args.mint === undefined ? undefined : parseSolanaAddress(args.mint, "mint")
  const maxFee = parseUnits(args.max_fee, "max_fee")
  const { isNew } = await checkRecipient(env, recipient, sender)
  const base = { chain, sender, recipient, recipientIsNew: isNew, maxFee }
  return mint === undefined ? buildSolSend(chain, base, args.amount) : buildTokenSend(env, base, mint, args.amount)
}
