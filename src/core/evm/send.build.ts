import { parseAmount, parseUnits } from "../amount"
import { evmChain, type EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import { evmClient, type JsonRpcClient, type RpcDeps } from "../rpc/client"
import { requireRuntime, type ToolRuntime } from "../runtime"
import { resolveAccount } from "../signer/accounts"
import type { ToolContext } from "../tool"
import { parseEvmAddress } from "./address"
import { erc20Transfer } from "./calls"
import { promptSymbol, tokenFacts, type EvmCall } from "./reads"
import type { EvmSendArgs } from "./send.schema"

/** What a send reaches the chain and the wallets through: the chain, a client for it, and the call's runtime and state directory. */
export type SendEnv = { chain: EvmChain; client: JsonRpcClient; runtime: ToolRuntime; stateDir: string }

/** The account that sends: wallet `label`, its index in a seed phrase (`null` for a lone key) and its address. */
export type SendSender = { label: string; index: number | null; address: string }

/** Everything a send is, resolved once: the one transaction `describe`, `gate` and `execute` all mean. */
export type SendPlan = {
  chain: EvmChain
  sender: SendSender
  /** The recipient in checksum case. */
  recipient: string
  /** The token's address in checksum case; `null` for the native coin. */
  token: string | null
  decimals: number
  /** The native coin's symbol, or the token's declared symbol when a prompt may show it. */
  symbol: string | null
  /** The amount in the smallest unit. */
  units: bigint
  /** The ceiling on the whole fee, in wei. */
  maxFee: bigint
  /** The transaction to sign: a native transfer, or the token's `transfer`. */
  call: EvmCall
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

/** The transaction a call to `execute` would sign, from the arguments and the chain as it stands. */
export async function buildSend(args: EvmSendArgs, env: SendEnv): Promise<SendPlan> {
  const { chain, client, runtime, stateDir } = env
  const sender = await resolveAccount(args.account, "evm", runtime, stateDir)
  const recipient = parseAddressArgument(args.to, "recipient")
  const maxFee = parseUnits(args.max_fee, "max_fee")
  if (args.token === undefined) {
    const units = parseAmount(args.amount, chain.native.decimals)
    const call = { from: sender.address, to: recipient, value: units, data: "0x" }
    return {
      chain,
      sender,
      recipient,
      token: null,
      decimals: chain.native.decimals,
      symbol: chain.native.symbol,
      units,
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
    token,
    decimals: facts.decimals,
    symbol: promptSymbol(facts.symbol),
    units,
    maxFee,
    call,
  }
}
