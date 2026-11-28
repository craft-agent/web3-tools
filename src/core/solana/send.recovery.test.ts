import { afterEach, describe, expect, test } from "bun:test"
import { base58 } from "@scure/base"
import { withLedger } from "../ledger/store"
import { newRow } from "../ledger/testing"
import { holdsKeyMaterial } from "../signer/testing"
import { BOB, cleanRigs, MAIN_ADDRESS, makeRig, NOW, signaturesOf, solArgs, type SendRig } from "./send.testing"

afterEach(cleanRigs)

/** The last valid block height of a send made at the fake's first block: 150 blocks on. */
const LAST_VALID = 1150

const BLOCKHASH_EXPIRED = 151

const NODE_REFUSAL = { reject: { code: -32002, message: "Transaction simulation failed: Blockhash not found" } }

/** No signature reached the node twice. */
function expectNoSignatureSentTwice(rig: SendRig): void {
  const signatures = signaturesOf(rig)
  expect(new Set(signatures).size).toBe(signatures.length)
}

describe("a broadcast that never reached the node", () => {
  test("is pending with its row unknown, and the next send waits for its blockhash to expire, then goes on", async () => {
    const rig = makeRig()
    rig.fake.failSend({ transport: "timeout", accepted: false })
    rig.mineAtMs = undefined
    const first = await rig.run(solArgs())
    expect(first).toMatchObject({ outcome: "pending", slot: null })
    expect(rig.sleeps).toEqual(Array(10).fill(2000))
    const [lost] = await rig.rows()
    expect(lost).toMatchObject({ outcome: "unknown", hash: first.signature, last_valid_height: String(LAST_VALID) })
    expect(rig.fake.pending).toHaveLength(0)

    const approval = await rig.approve(solArgs({ amount: "2" }))
    expect(approval.refused).toMatchObject({ code: "stale" })
    expect(approval.refused?.message).toContain(first.signature)
    expect(approval.refused?.message).toContain(`block height ${LAST_VALID}`)
    await expect(rig.run(solArgs({ amount: "2" }))).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(1)

    rig.fake.advance(BLOCKHASH_EXPIRED)
    rig.mineAtMs = 2000
    const second = await rig.run(solArgs({ amount: "2" }))
    expect(second.outcome).toBe("confirmed")
    expect(second.signature).not.toBe(first.signature)
    expect(rig.broadcasts()).toHaveLength(2)
    expect(signaturesOf(rig)[0]).toBe(first.signature)
    expectNoSignatureSentTwice(rig)
    expect(rig.fake.statusOf(first.signature)).toBeUndefined()
    expect(rig.fake.balanceOf(BOB)).toBe(2n * 10n ** 9n)
    const rows = await rig.rows()
    expect(rows.map((row) => row.outcome)).toEqual(["rejected", "confirmed"])
    expect(rows[0]!.note).toBe("Its blockhash expired before it landed; it can never land.")
  })

  test("an HTTP error before the node took it is the same", async () => {
    const rig = makeRig()
    rig.fake.failSend({ transport: "http500", accepted: false })
    expect((await rig.run(solArgs())).outcome).toBe("pending")
    expect((await rig.rows())[0]!.outcome).toBe("unknown")
    rig.fake.advance(BLOCKHASH_EXPIRED)
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["rejected", "confirmed"])
  })

  test("a row a crash left unknown, whose transaction was never sent, is taken over the same way", async () => {
    const rig = makeRig()
    const lost = newRow({
      family: "solana",
      chain: "solana",
      sender: MAIN_ADDRESS,
      recipient: BOB,
      kind: "sol",
      hash: base58.encode(new Uint8Array(64).fill(1)),
      nonce: null,
      last_valid_height: String(LAST_VALID),
    })
    await withLedger(
      rig.stateDir,
      () => NOW,
      (ledger) => ledger.add(lost),
    )
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(0)

    rig.fake.advance(BLOCKHASH_EXPIRED)
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
    expect(signaturesOf(rig)).not.toContain(lost.hash)
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["rejected", "confirmed"])
  })

  test("a row of another sender, or another cluster, does not stop this one", async () => {
    const rig = makeRig()
    const hash = base58.encode(new Uint8Array(64).fill(2))
    const other = { family: "solana" as const, nonce: null, last_valid_height: String(LAST_VALID), hash }
    await withLedger(
      rig.stateDir,
      () => NOW,
      async (ledger) => {
        await ledger.add(newRow({ ...other, chain: "solana", sender: BOB }))
        await ledger.add(
          newRow({
            ...other,
            chain: "solana-devnet",
            sender: MAIN_ADDRESS,
            hash: base58.encode(new Uint8Array(64).fill(3)),
          }),
        )
      },
    )
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
  })
})

