import { describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { toolError } from "../rpc/client.fixtures"
import { blockHeight, latestBlockhash, recentPriorityFees, signatureStatus, simulate } from "./reads"
import { nodeClient, transferMessage, unsigned } from "./reads.fixtures"
import { testAddress } from "./testing"
import { FakeSolanaCluster } from "./testing.cluster"
import { signedTransactionBase64, testKeypair } from "./testing.cluster.sign"

const ALICE = testKeypair(1)
const BOB = testAddress(2)

describe("latestBlockhash and blockHeight", () => {
  test("read the blockhash with the last height it is good for, and the height", async () => {
    const cluster = new FakeSolanaCluster("solana", { blockHeight: 5000n })
    const client = cluster.client()
    expect(await latestBlockhash(client)).toEqual({ blockhash: cluster.latestBlockhash, lastValidBlockHeight: 5150n })
    expect(await blockHeight(client)).toBe(5000n)
    expect(cluster.requestsOf("getLatestBlockhash")[0]).toEqual([{ commitment: "confirmed" }])
    expect(cluster.requestsOf("getBlockHeight")[0]).toEqual([{ commitment: "confirmed" }])
  })

  test("an answer that is not a blockhash or a height is upstream_error naming the cluster", async () => {
    const bad = [
      { value: { blockhash: "short", lastValidBlockHeight: 1 } },
      { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: "1" } },
      { value: null },
      7,
    ]
    for (const result of bad) {
      const { client } = nodeClient({ getLatestBlockhash: { result }, getBlockHeight: { result: result as unknown } })
      expect((await toolError(latestBlockhash(client))).message).toContain("Solana")
    }
    const { client } = nodeClient({ getBlockHeight: { result: "7" } })
    expect((await toolError(blockHeight(client))).code).toBe("upstream_error")
  })
})

describe("signatureStatus", () => {
  test("is null for a signature the cluster does not know, and tells slot, status and error for one it does", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE.address, 10_000_000n)
    const client = cluster.client()
    const message = transferMessage(cluster.latestBlockhash, ALICE.address, BOB, 1_000_000n)
    const signed = signedTransactionBase64(message, ALICE)
    const signature = await client.call<string>("sendTransaction", [signed, { encoding: "base64" }])
    expect(await signatureStatus(client, signature)).toBeNull()
    cluster.land()
    expect(await signatureStatus(client, signature)).toEqual({
      slot: cluster.slot,
      confirmationStatus: "confirmed",
      err: null,
    })
    expect(cluster.requestsOf("getSignatureStatuses")[0]).toEqual([[signature], { searchTransactionHistory: true }])

    cluster.setBalance(ALICE.address, 5_000n)
    const failing = signedTransactionBase64(transferMessage(cluster.latestBlockhash, ALICE.address, BOB, 4_000n), ALICE)
    const failed = await client.call<string>("sendTransaction", [failing, { encoding: "base64" }])
    cluster.land()
    expect((await signatureStatus(client, failed))?.err).toEqual({ InstructionError: [0, { Custom: 1 }] })
  })

  test("an answer that is not one status is upstream_error", async () => {
    for (const value of [[], [null, null], [{ slot: "1" }], "x"]) {
      const { client } = nodeClient({ getSignatureStatuses: { result: { value } } })
      expect((await toolError(signatureStatus(client, "sig"))).code).toBe("upstream_error")
    }
  })

  test("a status without a confirmation status or error reads as null for both", async () => {
    const { client } = nodeClient({ getSignatureStatuses: { result: { value: [{ slot: 9, confirmations: 3 }] } } })
    expect(await signatureStatus(client, "sig")).toEqual({ slot: 9n, confirmationStatus: null, err: null })
  })
})

describe("recentPriorityFees", () => {
  test("lists the prices recent blocks paid, zeros included, for the accounts asked about", async () => {
    const cluster = new FakeSolanaCluster()
    cluster.priorityFees = [0n, 500n, 1200n, 0n]
    expect(await recentPriorityFees(cluster.client(), [ALICE.address, BOB])).toEqual([0n, 500n, 1200n, 0n])
    expect(cluster.requestsOf("getRecentPrioritizationFees")[0]).toEqual([[ALICE.address, BOB]])
  })

  test("is empty when the cluster has none, and refuses an answer of another shape", async () => {
    expect(await recentPriorityFees(new FakeSolanaCluster().client(), [])).toEqual([])
    const { client } = nodeClient({ getRecentPrioritizationFees: { result: [{ slot: 1, prioritizationFee: "5" }] } })
    expect((await toolError(recentPriorityFees(client, []))).code).toBe("upstream_error")
  })
})

