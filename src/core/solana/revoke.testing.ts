import { defineSolanaRevoke } from "./revoke"
import {
  MAIN_ADDRESS,
  MAIN_TOKENS,
  makeSolanaToolRig,
  MAX_FEE,
  MINT,
  type RigOptions,
  type SolanaToolRig,
} from "./send.testing"
import { testAddress } from "./testing"

/** The address `main`'s token account of `MINT` names as its delegate, for the rigs of revokes. */
export const DELEGATE = testAddress(9)

/** What the delegate may still move, in the smallest unit of `MINT`: it moves with every spend, so no prompt shows it. */
export const DELEGATED_AMOUNT = 50n

/** The rig of `web3_solana_revoke`; see `makeSolanaToolRig` for what it is set up with. */
export type RevokeRig = SolanaToolRig<ReturnType<typeof defineSolanaRevoke>>

/** A rig of `web3_solana_revoke` whose token account of `main` for `MINT` has `DELEGATE` as its delegate. */
export function makeRevokeRig(options: RigOptions = {}): RevokeRig {
  const rig = makeSolanaToolRig(defineSolanaRevoke, options)
  rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, {
    amount: MAIN_TOKENS,
    delegate: DELEGATE,
    delegatedAmount: DELEGATED_AMOUNT,
  })
  return rig
}

/** The raw arguments of the revoke of the delegate of `main`'s token account for `MINT`. */
export function revokeArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { chain: "solana", account: "main", mint: MINT, max_fee: MAX_FEE, ...changes }
}
