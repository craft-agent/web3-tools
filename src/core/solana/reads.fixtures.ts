import { solanaChain } from "../chains/solana"
import { solanaClient, type JsonRpcClient } from "../rpc/client"
import { fakeRpc, type FakeRpcHandler, type FakeRpcRequest } from "../rpc/testing"
import { setComputeUnitLimit, setComputeUnitPrice, systemTransfer } from "./instructions"
import { compileLegacyMessage, unsignedTransactionBase64, type SolanaMessage } from "./message"

/** A Solana client wired to a fake node answering `methods`. */
export function nodeClient(methods: Record<string, FakeRpcHandler>): {
  client: JsonRpcClient
  requests: FakeRpcRequest[]
} {
  const { fetch, requests } = fakeRpc(methods)
  return { client: solanaClient(solanaChain("solana"), { fetch, env: {} }), requests }
}

/** The `getAccountInfo` answer for `value`. */
export function accountAnswer(value: unknown): { result: unknown } {
  return { result: { context: { slot: 1 }, value } }
}

/**
 * The PayPal USD mint, as a mainnet node answered `getAccountInfo` with `jsonParsed` (2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo,
 * Token-2022): its `value`, with the confidential fee fields trimmed. It has a transfer fee, a transfer hook, confidential
 * transfers and a permanent delegate.
 */
export const PYUSD_ACCOUNT = {
  data: {
    parsed: {
      info: {
        decimals: 6,
        extensions: [
          {
            extension: "mintCloseAuthority",
            state: { closeAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk" },
          },
          { extension: "permanentDelegate", state: { delegate: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk" } },
          {
            extension: "transferFeeConfig",
            state: {
              newerTransferFee: { epoch: 605, maximumFee: 0, transferFeeBasisPoints: 0 },
              olderTransferFee: { epoch: 605, maximumFee: 0, transferFeeBasisPoints: 0 },
              transferFeeConfigAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
              withdrawWithheldAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
              withheldAmount: 0,
            },
          },
          {
            extension: "confidentialTransferMint",
            state: {
              auditorElgamalPubkey: null,
              authority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
              autoApproveNewAccounts: false,
            },
          },
          {
            extension: "transferHook",
            state: { authority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk", programId: null },
          },
          {
            extension: "metadataPointer",
            state: {
              authority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
              metadataAddress: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
            },
          },
          {
            extension: "tokenMetadata",
            state: {
              additionalMetadata: [],
              mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
              name: "PayPal USD",
              symbol: "PYUSD",
              updateAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
              uri: "https://token-metadata.paxos.com/pyusd_metadata/prod/solana/pyusd_metadata.json",
            },
          },
        ],
        freezeAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
        isInitialized: true,
        mintAuthority: "DRXA1H9SjZPyPCEeuAWpfwk8GqVW6dZsKFAtdfpFwApX",
        supply: "738568181056273",
      },
      type: "mint",
    },
    program: "spl-token-2022",
    space: 866,
  },
  executable: false,
  lamports: 2078412094,
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  rentEpoch: 18446744073709552000,
  space: 866,
}

/** The message of a transfer of `lamports` from `from` to `to`, with a compute budget when `budget` is given. */
export function transferMessage(
  blockhash: string,
  from: string,
  to: string,
  lamports: bigint,
  budget?: { unitLimit: number; unitPrice: bigint },
): SolanaMessage {
  const instructions = [
    ...(budget ? [setComputeUnitLimit(budget.unitLimit), setComputeUnitPrice(budget.unitPrice)] : []),
    systemTransfer(from, to, lamports),
  ]
  return { feePayer: from, recentBlockhash: blockhash, instructions }
}

/** The unsigned transaction of `message` as `simulateTransaction` takes it. */
export function unsigned(message: SolanaMessage): string {
  return unsignedTransactionBase64(compileLegacyMessage(message))
}
