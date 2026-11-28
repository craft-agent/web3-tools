import { z } from "zod"
import { EVM_CHAIN_KEYS } from "../chains/evm"

/** What a send waits for: it lands and succeeds, lands and reverts (the fee is spent), or has no result yet. */
export const SEND_OUTCOMES = ["confirmed", "failed", "pending"] as const

/** The arguments of `web3_evm_send`: the whole change, and the ceiling on its fee. */
export const sendInput = z.object({
  chain: z.enum(EVM_CHAIN_KEYS).describe("The chain, by its key; there is no default."),
  account: z
    .string()
    .optional()
    .describe(
      "The sending wallet: its label, with #<index> for an account of a seed phrase (main#3). Left out, the only wallet.",
    ),
  to: z.string().describe("The recipient: a 0x address."),
  token: z.string().optional().describe("The token's 0x contract address; left out, the chain's native coin."),
  amount: z.string().describe("How much, as a decimal string in the token's own units, such as 1.5; never rounded."),
  max_fee: z
    .string()
    .describe(
      "The most the whole fee may cost, in wei, as digits. It must leave room above what the network asks now.",
    ),
})

/** The result of `web3_evm_send`. */
export const sendOutput = z.object({
  chain: z.string().describe("The chain's key."),
  hash: z.string().describe("The transaction's hash."),
  outcome: z.enum(SEND_OUTCOMES).describe("confirmed, failed or pending."),
  ledger_row: z.string().describe("The id of the send's row in the ledger."),
  from: z.string().describe("The sender's address."),
  to: z.string().describe("The recipient's address."),
  token: z.string().nullable().describe("The token's address; null for the native coin."),
  amount: z.string().describe("The amount sent, in the token's units."),
  symbol: z
    .string()
    .nullable()
    .describe("The native coin's symbol, or the token's declared symbol; null when it has none to show."),
  block: z.string().nullable().describe("The block the transaction landed in; null while pending."),
  explorer: z.string().describe("The transaction's page on the chain's block explorer."),
})

/** The arguments of a send, as `invoke` hands them over. */
export type EvmSendArgs = z.output<typeof sendInput>
