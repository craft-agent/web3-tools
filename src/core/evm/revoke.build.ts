import { parseUnits } from "../amount"
import type { EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import { resolveAccount } from "../signer/accounts"
import { erc20Approve, setApprovalForAll } from "./calls"
import { declaredSymbol, hasCode, promptSymbol, type EvmCall } from "./reads"
import { declaresDecimals, erc20Allowance, operatorApproved } from "./reads.approval"
import type { EvmRevokeArgs, REVOKED_KINDS } from "./revoke.schema"
import {
  parseAddressArgument,
  resolveAddressArgument,
  type LockedPlan,
  type SendEnv,
  type SendSender,
} from "./send.build"

/** What a revoke does: the allowance of an ERC-20 token set to 0, or an operator removed from a collection. */
export type RevokeKind = "revoke_erc20" | "revoke_operator"

/** Everything a revoke is, resolved once: the one transaction `describe`, `gate` and `execute` all mean. */
export type RevokePlan = {
  chain: EvmChain
  sender: SendSender
  /** The token's or the collection's address in checksum case. */
  token: string
  /** The spender or the operator, in checksum case: the address an ENS name resolved to, when one was given. */
  spender: string
  /** The ENS name the spender was given as, normalized; `null` for an address. */
  ens: string | null
  /** The declared symbol of the token or collection when a prompt may show it. */
  symbol: string | null
  kind: RevokeKind
  /** The ceiling on the whole fee, in wei. */
  maxFee: bigint
  /** The transaction to sign: the token's `approve(spender, 0)`, or the collection's `setApprovalForAll(spender, false)`. */
  call: EvmCall
}

/** What the kinds of a revoke take back, as the result names it. */
export const REVOKED: Readonly<Record<RevokeKind, (typeof REVOKED_KINDS)[number]>> = {
  revoke_erc20: "allowance",
  revoke_operator: "operator",
}

/** What a revoke signs and records, as the part every write shares: a row for the spender, with nothing moved. */
export function lockedRevoke({ sender, call, maxFee, kind, spender, token }: RevokePlan): LockedPlan {
  return { sender, call, maxFee, ledger: { kind, recipient: spender, token, amount: "0" } }
}

/**
 * The revoke the arguments mean, from the chain as it stands. A token that declares decimals and has an allowance
 * for the spender is revoked as an ERC-20; any other with the spender as an operator is revoked with
 * `setApprovalForAll`, so `approve(spender, 0)` is never sent to a collection (where it would approve token 0).
 * A view that reverts reads as 0 or false; a read that fails otherwise stops the call, so "nothing to revoke"
 * never stands for "not read". No code at the token, or no approval, is `invalid_argument`.
 */
export async function buildRevoke(args: EvmRevokeArgs, env: SendEnv): Promise<RevokePlan> {
  const { chain, client, runtime, stateDir } = env
  const sender = await resolveAccount(args.account, "evm", runtime, stateDir)
  const token = parseAddressArgument(args.token, "token")
  const { address: spender, ens } = await resolveAddressArgument(args.spender, "spender", env)
  const maxFee = parseUnits(args.max_fee, "max_fee")
  if (!(await hasCode(client, token))) {
    throw new ToolError("invalid_argument", `There is no contract at ${token} on ${client.name}.`)
  }
  const isErc20 =
    (await declaresDecimals(client, token)) && (await erc20Allowance(client, token, sender.address, spender)) !== 0n
  if (!isErc20 && !(await operatorApproved(client, token, sender.address, spender))) {
    throw new ToolError(
      "invalid_argument",
      `${sender.address} has no approval for ${spender} on ${token} to revoke on ${chain.name}.`,
    )
  }
  const data = isErc20 ? erc20Approve(spender, 0n) : setApprovalForAll(spender, false)
  return {
    chain,
    sender,
    token,
    spender,
    ens,
    symbol: promptSymbol(await declaredSymbol(client, token)),
    kind: isErc20 ? "revoke_erc20" : "revoke_operator",
    maxFee,
    call: { from: sender.address, to: token, value: 0n, data },
  }
}
