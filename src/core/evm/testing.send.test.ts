import { describe, expect, test } from "bun:test"
import { RpcRefusal } from "../rpc/client"
import { rejection, toolError } from "../rpc/client.fixtures"
import { FakeEvmChain } from "./testing"
import { EXAMPLE_REQUEST, HARDHAT_ADDRESS_0, signWithHardhat } from "./testing.sign"
import type { EvmTransactionRequest } from "./transaction"

const GWEI = 10n ** 9n
const ETHER = 10n ** 18n

const funded = () => new FakeEvmChain("base").setBalance(HARDHAT_ADDRESS_0, 5n * ETHER)

const send = (fake: FakeEvmChain, raw: string, timeoutMs?: number) =>
  fake.client(timeoutMs === undefined ? {} : { timeoutMs }).call<string>("eth_sendRawTransaction", [raw])

async function nodeRefusal(work: Promise<unknown>): Promise<{ code: number; message: string }> {
  const error = await rejection(work)
  if (!(error instanceof RpcRefusal)) throw new Error(`Expected a node refusal, got ${String(error)}`, { cause: error })
  return error.rpc
}

const sign = (changes: Partial<EvmTransactionRequest> = {}) => signWithHardhat({ ...EXAMPLE_REQUEST, ...changes })

describe("what the fake checks on a raw transaction, worded as nodes do", () => {
  test("a nonce below the account's is 'nonce too low'", async () => {
    const fake = funded().setNonce(HARDHAT_ADDRESS_0, 5n)
    const refusal = await nodeRefusal(send(fake, (await sign({ nonce: 4n })).raw))
    expect(refusal.code).toBe(-32000)
    expect(refusal.message).toContain("nonce too low")
    expect(fake.pending).toHaveLength(0)
  })

  test("a nonce past the next one is 'nonce too high'", async () => {
    const fake = funded()
    const refusal = await nodeRefusal(send(fake, (await sign({ nonce: 1n })).raw))
    expect(refusal).toMatchObject({ code: -32000 })
    expect(refusal.message).toContain("nonce too high")
  })

  test("successive nonces queue, and mine in nonce order", async () => {
    const fake = funded()
    const second = await sign({ nonce: 1n })
    await expect(send(fake, (await sign({ nonce: 0n })).raw)).resolves.toBeString()
    await send(fake, second.raw)
    expect(fake.pending.map((tx) => tx.nonce)).toEqual([0n, 1n])
    const receipts = fake.mine()
    expect(receipts.map((receipt) => receipt.tx.nonce)).toEqual([0n, 1n])
    expect(receipts.map((receipt) => receipt.index)).toEqual([0, 1])
    expect(fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(2n)
    expect(fake.balanceOf(HARDHAT_ADDRESS_0)).toBe(3n * ETHER - 2n * 21_000n * 2n * GWEI)
  })

  test("the wrong chain id, a sender who cannot pay and a garbled transaction are refused", async () => {
    const fake = funded()
    expect((await nodeRefusal(send(fake, (await sign({ chainId: 1 })).raw))).message).toContain("chain id")
    expect((await nodeRefusal(send(fake, (await sign({ value: 6n * ETHER })).raw))).message).toContain(
      "insufficient funds",
    )
    expect((await nodeRefusal(send(fake, "0x1234"))).message).toContain("invalid transaction")
    expect((await nodeRefusal(send(fake, "nope"))).code).toBe(-32000)
    expect(fake.pending).toHaveLength(0)
  })

  test("sending the same transaction twice is 'already known', also after it is mined", async () => {
    const fake = funded()
    const { raw } = await sign()
    await send(fake, raw)
    expect((await nodeRefusal(send(fake, raw))).message).toContain("already known")
    fake.mine()
    expect((await nodeRefusal(send(fake, raw))).message).toContain("already known")
  })
})

describe("replacing a transaction in the mempool", () => {
  test("a new transaction at the same nonce and fees is 'replacement transaction underpriced'", async () => {
    const fake = funded()
    const first = await sign()
    await send(fake, first.raw)
    const refusal = await nodeRefusal(send(fake, (await sign()).raw))
    expect(refusal.message).toBe("replacement transaction underpriced")
    expect(fake.pending.map((tx) => tx.hash)).toEqual([first.hash])
  })

  test("a bump of the max fee or of the tip alone, or of less than 10%, is underpriced", async () => {
    const fake = funded()
    await send(fake, (await sign()).raw)
    const attempts: Partial<EvmTransactionRequest>[] = [
      { maxFeePerGas: 22n * GWEI },
      { maxPriorityFeePerGas: GWEI + GWEI / 10n },
      { maxFeePerGas: 21_999_999_999n, maxPriorityFeePerGas: 1_100_000_000n },
      { maxFeePerGas: 22n * GWEI, maxPriorityFeePerGas: 1_099_999_999n },
    ]
    for (const attempt of attempts) {
      expect((await nodeRefusal(send(fake, (await sign(attempt)).raw))).message).toContain("underpriced")
    }
  })

  test("a bump of 10% on both takes its place, and only the new one is mined", async () => {
    const fake = funded()
    const first = await sign()
    await send(fake, first.raw)
    const bumped = await sign({ maxFeePerGas: 22n * GWEI, maxPriorityFeePerGas: GWEI + GWEI / 10n })
    expect(await send(fake, bumped.raw)).toBe(bumped.hash)
    expect(fake.pending.map((tx) => tx.hash)).toEqual([bumped.hash])
    fake.mine()
    expect(fake.receiptOf(bumped.hash)?.status).toBe(1)
    expect(fake.receiptOf(first.hash)).toBeUndefined()
    expect(await fake.client().call("eth_getTransactionByHash", [first.hash])).toBeNull()
  })

  test("a transaction at a mined nonce cannot replace it", async () => {
    const fake = funded()
    await send(fake, (await sign()).raw)
    fake.mine()
    const refusal = await nodeRefusal(
      send(fake, (await sign({ maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 2n * GWEI })).raw),
    )
    expect(refusal.message).toContain("nonce too low")
  })
})

describe("failure injection on eth_sendRawTransaction", () => {
  test("a node error accepts nothing, once", async () => {
    const fake = funded().failSend({ reject: { code: -32000, message: "txpool is full" } })
    const { raw, hash } = await sign()
    expect(await nodeRefusal(send(fake, raw))).toEqual({ code: -32000, message: "txpool is full" })
    expect(fake.pending).toHaveLength(0)
    expect(await send(fake, raw)).toBe(hash)
  })

  test("HTTP 500 before accepting leaves the mempool empty", async () => {
    const fake = funded().failSend({ transport: "http500", accepted: false })
    const { raw, hash } = await sign()
    expect((await toolError(send(fake, raw))).message).toContain("HTTP 500")
    expect(fake.pending).toHaveLength(0)
    expect(await send(fake, raw)).toBe(hash)
  })

  test("HTTP 500 after accepting leaves the transaction in the mempool, to be mined", async () => {
    const fake = funded().failSend({ transport: "http500", accepted: true })
    const { raw, hash } = await sign()
    expect((await toolError(send(fake, raw))).code).toBe("upstream_error")
    expect(fake.pending.map((tx) => tx.hash)).toEqual([hash])
    expect((await nodeRefusal(send(fake, raw))).message).toContain("already known")
    fake.mine()
    expect(fake.receiptOf(hash)?.status).toBe(1)
  })

  test("a timeout never answers, before or after accepting", async () => {
    const before = funded().failSend({ transport: "timeout", accepted: false })
    const { raw } = await sign()
    expect((await toolError(send(before, raw, 30))).message).toContain("did not answer")
    expect(before.pending).toHaveLength(0)

    const after = funded().failSend({ transport: "timeout", accepted: true })
    expect((await toolError(send(after, raw, 30))).message).toContain("did not answer")
    expect(after.pending).toHaveLength(1)
  })

  test("a refused transaction is refused whatever failure follows it", async () => {
    const fake = funded().setNonce(HARDHAT_ADDRESS_0, 1n).failSend({ transport: "http500", accepted: true })
    const refusal = await nodeRefusal(send(fake, (await sign()).raw))
    expect(refusal.message).toContain("nonce too low")
  })

  test("a dropped transaction answers its hash and is then nowhere: not pending, not found, never mined", async () => {
    const fake = funded().failSend("drop")
    const { raw, hash } = await sign()
    expect(await send(fake, raw)).toBe(hash)
    expect(fake.pending).toHaveLength(0)
    const client = fake.client()
    expect(await client.call("eth_getTransactionByHash", [hash])).toBeNull()
    expect(await client.call("eth_getTransactionCount", [HARDHAT_ADDRESS_0, "pending"])).toBe("0x0")
    expect(fake.mine()).toEqual([])
    expect(await client.call("eth_getTransactionReceipt", [hash])).toBeNull()
    expect(fake.balanceOf(HARDHAT_ADDRESS_0)).toBe(5n * ETHER)
  })

  test("failures are used in the order given, one per send", async () => {
    const fake = funded().failSend({ reject: { code: -32000, message: "first" } }, "drop")
    const { raw } = await sign()
    expect((await nodeRefusal(send(fake, raw))).message).toBe("first")
    await send(fake, raw)
    expect(fake.pending).toHaveLength(0)
    await send(fake, raw)
    expect(fake.pending).toHaveLength(1)
  })
})
