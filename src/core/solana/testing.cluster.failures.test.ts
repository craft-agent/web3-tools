import { describe, expect, test } from "bun:test"
import { toolError } from "../rpc/client.fixtures"
import { signatureStatus } from "./reads"
import { signedTransactionBase64 } from "./testing.cluster.sign"
import { ALICE, BOB, funded, refusalOf, send, transfer } from "./testing.cluster.send.fixtures"

describe("failures injected into a send", () => {
  test("`reject` answers the node error and accepts nothing", async () => {
    const cluster = funded().failSend({ reject: { code: -32005, message: "Node is behind by 100 slots" } })
    const refusal = await refusalOf(send(cluster, signedTransactionBase64(transfer(cluster, 1n), ALICE)))
    expect(refusal.rpc).toMatchObject({ code: -32005, message: "Node is behind by 100 slots" })
    expect(cluster.pending).toHaveLength(0)
  })

  test("an HTTP 500 that did not accept, and a time-out that did not, leave nothing pending", async () => {
    const cluster = funded().failSend(
      { transport: "http500", accepted: false },
      { transport: "timeout", accepted: false },
    )
    const text = signedTransactionBase64(transfer(cluster, 1n), ALICE)
    expect((await toolError(send(cluster, text))).message).toContain("HTTP 500")
    expect((await toolError(send(cluster, text))).message).toContain("did not answer")
    expect(cluster.pending).toHaveLength(0)
  })

  test("a time-out after accepting leaves the transaction pending, and it lands: the caller cannot tell until it asks", async () => {
    const cluster = funded().failSend({ transport: "timeout", accepted: true })
    const text = signedTransactionBase64(transfer(cluster, 1_000_000n), ALICE)
    expect((await toolError(send(cluster, text))).message).toContain("did not answer")
    expect(cluster.pending).toHaveLength(1)
    const [landed] = cluster.land()
    expect(await signatureStatus(cluster.client(), landed.signature)).toMatchObject({ err: null })
    expect((await refusalOf(send(cluster, text))).message).toContain("already been processed")
  })

  test("an HTTP 500 after accepting leaves it pending too", async () => {
    const cluster = funded().failSend({ transport: "http500", accepted: true })
    await toolError(send(cluster, signedTransactionBase64(transfer(cluster, 1n), ALICE)))
    expect(cluster.pending).toHaveLength(1)
  })

  test("a drop answers the signature and forgets the transaction: it never lands, and its blockhash expires", async () => {
    const cluster = funded().failSend("drop")
    const text = signedTransactionBase64(transfer(cluster, 1_000n), ALICE)
    const signature = await send(cluster, text)
    expect(cluster.pending).toHaveLength(0)
    expect(cluster.land()).toEqual([])
    expect(await signatureStatus(cluster.client(), signature)).toBeNull()
    cluster.advance(151)
    expect((await refusalOf(send(cluster, text))).message).toContain("Blockhash not found")
    expect(cluster.balanceOf(BOB.address)).toBe(0n)
  })

  test("failures are used once each, in order", async () => {
    const cluster = funded().failSend({ reject: { code: -32005, message: "busy" } }, "drop")
    const text = signedTransactionBase64(transfer(cluster, 1n), ALICE)
    await refusalOf(send(cluster, text))
    await send(cluster, text)
    expect(cluster.pending).toHaveLength(0)
    await send(cluster, text)
    expect(cluster.pending).toHaveLength(1)
  })
})

describe("time in the fake", () => {
  test("advance expires the blockhash of a pending transaction, which is then forgotten and never lands", async () => {
    const cluster = funded()
    await send(cluster, signedTransactionBase64(transfer(cluster, 1_000n), ALICE))
    cluster.advance(150)
    expect(cluster.pending).toHaveLength(1)
    cluster.advance(1)
    expect(cluster.pending).toHaveLength(0)
    expect(cluster.land()).toEqual([])
    expect(cluster.balanceOf(BOB.address)).toBe(0n)
  })

  test("a transaction whose blockhash is on its last valid height still lands in the next block's", async () => {
    const cluster = funded()
    await send(cluster, signedTransactionBase64(transfer(cluster, 1_000n), ALICE))
    cluster.advance(149)
    expect(cluster.land()).toHaveLength(1)
  })

  test("the latest blockhash always has 150 blocks to land, as `lastValidBlockHeight` says", async () => {
    const cluster = funded()
    const { value } = await cluster.client().call<{ value: { lastValidBlockHeight: number } }>("getLatestBlockhash")
    expect(BigInt(value.lastValidBlockHeight)).toBe(cluster.blockHeight + 150n)
  })
})
