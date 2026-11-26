import { z } from "zod"
import { isToolError, ToolError } from "../errors"
import { requireRuntime } from "../runtime"
import { walletAccounts, type Account, type WalletAccounts } from "../signer/accounts"
import { MAX_ACCOUNT_INDEX } from "../signer/derive"
import type { KeyKind } from "../signer/keys"
import { listLabels, type KeySource } from "../signer/labels"
import { defineTool, type ToolSpec } from "../tool"

const DEFAULT_ACCOUNT_COUNT = 10

const input = z.object({
  method: z
    .enum(["list", "accounts"])
    .describe('"list": wallets and their first addresses; "accounts": a wallet\'s addresses.'),
  account: z.string().optional().describe("accounts only: a wallet label, not label#index. Left out, the only label."),
  from: z.number().int().min(0).max(MAX_ACCOUNT_INDEX).optional().describe("accounts only: first index, default 0."),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_ACCOUNT_INDEX + 1)
    .optional()
    .describe(
      `accounts only: number of addresses, default ${DEFAULT_ACCOUNT_COUNT}; last index at most ${MAX_ACCOUNT_INDEX}.`,
    ),
})

const walletSchema = z.object({
  label: z.string().describe("The wallet's label."),
  source: z.enum(["variable", "file"] satisfies KeySource[]).describe("Where the key comes from."),
  kind: z.enum(["phrase", "evm", "solana"] satisfies KeyKind[]).describe("The kind of key, never its contents."),
  words: z.number().int().optional().describe("The word count of a seed phrase."),
}) satisfies z.ZodType<Omit<WalletAccounts, "accounts">>

const addresses = {
  evm: z.string().optional().describe("The checksummed EVM address, when this wallet opens EVM accounts."),
  solana: z.string().optional().describe("The Solana address, when this wallet opens Solana accounts."),
}

const listedWalletSchema = walletSchema.partial({ kind: true }).extend({
  ...addresses,
  problem: z
    .object({ code: z.string(), message: z.string() })
    .optional()
    .describe("Why this wallet could not be read; no addresses are returned for it."),
})

const accountSchema = z.object({
  index: z.number().int().nullable().describe("The seed phrase's account index; null for a lone key."),
  ...addresses,
}) satisfies z.ZodType<Account>

const output = z.object({
  wallets: z.array(listedWalletSchema).optional().describe("list: every wallet, sorted by label."),
  wallet: walletSchema.optional().describe("accounts: the wallet read."),
  accounts: z.array(accountSchema).optional().describe("accounts: the requested range, or a lone key's one address."),
})

function assertAcceptedKeys(args: z.output<typeof input>): void {
  if (args.method !== "list") return
  for (const [key, value] of Object.entries(args)) {
    if (key !== "method" && value !== undefined) {
      throw new ToolError("invalid_argument", `Method "${args.method}" takes no \`${key}\`.`)
    }
  }
}

/** Defines the `web3_wallet_read` tool spec. */
export function defineWalletRead(): ToolSpec<typeof input, typeof output> {
  return defineTool({
    id: "web3_wallet_read",
    title: "Read wallets",
    description: [
      "List the wallets the package can sign with and their addresses, computed from keys without a request; never shows a key.",
      "'list' gives each label, its source (variable or file), first addresses or a problem; 'accounts' gives a label's account range.",
      "Only a person sets up a wallet with the package's 'wallet import' or 'wallet create' command, never a tool.",
      "An agent must never ask for, read or repeat a seed phrase or private key. Reading any other address needs no wallet.",
    ].join(" "),
    toolset: "wallet",
    class: "read",
    input,
    output,
    async execute(args, ctx) {
      const { runtime, stateDir } = requireRuntime(ctx, "Wallet reads")
      assertAcceptedKeys(args)
      if (args.method === "list") {
        const wallets: z.input<typeof listedWalletSchema>[] = []
        for (const entry of await listLabels(runtime, stateDir)) {
          try {
            const { accounts, ...wallet } = await walletAccounts(entry.label, runtime, stateDir, { from: 0, count: 1 })
            const { evm, solana } = accounts[0]
            wallets.push({
              ...wallet,
              ...(evm === undefined ? {} : { evm }),
              ...(solana === undefined ? {} : { solana }),
            })
          } catch (error) {
            if (!isToolError(error)) throw error
            wallets.push({ ...entry, problem: { code: error.code, message: error.message } })
          }
        }
        return { wallets }
      }
      const range = { from: args.from ?? 0, count: args.count ?? DEFAULT_ACCOUNT_COUNT }
      if (range.from + range.count - 1 > MAX_ACCOUNT_INDEX) {
        throw new ToolError(
          "invalid_argument",
          `The last account (from + count - 1) must be at most #${MAX_ACCOUNT_INDEX}.`,
        )
      }
      let label = args.account
      if (label === undefined) {
        const labels = (await listLabels(runtime, stateDir)).map((entry) => entry.label)
        if (labels.length === 0) {
          throw new ToolError(
            "invalid_argument",
            `No wallet is set up: a person sets one up with "${runtime.cli} wallet import" or "${runtime.cli} wallet create".`,
          )
        }
        if (labels.length > 1) {
          throw new ToolError(
            "invalid_argument",
            `Several wallets are set up (${labels.join(", ")}); pick one with "account".`,
          )
        }
        label = labels[0]
      }
      const { accounts, ...wallet } = await walletAccounts(label, runtime, stateDir, range)
      return { wallet, accounts }
    },
  })
}

/** The wallet read tool. */
export const web3WalletRead = defineWalletRead()
