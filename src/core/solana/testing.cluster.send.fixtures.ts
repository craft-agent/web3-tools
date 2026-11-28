import { RpcRefusal } from "../rpc/client"
import { rejection } from "../rpc/client.fixtures"
import { transferMessage } from "./reads.fixtures"
import { FakeSolanaCluster } from "./testing.cluster"
import { testKeypair } from "./testing.cluster.sign"

export const ALICE = testKeypair(1)
export const BOB = testKeypair(2)

/** A fake cluster in which `ALICE` holds `lamports`. */
export function funded(lamports = 10_000_000n): FakeSolanaCluster {
  return new FakeSolanaCluster().setBalance(ALICE.address, lamports)
}

/** The message of a transfer of `lamports` from `ALICE` to `BOB`, dated by the cluster's latest blockhash. */
export function transfer(
  cluster: FakeSolanaCluster,
  lamports: bigint,
  budget?: { unitLimit: number; unitPrice: bigint },
) {
  return transferMessage(cluster.latestBlockhash, ALICE.address, BOB.address, lamports, budget)
}

/** Sends the signed transaction `text` through a client that gives up after `timeoutMs`; resolves with the signature. */
export async function send(cluster: FakeSolanaCluster, text: string, timeoutMs = 20): Promise<string> {
  return cluster.client({ timeoutMs }).call<string>("sendTransaction", [text, { encoding: "base64" }])
}

/** The error the node answered with, which a promise rejected with; fails when it rejected with anything else. */
export async function refusalOf(promise: Promise<unknown>): Promise<RpcRefusal> {
  const error = await rejection(promise)
  if (!(error instanceof RpcRefusal)) throw new Error(`Expected a node refusal, got ${String(error)}`)
  return error
}
