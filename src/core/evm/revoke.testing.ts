import { defineEvmRevoke } from "./revoke"
import { makeEvmToolRig, MAX_FEE, TOKEN_ADDRESS, type EvmToolRig, type RigOptions } from "./send.testing"
import { HARDHAT_ADDRESS_1 } from "./testing.sign"

/** The address whose approval the fixtures revoke: Hardhat's second account. */
export const SPENDER_ADDRESS = HARDHAT_ADDRESS_1

/** The rig of `web3_evm_revoke`; see `makeEvmToolRig` for what it is set up with. */
export type RevokeRig = EvmToolRig<ReturnType<typeof defineEvmRevoke>>

/** A rig of `web3_evm_revoke`. */
export function makeRevokeRig(options: RigOptions = {}): RevokeRig {
  return makeEvmToolRig(defineEvmRevoke, options)
}

/** The raw arguments of the revoke of `SPENDER_ADDRESS`'s approval of `TOKEN_ADDRESS`, by the wallet `main`. */
export function revokeArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chain: "ethereum",
    account: "main",
    token: TOKEN_ADDRESS,
    spender: SPENDER_ADDRESS,
    max_fee: MAX_FEE,
    ...changes,
  }
}