describe("a broadcast whose answer was lost after the node took it", () => {
  async function lostAnswer(): Promise<{ rig: SendRig; signature: string }> {
    const rig = makeRig()
    rig.fake.failSend({ transport: "timeout", accepted: true })
    rig.mineAtMs = undefined
    const first = await rig.run(solArgs())
    expect(first.outcome).toBe("pending")
    expect(rig.fake.pending.map((tx) => tx.signature)).toEqual([first.signature])
    return { rig, signature: first.signature }
  }

  test("is refused as stale naming the signature while the cluster may still land it, before anyone is asked", async () => {
    const { rig, signature } = await lostAnswer()
    const approval = await rig.approve(solArgs())
    expect(approval.refused).toMatchObject({ code: "stale" })
    expect(approval.refused?.message).toContain(signature)
    expect(approval.refused?.message).toContain(`https://explorer.solana.com/tx/${signature}`)
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(1)
    expect(await rig.rows()).toHaveLength(1)
  })

  test("the run itself finds it too, and sends nothing", async () => {
    const { rig, signature } = await lostAnswer()
    const parsed = rig.tool.input.parse(solArgs())
    const error = await rig.tool.execute(parsed, rig.ctx).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain(signature)
    expect((error as Error).message).toContain("nothing was sent")
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("a signature processed but not confirmed may still roll back: stale, and the row is pending", async () => {
    const { rig } = await lostAnswer()
    rig.beforeRequest = (method) => {
      if (method !== "getSignatureStatuses") return
      const status = { slot: 2001, confirmations: 0, err: null, status: { Ok: null }, confirmationStatus: "processed" }
      rig.fake.inject("getSignatureStatuses", { result: { context: { slot: 2001 }, value: [status] } })
    }
    const parsed = rig.tool.input.parse(solArgs())
    const error = await rig.tool.execute(parsed, rig.ctx).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "stale" })
    expect((error as Error).message).toContain("processed but not yet confirmed")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "pending" })
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("once landed, the next send settles it confirmed and goes on with a fresh blockhash", async () => {
    const { rig, signature } = await lostAnswer()
    rig.fake.land()
    rig.mineAtMs = 2000
    const second = await rig.run(solArgs())
    expect(second.outcome).toBe("confirmed")
    const rows = await rig.rows()
    expect(rows[0]).toMatchObject({ hash: signature, outcome: "confirmed", block: "2001" })
    expect(rows[1]).toMatchObject({ outcome: "confirmed" })
    expectNoSignatureSentTwice(rig)
    expect(rig.fake.balanceOf(BOB)).toBe(2n * 10n ** 9n)
  })

  test("one that failed on the cluster settles failed, and the next send goes on", async () => {
    const { rig } = await lostAnswer()
    rig.fake.revertWhen = () => true
    rig.fake.land()
    rig.fake.revertWhen = () => false
    rig.mineAtMs = 2000
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["failed", "confirmed"])
  })

  test("if it lands while the wait is on, the reply is confirmed and the row too", async () => {
    const rig = makeRig()
    rig.fake.failSend({ transport: "timeout", accepted: true })
    const result = await rig.run(solArgs())
    expect(result.outcome).toBe("confirmed")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "confirmed", hash: result.signature })
  })
})

