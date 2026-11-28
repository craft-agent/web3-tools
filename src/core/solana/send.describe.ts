import { bytesToHex } from "@noble/hashes/utils.js"
import { formatAmount } from "../amount"
import type { RpcDeps } from "../rpc/client"
import { ownAddresses, resolveAccount } from "../signer/accounts"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { contractValue, ownerFact } from "../write/describe"
import { parseSolanaAddress } from "./address"
import type { SolanaInstruction } from "./instructions"
import { buildSend, sendEnv, type SendEnv, type SendPlan } from "./send.build"
import { createdAccountRent } from "./send.gate"
import type { SolanaSendArgs } from "./send.schema"

/** The headline of a send: what it moves and where. A token with no symbol to show is named by its kind; an NFT, by its mint. */
function headlineOf({ chain, kind, mint, units, decimals, symbol }: SendPlan): CallHeadline {
  if (kind === "nft") return { text: "Send NFT {mint} on {chain}", values: { mint: mint!, chain: chain.name } }
  const amount = formatAmount(units, decimals)
  return symbol === null
    ? { text: "Send {amount} of a token on {chain}", values: { amount, chain: chain.name } }
    : { text: "Send {amount} {symbol} on {chain}", values: { amount, symbol, chain: chain.name } }
}

function tokenFact({ chain, mint, symbol }: SendPlan): CallFact {
  if (mint === null) {
    return {
      label: "Token",
      value: { text: "{chain}'s native coin {symbol}", values: { chain: chain.name, symbol: chain.native.symbol } },
    }
  }
  return {
    label: "Token",
    value:
      symbol === null
        ? { text: "{address}, whose declared symbol is not shown", values: { address: mint } }
        : contractValue(mint, symbol),
  }
}

/** The NFT a send moves: its mint, with the symbol it declares when a prompt may show it. */
function nftFact({ mint, symbol }: SendPlan): CallFact {
  return { label: "NFT", value: contractValue(mint!, symbol) }
}

function amountFact({ mint, symbol, units, decimals }: SendPlan): CallFact {
  const amount = formatAmount(units, decimals)
  if (mint === null) {
    return {
      label: "Amount",
      value: {
        text: "{amount} {symbol} ({units} lamports)",
        values: { amount, symbol: symbol ?? "", units: String(units) },
      },
    }
  }
  const values = { amount, units: String(units), decimals }
  return {
    label: "Amount",
    value:
      symbol === null
        ? { text: "{amount} ({units} smallest units, {decimals} decimals)", values }
        : { text: "{amount} {symbol} ({units} smallest units, {decimals} decimals)", values: { ...values, symbol } },
  }
}

/** What a send moves, as facts: the token and the amount, or the NFT alone, whose amount is always 1. */
function movedFacts(plan: SendPlan): CallFact[] {
  return plan.kind === "nft" ? [nftFact(plan)] : [tokenFact(plan), amountFact(plan)]
}

/** The ceiling on the whole fee, as the prompt shows it. */
export function feeFact({ chain, maxFee }: Pick<SendPlan, "chain" | "maxFee">): CallFact {
  return {
    label: "Max fee",
    value: {
      text: "{lamports} lamports ({amount} {symbol})",
      values: {
        lamports: String(maxFee),
        amount: formatAmount(maxFee, chain.native.decimals),
        symbol: chain.native.symbol,
      },
    },
  }
}

/** The facts of what the send does beyond moving the amount: the token account it creates, and a permanent delegate. */
async function extraFacts(env: SendEnv, plan: SendPlan): Promise<CallFact[]> {
  const facts: CallFact[] = []
  if (plan.createdAccount !== null) {
    const rent = String(await createdAccountRent(env, plan))
    facts.push({
      label: "Token account",
      value: { text: "created for the recipient, rent {rent} lamports", values: { rent } },
    })
  }
  if (plan.permanentDelegate !== null) {
    facts.push({
      label: "Permanent delegate",
      value: { text: "{address}, which can move any holder's tokens", values: { address: plan.permanentDelegate } },
    })
  }
  return facts
}

function instructionPin({ programId, accounts, data }: SolanaInstruction): string {
  return JSON.stringify({ program: programId, accounts, data: bytesToHex(data) })
}

/** What a description pins of a write: the chain, the sender and each instruction but the compute budget, which is set when the transaction is signed. */
export function pinsOf({
  chain,
  sender,
  instructions,
}: Pick<SendPlan, "chain" | "sender" | "instructions">): Record<string, string> {
  return {
    chain: chain.key,
    from: sender.address,
    ...Object.fromEntries(
      instructions.map((instruction, index) => [`instruction_${index}`, instructionPin(instruction)]),
    ),
  }
}

/**
 * What a send's prompt names as its targets: the sender and the recipient wallet, so an "always" answer covers that
 * pair only.
 */
export async function sendTargets(args: SolanaSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<string[]> {
  const env = sendEnv(args.chain, ctx, deps)
  const sender = await resolveAccount(args.account, "solana", env.runtime, env.stateDir)
  return [`from:${sender.address}`, `to:${parseSolanaAddress(args.to, "recipient")}`]
}

/**
 * What the send will do, for the person approving it: the recipient that counts, whether it is one of the person's
 * own wallets, the token and the amount (an NFT alone, whose amount is 1), a token account it creates, a permanent
 * delegate and the fee ceiling. Nothing that moves with the market is in it, so it is the same for the same
 * transaction; the pins hold what is signed: the chain, the sender and each instruction but the compute budget, which
 * is set when the transaction is signed.
 */
export async function describeSend(args: SolanaSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<CallDescription> {
  const env = sendEnv(args.chain, ctx, deps)
  const plan = await buildSend(args, env)
  const own = (await ownAddresses(env.runtime, env.stateDir)).solana.get(plan.recipient)
  return {
    headline: headlineOf(plan),
    facts: [
      { label: "Recipient", value: plan.recipient },
      ownerFact(own),
      ...movedFacts(plan),
      ...(await extraFacts(env, plan)),
      feeFact(plan),
    ],
    pins: pinsOf(plan),
  }
}
