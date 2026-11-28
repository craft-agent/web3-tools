import { parseAmount, parseUnits } from "../amount"
import { evmChain, type EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import { evmClient, type JsonRpcClient, type RpcDeps } from "../rpc/client"
import { requireRuntime, type ToolRuntime } from "../runtime"
import { resolveAccount } from "../signer/accounts"
import type { ToolContext } from "../tool"
import { parseEvmAddress } from "./address"
import { erc1155SafeTransferFrom, erc20Transfer, erc721SafeTransferFrom } from "./calls"
import { promptSymbol, tokenFacts, type EvmCall } from "./reads"
import { nftFacts, parseCount, parseTokenId } from "./send.nft"
import type { EvmSendArgs } from "./send.schema"

/** What a send reaches the chain and the wallets through: the chain, a client for it, and the call's runtime and state directory. */
export type SendEnv = { chain: EvmChain; client: JsonRpcClient; runtime: ToolRuntime; stateDir: string }

/** The account that sends: wallet `label`, its index in a seed phrase (`null` for a lone key) and its address. */
export type SendSender = { label: string; index: number | null; address: string }

/** What a send moves: the native coin, an ERC-20 token, or NFTs of an ERC-721 or ERC-1155 collection. */
export type SendKind = "native" | "erc20" | "erc721" | "erc1155"

/** What the ledger records of a write: the kind of its row, who it is for, the token and the amount in digits. */
export type LedgerEntry = { kind: string; recipient: string; token: string | null; amount: string }

/** The part of a write that is signed and recorded, whichever tool built it. */
export type LockedPlan = {
  sender: SendSender
  /** The transaction to sign. */
  call: EvmCall
  /** The ceiling on the whole fee, in wei. */
  maxFee: bigint
  ledger: LedgerEntry
}

/** Everything a send is, resolved once: the one transaction `describe`, `gate` and `execute` all mean. */
export type SendPlan = {
  chain: EvmChain
  sender: SendSender
  /** The recipient in checksum case. */
  recipient: string
  kind: SendKind
  /** The token's or the collection's address in checksum case; `null` for the native coin. */
  token: string | null
  /** 0 for an NFT, which is counted. */
  decimals: number
  /** The native coin's symbol, or the token's or collection's declared symbol when a prompt may show it. */
  symbol: string | null
  /** The amount in the smallest unit; for an NFT, how many. */
  units: bigint
  /** The NFT's id; `null` unless an NFT is sent. */
  tokenId: bigint | null
  /** The ceiling on the whole fee, in wei. */
  maxFee: bigint
  /** The transaction to sign: a native transfer, the token's `transfer`, or the collection's `safeTransferFrom`. */
  call: EvmCall
}

/** A send of NFTs: the collection and the id are there. */
export type NftSendPlan = SendPlan & { kind: "erc721" | "erc1155"; token: string; tokenId: bigint }

/** Whether `plan` sends NFTs. */
export function isNftSend(plan: SendPlan): plan is NftSendPlan {
  return (plan.kind === "erc721" || plan.kind === "erc1155") && plan.token !== null && plan.tokenId !== null
}

export const SEND_SUBJECT = "Sends"

/** The chain, its client and the call's runtime; the client is cancelled with the call. */
export function sendEnv(chainKey: string, ctx: ToolContext, deps: RpcDeps): SendEnv {
  const { runtime, stateDir } = requireRuntime(ctx, SEND_SUBJECT)
  const chain = evmChain(chainKey)
  return { chain, client: evmClient(chain, { ...deps, signal: ctx.signal }), runtime, stateDir }
}

/** The checksum form of an address argument; a name or anything else that is not a 0x address is `invalid_argument`. */
export function parseAddressArgument(text: string, name: string): string {
  if (!/^0x/i.test(text)) {
    throw new ToolError("invalid_argument", `The ${name} must be a 0x address, not a name; give the address.`)
  }
  return parseEvmAddress(text)
}

/** What a send signs and records, as the part every write shares. */
export function lockedPlanOf({ sender, call, maxFee, kind, recipient, token, units }: SendPlan): LockedPlan {
  return { sender, call, maxFee, ledger: { kind, recipient, token, amount: String(units) } }
}

type SendBase = Pick<SendPlan, "chain" | "sender" | "recipient" | "maxFee">

type NftArguments = { collection: string; tokenId: bigint; units: bigint }

/** The send of `units` of the NFT `tokenId` of `collection`, in the standard the collection declares. */
async function buildNftSend(
  env: SendEnv,
  base: SendBase,
  { collection, tokenId, units }: NftArguments,
): Promise<SendPlan> {
  const { sender, recipient } = base
  const { standard, symbol } = await nftFacts(env.client, collection)
  const data =
    standard === "erc721"
      ? erc721SafeTransferFrom(sender.address, recipient, tokenId)
      : erc1155SafeTransferFrom(sender.address, recipient, tokenId, units)
  const call = { from: sender.address, to: collection, value: 0n, data }
  return { ...base, kind: standard, token: collection, decimals: 0, symbol, units, tokenId, call }
}

/** The transaction a call to `execute` would sign, from the arguments and the chain as it stands. */
export async function buildSend(args: EvmSendArgs, env: SendEnv): Promise<SendPlan> {
  const { chain, client, runtime, stateDir } = env
  const sender = await resolveAccount(args.account, "evm", runtime, stateDir)
  const recipient = parseAddressArgument(args.to, "recipient")
  const maxFee = parseUnits(args.max_fee, "max_fee")
  if (args.token_id !== undefined) {
    if (args.token === undefined) {
      throw new ToolError("invalid_argument", "A token_id needs the token argument: the NFT collection's 0x address.")
    }
    const nft = {
      tokenId: parseTokenId(args.token_id),
      units: parseCount(args.amount),
      collection: parseAddressArgument(args.token, "token"),
    }
    return buildNftSend(env, { chain, sender, recipient, maxFee }, nft)
  }
  if (args.token === undefined) {
    const units = parseAmount(args.amount, chain.native.decimals)
    const call = { from: sender.address, to: recipient, value: units, data: "0x" }
    return {
      chain,
      sender,
      recipient,
      kind: "native",
      token: null,
      decimals: chain.native.decimals,
      symbol: chain.native.symbol,
      units,
      tokenId: null,
      maxFee,
      call,
    }
  }
  const token = parseAddressArgument(args.token, "token")
  const facts = await tokenFacts(client, token)
  const units = parseAmount(args.amount, facts.decimals)
  const call = { from: sender.address, to: token, value: 0n, data: erc20Transfer(recipient, units) }
  return {
    chain,
    sender,
    recipient,
    kind: "erc20",
    token,
    decimals: facts.decimals,
    symbol: promptSymbol(facts.symbol),
    units,
    tokenId: null,
    maxFee,
    call,
  }
}