describe("a node that refuses the transaction", () => {
  test("rejects the row and fails the call with the ledger row's id, saying nothing was sent", async () => {
    const rig = makeRig()
    rig.fake.failSend(NODE_REFUSAL)
    const error = await rig.run(solArgs()).catch((caught: unknown) => caught)
    const [row] = await rig.rows()
    expect(error).toMatchObject({ code: "upstream_error", details: { ledger_row: row!.id } })
    expect((error as Error).message).toStartWith("The cluster refused the transaction: ")
    expect((error as Error).message).toContain("Blockhash not found")
    expect((error as Error).message).toEndWith("Nothing was sent.")
    expect(row).toMatchObject({ outcome: "rejected", note: "The cluster refused it; nothing was sent." })
    expect(rig.sleeps).toEqual([])
  })

  test("the same transaction is never signed again under the blockhash that was refused", async () => {
    const rig = makeRig()
    rig.fake.failSend(NODE_REFUSAL)
    await rig.run(solArgs()).catch(() => undefined)
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(1)
    expect(await rig.rows()).toHaveLength(1)

    rig.fake.advance(1)
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["rejected", "confirmed"])
    expectNoSignatureSentTwice(rig)
  })

  test.each([
    [-32002, "Transaction simulation failed: Insufficient funds for fee"],
    [-32002, "Transaction simulation failed: Account in use"],
    [-32002, "Transaction simulation failed: Error processing Instruction 1: invalid account data for instruction"],
    [-32003, "Transaction signature verification failure"],
    [-32000, "Blockhash not found"],
  ])("the refusal %d %p says the node did not take it", async (code, message) => {
    const rig = makeRig()
    rig.fake.failSend({ reject: { code, message } })
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "upstream_error" })
    expect((await rig.rows())[0]!.outcome).toBe("rejected")
  })

  test("never repeats what the node said of the transaction itself", async () => {
    const rig = makeRig()
    rig.beforeRequest = (method, params) => {
      if (method === "sendTransaction") {
        const message = `Transaction simulation failed: bad ${String(params[0])} and ${base58.encode(new Uint8Array(64).fill(9))}`
        rig.fake.inject("sendTransaction", { error: { code: -32002, message } })
      }
    }
    const error = await rig.run(solArgs()).catch((caught: unknown) => caught)
    const raw = rig.broadcasts()[0]!
    expect(error).toMatchObject({ code: "upstream_error" })
    expect((error as Error).message).not.toContain(raw.slice(0, 80))
    expect((error as Error).message).not.toContain(base58.encode(new Uint8Array(64).fill(9)).slice(0, 40))
    expect((error as Error).message.length).toBeLessThan(400)
    expect(holdsKeyMaterial(error)).toBe(false)
  })

  test("a refusal that does not say the node left it out keeps the row unknown, and the next send waits", async () => {
    const rig = makeRig()
    rig.fake.failSend({ reject: { code: -32603, message: "Internal error" } })
    rig.mineAtMs = undefined
    const result = await rig.run(solArgs())
    expect(result.outcome).toBe("pending")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "unknown", note: null })
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "stale" })
    rig.fake.advance(BLOCKHASH_EXPIRED)
    rig.mineAtMs = 2000
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((row) => row.outcome)).toEqual(["rejected", "confirmed"])
  })

  test("'already processed' means the cluster has it: the row is pending and the call goes on", async () => {
    const rig = makeRig()
    const message = "Transaction simulation failed: This transaction has already been processed"
    rig.fake.failSend({ reject: { code: -32002, message } })
    rig.mineAtMs = undefined
    const result = await rig.run(solArgs())
    expect(result.outcome).toBe("pending")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "pending", note: null })
  })

  test("another signature than the signed one is noted, and the signed one is kept", async () => {
    const rig = makeRig()
    const other = base58.encode(new Uint8Array(64).fill(4))
    rig.fake.inject("sendTransaction", { result: other })
    rig.mineAtMs = undefined
    const result = await rig.run(solArgs())
    const [row] = await rig.rows()
    expect(result).toMatchObject({ outcome: "pending", signature: signaturesOf(rig)[0] })
    expect(row).toMatchObject({ outcome: "pending", hash: result.signature })
    expect(row!.note).toContain("another signature")
    expect(row!.hash).not.toBe(other)
  })
})
