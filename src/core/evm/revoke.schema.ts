import { z } from "zod"
import { SEND_OUTCOMES, sendInput } from "./send.schema"

/** What a revoke takes back: an ERC-20 token's allowance, or an operator's approval over all of a wallet's NFTs of a collection. */
export const REVOKED_KINDS = ["allowance", "operator"] as const

/** The arguments of `web3_evm_revoke`: whose approval of what, and the ceiling on the fee. */
export const revokeInput = z.object({
  chain: sendInput.shape.chain,
  account: sendInput.shape.account,
  token: z.string().describe("The ERC-20 token's or the NFT collection's 0x contract address."),
  spender: z
    .string()
    .describe("The 0x address whose approval is revoked: the spender of an ERC-20 allowance, or the operator of NFTs."),
  max_fee: sendInput.shape.max_fee,
})

/** The result of `web3_evm_revoke`. */
export const revokeOutput = z.object({
  chain: z.string().describe("The chain's key."),
  hash: z.string().describe("The transaction's hash."),
  outcome: z.enum(SEND_OUTCOMES).describe("confirmed, failed or pending."),
  ledger_row: z.string().describe("The id of the revoke's row in the ledger."),
  from: z.string().describe("The wallet's address, whose approval was revoked."),
  token: z.string().describe("The token's or the collection's address."),
  spender: z.string().describe("The address whose approval was revoked."),
  revoked: z.enum(REVOKED_KINDS).describe("allowance for an ERC-20 token, operator for an NFT collection."),
  block: z.string().nullable().describe("The block the transaction landed in; null while pending."),
  explorer: z.string().describe("The transaction's page on the chain's block explorer."),
})

/** The arguments of a revoke, as `invoke` hands them over. */
export type EvmRevokeArgs = z.output<typeof revokeInput>
