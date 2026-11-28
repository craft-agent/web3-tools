import { afterEach, describe, expect, test } from "bun:test"
import { holdsKeyMaterial } from "../signer/testing"
import { withLedger } from "../ledger/store"
import { newRow } from "../ledger/testing"
import { cleanRigs, hashOfRaw, makeRig, NOW, nativeArgs, type SendRig } from "./send.testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

const NODE_REFUSAL = { reject: { code: -32000, message: "txpool is full" } }

/** The hashes of the raw transactions the fake received, in order. */
const received = (rig: SendRig) => rig.broadcasts().map(hashOfRaw)

/** No transaction reached the node twice, and none of the rows' hashes was sent again after its row's turn. */
function expectNoHashSentTwice(rig: SendRig): void {
  const hashes = received(rig)
  expect(new Set(hashes).size).toBe(hashes.length)
}

describe("a broadcast that never reached the node", () => {
  test("is pending with its row unknown, and the next send takes its nonce instead of sending it", async () => {
    const rig = makeRig()
    rig.fake.failSend({ transport: "timeout", accepted: false })
    rig.mineAtMs = undefined
    const first = await rig.run(nativeArgs())
    expect(first).toMatchObject({ outcome: "pending", block: null })
    expect(rig.sleeps).toEqual(Array(10).fill(2000))
    const [lost] = await rig.rows()
    expect(lost).toMatchObject({ outcome: "unknown", nonce: "0", hash: first.hash })
    expect(rig.fake.pending).toHaveLength(0)

    rig.mineAtMs = 2000
    const second = await rig.run(nativeArgs({ amount: "2" }))
    expect(second).toMatchObject({ outcome: "confirmed" })
    expect(second.hash).not.toBe(first.hash)
    expect(rig.fake.receiptOf(second.hash)?.tx.nonce).toBe(0n)
    expect(rig.fake.receiptOf(first.hash)).toBeUndefined()
    expect(rig.broadcasts()).toHaveLength(2)
    expect(received(rig)[0]).toBe(first.hash)
    expectNoHashSentTwice(rig)
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_1) > 0n).toBe(true)
    expect(rig.fake.balanceOf(HARDHAT_ADDRESS_1)).toBe(2n * 10n ** 18n)
  })

  test("is rejected once the new transaction has taken its nonce", async () => {
    const rig = makeRig()
    rig.fake.failSend({ transport: "timeout", accepted: false })
    rig.mineAtMs = undefined
    await rig.run(nativeArgs())
    rig.mineAtMs = 2000
    await rig.run(nativeArgs())
    await rig.run(nativeArgs())

    const rows = await rig.rows()
    expect(rows.map((row) => [row.outcome, row.nonce])).toEqual([
      ["rejected", "0"],
      ["confirmed", "0"],
      ["confirmed", "1"],
    ])
    expect(rows[0]!.note).toBe("Its nonce was taken by another transaction; it can never land.")
    expectNoHashSentTwice(rig)
    expect(rig.broadcasts()).toHaveLength(3)
  })

  test("an HTTP error before the node took it is the same", async () => {
    const rig = makeRig()
    rig.fake.failSend({ transport: "http500", accepted: false })
    expect((await rig.run(nativeArgs())).outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("unknown")
    expect((await rig.run(nativeArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((row) => row.nonce)).toEqual(["0", "0"])
  })

  test("a row a crash left unknown, whose transaction was never sent, is taken over the same way", async () => {
    const rig = makeRig()
    const lost = newRow({ chain: "ethereum", sender: HARDHAT_ADDRESS_0, recipient: HARDHAT_ADDRESS_1, nonce: "0" })
    await withLedger(
      rig.stateDir,
      () => NOW,
      (ledger) => ledger.add(lost),
    )
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("confirmed")
    expect(rig.broadcasts()).toHaveLength(1)
    expect(received(rig)).not.toContain(lost.hash)
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["unknown", "confirmed"])
    await rig.run(nativeArgs())
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["rejected", "confirmed", "confirmed"])
  })
})

