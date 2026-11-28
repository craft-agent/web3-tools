import { afterEach, describe, expect, test } from "bun:test"
import { withLedger } from "../ledger/store"
import { holdsKeyMaterial } from "../signer/testing"
import { cleanRigs, makeRig, NOW, nativeArgs } from "./send.testing"
import { WAIT_POLLS, WAIT_POLL_MS } from "./send.wait"
import { HARDHAT_ADDRESS_0 } from "./testing.sign"

afterEach(cleanRigs)

describe("the wait for a receipt", () => {
  test("a receipt after a few polls is confirmed, and the wait stops there", async () => {
    const rig = makeRigMiningAt(6000)
    const result = await rig.run(nativeArgs())
    expect(result).toMatchObject({ outcome: "confirmed", block: "101" })
    expect(rig.sleeps).toEqual([2000, 2000, 2000])
    expect(rig.fake.requestsOf("eth_getTransactionReceipt")).toHaveLength(3)
    expect((await rig.rows())[0]).toMatchObject({ outcome: "confirmed", block: "101" })
  })

  test("no receipt in 20 seconds of waiting is pending: ten polls two seconds apart, with no real waiting", async () => {
    const rig = makeRigMiningAt(undefined)
    const started = Date.now()
    const result = await rig.run(nativeArgs())
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toMatchObject({ outcome: "pending", block: null })
    expect(WAIT_POLLS * WAIT_POLL_MS).toBe(20_000)
    expect(rig.sleeps).toEqual(Array(10).fill(2000))
    expect(rig.fake.requestsOf("eth_getTransactionReceipt")).toHaveLength(10)
    expect((await rig.rows())[0]).toMatchObject({ outcome: "pending", block: null })
    expect(rig.fake.pending).toHaveLength(1)
  })

  test("a reply for a pending send still names everything needed to find it", async () => {
    const rig = makeRigMiningAt(undefined)
    const result = await rig.run(nativeArgs())
    const [row] = await rig.rows()
    expect(result).toMatchObject({
      hash: row!.hash,
      ledger_row: row!.id,
      explorer: `https://etherscan.io/tx/${row!.hash}`,
    })
  })

  test("a receipt read that fails is pending, not an error, and the row stays as it was", async () => {
    const rig = makeRigMiningAt(2000)
    rig.fake.inject("eth_getTransactionReceipt", { http: { status: 500, body: "down" } })
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("pending")
  })

  test("a receipt that makes no sense is pending too", async () => {
    const rig = makeRigMiningAt(2000)
    rig.fake.inject("eth_getTransactionReceipt", { result: { status: "0x7", blockNumber: "0x1" } })
    expect((await rig.run(nativeArgs())).outcome).toBe("pending")
  })

  test("a row that cannot be settled is pending too, though the receipt is there", async () => {
    const rig = makeRigMiningAt(2000)
    rig.beforeRequest = async (method) => {
      if (method !== "eth_getTransactionReceipt") return
      const [row] = await rig.rows()
      await withLedger(
        rig.stateDir,
        () => NOW,
        (ledger) => ledger.settle(row!.id, { outcome: "rejected" }),
      )
    }
    expect((await rig.run(nativeArgs())).outcome).toBe("pending")
    expect(rig.fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(1n)
    expect((await rig.rows())[0]!.outcome).toBe("rejected")
  })

  test("a cancellation while waiting is pending, and the transaction is out", async () => {
    const rig = makeRigMiningAt(2000)
    const controller = rig.cancel()
    rig.beforeRequest = (method) => {
      if (method === "eth_getTransactionReceipt") controller.abort()
    }
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("pending")
    expect(rig.broadcasts()).toHaveLength(1)
    expect(rig.fake.nonceOf(HARDHAT_ADDRESS_0)).toBe(1n)
  })

  test("a cancellation during the broadcast leaves the row unknown and the reply pending", async () => {
    const rig = makeRigMiningAt(2000)
    const controller = rig.cancel()
    rig.beforeRequest = (method) => {
      if (method === "eth_sendRawTransaction") controller.abort()
    }
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("unknown")
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("no reply and no row holds a key or the signed transaction", async () => {
    const rig = makeRigMiningAt(undefined)
    rig.fake.failSend({ transport: "http500", accepted: true })
    const result = await rig.run(nativeArgs())
    const rows = await rig.rows()
    const raw = rig.broadcasts()[0]!
    for (const value of [result, rows]) {
      expect(holdsKeyMaterial(value)).toBe(false)
      expect(JSON.stringify(value)).not.toContain(raw.slice(2, 80))
    }
  })
})

function makeRigMiningAt(ms: number | undefined) {
  const rig = makeRig()
  rig.mineAtMs = ms
  return rig
}