describe("simulate", () => {
  test("reads the units a transfer with a compute budget consumes, and its log", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE.address, 10_000_000n)
    const message = transferMessage(cluster.latestBlockhash, ALICE.address, BOB, 1_000_000n, {
      unitLimit: 1_400_000,
      unitPrice: 0n,
    })
    const result = await simulate(cluster.client(), unsigned(message))
    expect(result.unitsConsumed).toBe(450)
    expect(result.logs.at(-1)).toContain("success")
    expect(cluster.requestsOf("simulateTransaction")[0]).toEqual([
      unsigned(message),
      { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" },
    ])
    expect(cluster.balanceOf(BOB)).toBe(0n)
  })

  test("returns the accounts it is asked to watch as the run leaves them, in order, null for one that is not there", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE.address, 10_000_000n)
    const message = transferMessage(cluster.latestBlockhash, ALICE.address, BOB, 1_000_000n)
    const result = await simulate(cluster.client(), unsigned(message), [BOB, testAddress(5)])
    expect(result.accounts).toEqual([{ lamports: 1_000_000n, owner: SOLANA_PROGRAMS.systemProgram }, null])
    expect(cluster.requestsOf("simulateTransaction")[0]![1]).toEqual({
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
      encoding: "base64",
      accounts: { addresses: [BOB, testAddress(5)], encoding: "base64" },
    })
    expect(cluster.balanceOf(BOB)).toBe(0n)
    expect((await simulate(cluster.client(), unsigned(message))).accounts).toEqual([])
  })

  test("a cluster that does not return the watched accounts is upstream_error", async () => {
    const { client } = nodeClient({
      simulateTransaction: { result: { value: { err: null, logs: [], unitsConsumed: 5, accounts: null } } },
    })
    const error = await toolError(simulate(client, "tx", [BOB]))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("accounts")
  })

  test("a transaction the cluster would fail is invalid_argument quoting its error and its log as data", async () => {
    const cluster = new FakeSolanaCluster().setBalance(ALICE.address, 6_000n)
    const message = transferMessage(cluster.latestBlockhash, ALICE.address, BOB, 5_000n)
    const error = await toolError(simulate(cluster.client(), unsigned(message)))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toStartWith(
      'The cluster would fail this transaction: {"InstructionError":[0,{"Custom":1}]}; [',
    )
    expect(error.message).toContain("Transfer: insufficient lamports 1000, need 5000")
    expect(error.message).toContain("Program 11111111111111111111111111111111 failed: custom program error: 0x1")
  })

  test("quotes the error up to 200 characters and the last six log lines up to 200 each", async () => {
    const logs = Array.from({ length: 10 }, (_, index) => `line ${index} ${"x".repeat(300)}`)
    const { client } = nodeClient({
      simulateTransaction: { result: { value: { err: { Instruction: "y".repeat(500) }, logs, unitsConsumed: 10 } } },
    })
    const error = await toolError(simulate(client, "tx"))
    const [, reason, quoted] = /^The cluster would fail this transaction: (.*?); (\[.*\])$/.exec(error.message) ?? []
    expect(reason).toHaveLength(200)
    const lines = JSON.parse(quoted) as string[]
    expect(lines).toHaveLength(6)
    expect(lines[0]).toStartWith("line 4 ")
    expect(lines.every((line) => line.length === 200)).toBe(true)
  })

  test("a failure without a log has no log to quote", async () => {
    const { client } = nodeClient({
      simulateTransaction: { result: { value: { err: "AccountNotFound", logs: null } } },
    })
    expect((await toolError(simulate(client, "tx"))).message).toBe(
      'The cluster would fail this transaction: "AccountNotFound"',
    )
  })

  test("an answer without units consumed, or of another shape, is upstream_error", async () => {
    for (const result of [{ value: { err: null, logs: [] } }, { value: { err: null, unitsConsumed: -1 } }, 3]) {
      const { client } = nodeClient({ simulateTransaction: { result } })
      const error = await toolError(simulate(client, "tx"))
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("Solana")
    }
  })
})