describe("a broadcast whose answer was lost after the node took it", () => {
  async function lostAnswer(): Promise<{ rig: SendRig; hash: string }> {
    const rig = makeRig()
    rig.fake.failSend({ transport: "timeout", accepted: true })
    rig.mineAtMs = undefined
    const first = await rig.run(nativeArgs())
    expect(first.outcome).toBe("pending")
    expect(rig.fake.pending.map((tx) => tx.hash)).toEqual([first.hash])
    return { rig, hash: first.hash }
  }

  test("is refused as stale naming the hash while the node holds it, before anyone is asked", async () => {
    const { rig, hash } = await lostAnswer()
    const approval = await rig.approve(nativeArgs())
    expect(approval.refused).toMatchObject({ code: "stale" })
    expect(approval.refused?.message).toContain(hash)
    expect(approval.refused?.message).toContain(`https://etherscan.io/tx/${hash}`)
    await expect(rig.run(nativeArgs())).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(1)
    expect(await rig.rows()).toHaveLength(1)
  })

  test("the run itself finds it too, marks the row pending and sends nothing", async () => {
    const { rig, hash } = await lostAnswer()
    const parsed = rig.tool.input.parse(nativeArgs())
    const error = await rig.tool.execute(parsed, rig.ctx).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain(hash)
    expect((error as Error).message).toContain("nothing was sent")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "pending" })
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("once mined, the next send settles it confirmed and goes on with a fresh nonce", async () => {
    const { rig, hash } = await lostAnswer()
    rig.fake.mine()
    rig.mineAtMs = 2000
    const second = await rig.run(nativeArgs())
    expect(second.outcome).toBe("confirmed")
    const rows = await rig.rows()
    expect(rows[0]).toMatchObject({ hash, outcome: "confirmed", block: "101", nonce: "0" })
    expect(rows[1]).toMatchObject({ outcome: "confirmed", nonce: "1" })
    expectNoHashSentTwice(rig)
  })

  test("a reverted one settles failed and the next send goes on too", async () => {
    const { rig } = await lostAnswer()
    rig.fake.revertWhen = () => true
    rig.fake.mine()
    rig.fake.revertWhen = () => false
    rig.mineAtMs = 2000
    expect((await rig.run(nativeArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["failed", "confirmed"])
  })

  test("if it lands while the wait is on, the reply is confirmed and the row too", async () => {
    const rig = makeRig()
    rig.fake.failSend({ transport: "timeout", accepted: true })
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("confirmed")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "confirmed", hash: result.hash })
  })
})

describe("a node that refuses the transaction", () => {
  test("rejects the row and fails the call with the ledger row's id, saying nothing was sent", async () => {
    const rig = makeRig()
    rig.fake.failSend(NODE_REFUSAL)
    const error = await rig.run(nativeArgs()).catch((caught: unknown) => caught)
    const [row] = await rig.rows()
    expect(error).toMatchObject({ code: "upstream_error", details: { ledger_row: row!.id } })
    expect((error as Error).message).toContain("txpool is full")
    expect((error as Error).message).toContain("Nothing was sent")
    expect(row).toMatchObject({ outcome: "rejected", note: "The network refused it; nothing was sent." })
    expect(rig.sleeps).toEqual([])
    expect((await rig.run(nativeArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((entry) => [entry.outcome, entry.nonce])).toEqual([
      ["rejected", "0"],
      ["confirmed", "0"],
    ])
  })

  test("never repeats what the node said of the transaction itself", async () => {
    const rig = makeRig()
    rig.beforeRequest = (method, params) => {
      if (method === "eth_sendRawTransaction") {
        rig.fake.inject("eth_sendRawTransaction", {
          error: { code: -32000, message: `insufficient funds for transaction ${String(params[0])}` },
        })
      }
    }
    const error = await rig.run(nativeArgs()).catch((caught: unknown) => caught)
    const raw = rig.broadcasts()[0]!
    expect(error).toMatchObject({ code: "upstream_error" })
    expect((error as Error).message).not.toContain(raw.slice(2, 80))
    expect((error as Error).message.length).toBeLessThan(400)
    expect(holdsKeyMaterial(error)).toBe(false)
  })

  test("a refusal that does not say the node left it out keeps the row unknown, and the next send takes its nonce", async () => {
    const rig = makeRig()
    rig.fake.failSend({ reject: { code: -32603, message: "internal error" } })
    rig.mineAtMs = undefined
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("pending")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "unknown", nonce: "0" })
    rig.mineAtMs = 1
    expect((await rig.run(nativeArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((entry) => [entry.outcome, entry.nonce])).toEqual([
      ["unknown", "0"],
      ["confirmed", "0"],
    ])
  })

  test("'already known' means the node has it: the row is pending and the call goes on", async () => {
    const rig = makeRig()
    rig.fake.failSend({ reject: { code: -32000, message: "already known" } })
    rig.mineAtMs = undefined
    const result = await rig.run(nativeArgs())
    expect(result.outcome).toBe("pending")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "pending", note: null })
  })

  test("another hash than the signed one is noted, and the signed one is kept", async () => {
    const rig = makeRig()
    rig.fake.inject("eth_sendRawTransaction", { result: `0x${"ab".repeat(32)}` })
    rig.mineAtMs = undefined
    const result = await rig.run(nativeArgs())
    const [row] = await rig.rows()
    expect(result).toMatchObject({ outcome: "pending", hash: hashOfRaw(rig.broadcasts()[0]!) })
    expect(row).toMatchObject({ outcome: "pending", hash: result.hash })
    expect(row!.note).toContain("another hash")
    expect(row!.hash).not.toBe(`0x${"ab".repeat(32)}`)
  })

  test("the node's answer in another case of the same hash is not another hash", async () => {
    const rig = makeRig()
    rig.beforeRequest = (method, params) => {
      if (method === "eth_sendRawTransaction") {
        rig.fake.inject("eth_sendRawTransaction", {
          result: hashOfRaw(String(params[0])).toUpperCase().replace("0X", "0x"),
        })
      }
    }
    rig.mineAtMs = undefined
    await rig.run(nativeArgs())
    expect((await rig.rows())[0]!.note).toBeNull()
  })
})
