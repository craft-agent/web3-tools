import { parseUnits } from "../amount"
import type { SolanaChain } from "../chains/solana"
import { ToolError } from "../errors"
import { resolveAccount } from "../signer/accounts"
import type { WriteSender } from "../write/types"
import { associatedTokenAddress, parseSolanaAddress } from "./address"
import { revoke, type SolanaInstruction } from "./instructions"
import { metadataFacts, mintFacts, tokenAccountFacts } from "./reads.token"
import type { SolanaRevokeArgs } from "./revoke.schema"
import type { LockedPlan, SendEnv } from "./send.build"
import { tokenPromptSymbol } from "./token-rules"

/** Everything a revoke is, resolved once: the one transaction `describe`, `gate` and `execute` all mean. */
export type RevokePlan = {
  chain: SolanaChain
  sender: WriteSender
  /** The token mint, in base58. */
  mint: string
  /** The address the sender's token account approved to move its tokens. */
  delegate: string
  /** The declared symbol of the token when a prompt may show it. */
  symbol: string | null
  /** The ceiling on the whole fee, in lamports. */
  maxFee: bigint
  /** The instructions to sign, without the compute budget: the token account's `Revoke`. */
  instructions: SolanaInstruction[]
}

function refusal(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** What a revoke signs and records, as the part every write shares: a row for the delegate, with nothing moved. */
export function lockedRevoke({ sender, instructions, maxFee, delegate, mint }: RevokePlan): LockedPlan {
  return { sender, instructions, maxFee, ledger: { kind: "revoke", recipient: delegate, token: mint, amount: "0" } }
}

/**
 * The revoke the arguments mean, from the cluster as it stands: the delegate of the sender's associated token account
 * for the mint, under the mint's own token program. No such token account, or one without a delegate, is
 * `invalid_argument`; a read that fails stops the call, so "nothing to revoke" never stands for "not read". A delegate
 * on any other token account of the wallet is not covered.
 */
export async function buildRevoke(args: SolanaRevokeArgs, env: SendEnv): Promise<RevokePlan> {
  const { chain, client, runtime, stateDir } = env
  const sender = await resolveAccount(args.account, "solana", runtime, stateDir)
  const mint = parseSolanaAddress(args.mint, "mint")
  const maxFee = parseUnits(args.max_fee, "max_fee")
  const facts = await mintFacts(client, mint)
  const account = associatedTokenAddress(sender.address, mint, facts.program)
  const held = await tokenAccountFacts(client, account)
  if (held === null) throw refusal(`${sender.address} has no token account for ${mint}.`)
  if (held.delegate === null)
    throw refusal(`${sender.address} has no delegate to revoke on its token account for ${mint}.`)
  return {
    chain,
    sender,
    mint,
    delegate: held.delegate,
    symbol: tokenPromptSymbol(facts, await metadataFacts(client, mint)),
    maxFee,
    instructions: [revoke(facts.program, account, sender.address)],
  }
}
