import { afterEach, describe, expect, test } from "bun:test"
import { withLedger } from "../ledger/store"
import { holdsKeyMaterial } from "../signer/testing"
import { WAIT_POLLS, WAIT_POLL_MS } from "../write/wait"
import { BOB, cleanRigs, LAMPORTS_PER_SOL, makeRig, NOW, solArgs } from "./send.testing"

afterEach(cleanRigs)

function makeRigMiningAt(ms: number | undefined) {
  const rig = makeRig()
  rig.mineAtMs = ms
  return rig
}

describe("the wait for a signature's status", () => {
  test("a status after a few polls is confirmed, and the wait stops there", async () => {
    const rig = makeRigMiningAt(6000)
    const result = await rig.run(solArgs())
    expect(result).toMatchObject({ outcome: "confirmed", slot: "2001" })
    expect(rig.sleeps).toEqual([2000, 2000, 2000])
    expect(rig.fake.requestsOf("getSignatureStatuses")).toHaveLength(3)
    expect((await rig.rows())[0]).toMatchObject({ outcome: "confirmed", block: "2001" })
  })

  test("no status in 20 seconds of waiting is pending: ten polls two seconds apart, with no real waiting", async () => {
    const rig = makeRigMiningAt(undefined)
    const started = Date.now()
    const result = await rig.run(solArgs())
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result).toMatchObject({ outcome: "pending", slot: null })
    expect(WAIT_POLLS * WAIT_POLL_MS).toBe(20_000)
    expect(rig.sleeps).toEqual(Array(10).fill(2000))
    expect(rig.fake.requestsOf("getSignatureStatuses")).toHaveLength(10)
    expect((await rig.rows())[0]).toMatchObject({ outcome: "pending", block: null })
    expect(rig.fake.pending).toHaveLength(1)
  })

  test("a transaction that lands with an error is failed, its fee charged", async () => {
    const rig = makeRigMiningAt(2000)
    rig.fake.revertWhen = () => true
    const result = await rig.run(solArgs())
    expect(result).toMatchObject({ outcome: "failed", slot: "2001" })
    expect((await rig.rows())[0]).toMatchObject({ outcome: "failed", block: "2001" })
    expect(rig.fake.balanceOf(BOB)).toBe(0n)
    expect(rig.fake.balanceOf((await rig.rows())[0]!.sender)).toBe(10n * LAMPORTS_PER_SOL - 5000n)
  })

  test("a status that is only processed is not a result yet", async () => {
    const rig = makeRigMiningAt(2000)
    rig.beforeRequest = (method) => {
      if (method !== "getSignatureStatuses") return
      const status = { slot: 2001, confirmations: 0, err: null, status: { Ok: null }, confirmationStatus: "processed" }
      rig.fake.inject("getSignatureStatuses", { result: { context: { slot: 2001 }, value: [status] } })
    }
    expect((await rig.run(solArgs())).outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("pending")
  })

  test("a reply for a pending send still names everything needed to find it", async () => {
    const rig = makeRigMiningAt(undefined)
    const result = await rig.run(solArgs())
    const [row] = await rig.rows()
    expect(result).toMatchObject({
      signature: row!.hash,
      ledger_row: row!.id,
      explorer: `https://explorer.solana.com/tx/${row!.hash}`,
    })
  })

  test("a status read that fails is pending, not an error, and the row stays as it was", async () => {
    const rig = makeRigMiningAt(2000)
    rig.fake.inject("getSignatureStatuses", { http: { status: 500, body: "down" } })
    const result = await rig.run(solArgs())
    expect(result.outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("pending")
  })

  test("a status that makes no sense is pending too", async () => {
    const rig = makeRigMiningAt(2000)
    rig.fake.inject("getSignatureStatuses", { result: { context: { slot: 1 }, value: [{ slot: "x" }] } })
    expect((await rig.run(solArgs())).outcome).toBe("pending")
  })

  test("a row that cannot be settled is pending too, though the status is there", async () => {
    const rig = makeRigMiningAt(2000)
    rig.beforeRequest = async (method) => {
      if (method !== "getSignatureStatuses") return
      const [row] = await rig.rows()
      await withLedger(
        rig.stateDir,
        () => NOW,
        (ledger) => ledger.settle(row!.id, { outcome: "rejected" }),
      )
    }
    expect((await rig.run(solArgs())).outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("rejected")
  })

  test("a cancellation while waiting is pending, and the transaction is out", async () => {
    const rig = makeRigMiningAt(2000)
    const controller = rig.cancel()
    rig.beforeRequest = (method) => {
      if (method === "getSignatureStatuses") controller.abort()
    }
    expect((await rig.run(solArgs())).outcome).toBe("pending")
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("a cancellation during the broadcast leaves the row unknown and the reply pending", async () => {
    const rig = makeRigMiningAt(2000)
    const controller = rig.cancel()
    rig.beforeRequest = (method) => {
      if (method === "sendTransaction") controller.abort()
    }
    expect((await rig.run(solArgs())).outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("unknown")
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("no reply and no row holds a key or the signed transaction", async () => {
    const rig = makeRigMiningAt(undefined)
    rig.fake.failSend({ transport: "http500", accepted: true })
    const result = await rig.run(solArgs())
    const rows = await rig.rows()
    const raw = rig.broadcasts()[0]!
    for (const value of [result, rows]) {
      expect(holdsKeyMaterial(value)).toBe(false)
      expect(JSON.stringify(value)).not.toContain(raw.slice(0, 80))
    }
  })
})
