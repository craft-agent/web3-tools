import { afterEach, describe, expect, test } from "bun:test"
import { base58 } from "@scure/base"
import { existsSync } from "node:fs"
import { invoke } from "../tool"
import { defineSolanaRead } from "./read"
import { BOB, cleanRigs, MAIN_ADDRESS, makeRig, solArgs, type SendRig } from "./send.testing"
import { FakeSolanaCluster } from "./testing.cluster"

afterEach(cleanRigs)

const CTX = { cwd: process.cwd() }
const UNKNOWN_SIGNATURE = base58.encode(new Uint8Array(64).fill(9))

/** A status the cluster gives a transaction it has only processed. */
const PROCESSED = {
  slot: 1001,
  confirmations: 0,
  err: null,
  status: { Ok: null },
  confirmationStatus: "processed",
}

function readOf(rig: SendRig) {
  return defineSolanaRead({ fetch: rig.fake.fetch, env: {} })
}

function readTransaction(rig: SendRig, signature: string, chain = "solana") {
  return invoke(readOf(rig), { method: "transaction", chain, signature }, rig.ctx)
}

/** A rig whose send is out and not yet landed, as a send that came back pending. */
async function pendingRig(): Promise<{ rig: SendRig; signature: string }> {
  const rig = makeRig()
  rig.mineAtMs = undefined
  const { signature, outcome } = await rig.run(solArgs())
  expect(outcome).toBe("pending")
  return { rig, signature }
}

describe("the status of a transaction", () => {
  test("confirmed with its slot", async () => {
    const rig = makeRig()
    const { signature } = await rig.run(solArgs())
    const { transaction } = await readTransaction(rig, signature)
    expect(transaction).toMatchObject({
      chain: "solana",
      signature,
      status: "confirmed",
      slot: "2001",
      confirmation_status: "confirmed",
      explorer: `https://explorer.solana.com/tx/${signature}`,
    })
  })

  test("failed when it landed with an error", async () => {
    const rig = makeRig()
    rig.fake.revertWhen = () => true
    const { signature } = await rig.run(solArgs())
    expect((await readTransaction(rig, signature)).transaction).toMatchObject({ status: "failed", slot: "2001" })
  })

  test("pending while the cluster has only processed it", async () => {
    const fake = new FakeSolanaCluster()
    fake.inject("getSignatureStatuses", { result: { context: { slot: 1001 }, value: [PROCESSED] } })
    const read = defineSolanaRead({ fetch: fake.fetch, env: {} })
    const { transaction } = await invoke(
      read,
      { method: "transaction", chain: "solana", signature: UNKNOWN_SIGNATURE },
      CTX,
    )
    expect(transaction).toMatchObject({
      status: "pending",
      slot: "1001",
      confirmation_status: "processed",
      ledger: null,
    })
  })

  test("not_found when the cluster knows nothing and the ledger has no row", async () => {
    const rig = makeRig()
    expect((await readTransaction(rig, UNKNOWN_SIGNATURE)).transaction).toEqual({
      chain: "solana",
      signature: UNKNOWN_SIGNATURE,
      status: "not_found",
      slot: null,
      confirmation_status: null,
      explorer: `https://explorer.solana.com/tx/${UNKNOWN_SIGNATURE}`,
      ledger: null,
    })
  })

  test("a devnet signature links to the devnet cluster", async () => {
    const rig = makeRig({ chain: "solana-devnet" })
    const { signature } = await rig.run(solArgs({ chain: "solana-devnet" }))
    const { transaction } = await readTransaction(rig, signature, "solana-devnet")
    expect(transaction?.explorer).toBe(`https://explorer.solana.com/tx/${signature}?cluster=devnet`)
  })

  test("a cluster that fails is upstream_error, not a status", async () => {
    const rig = makeRig()
    rig.fake.inject("getSignatureStatuses", { http: { status: 500, body: "down" } })
    await expect(readTransaction(rig, UNKNOWN_SIGNATURE)).rejects.toMatchObject({ code: "upstream_error" })
  })
})

describe("what the ledger adds", () => {
  test("the row of a send the tools made, left as it was", async () => {
    const rig = makeRig()
    const { signature } = await rig.run(solArgs())
    const before = await rig.rows()
    const [row] = before
    const { transaction } = await readTransaction(rig, signature)
    expect(transaction?.ledger).toEqual({
      row: row!.id,
      outcome: "confirmed",
      kind: "sol",
      sender: MAIN_ADDRESS,
      recipient: BOB,
      token: null,
      amount: "1000000000",
      last_valid_height: row!.last_valid_height,
      created_at: row!.created_at,
      updated_at: row!.updated_at,
    })
    expect(await rig.rows()).toEqual(before)
  })

  test("a send the cluster does not know yet is pending while its blockhash is valid", async () => {
    const { rig, signature } = await pendingRig()
    expect((await readTransaction(rig, signature)).transaction).toMatchObject({
      status: "pending",
      slot: null,
      confirmation_status: null,
      ledger: { outcome: "pending" },
    })
  })

  test("a send the cluster does not know past its last valid height is expired, its row left as it was", async () => {
    const { rig, signature } = await pendingRig()
    const before = await rig.rows()
    rig.fake.advance(200)
    expect((await readTransaction(rig, signature)).transaction).toMatchObject({
      status: "expired",
      ledger: { outcome: "pending" },
    })
    expect(await rig.rows()).toEqual(before)
  })

  test("nothing for a signature the tools did not send, and no ledger made by looking", async () => {
    const rig = makeRig()
    const { transaction } = await readTransaction(rig, UNKNOWN_SIGNATURE)
    expect(transaction?.ledger).toBeNull()
    expect(existsSync(`${rig.stateDir}/ledger`)).toBe(false)
  })

  test("nothing where the call has no runtime or state directory", async () => {
    const rig = makeRig()
    const { signature } = await rig.run(solArgs())
    const { transaction } = await invoke(readOf(rig), { method: "transaction", chain: "solana", signature }, CTX)
    expect(transaction).toMatchObject({ status: "confirmed", ledger: null })
  })
})

describe("the arguments of the transaction method", () => {
  test.each([
    ["too short", base58.encode(new Uint8Array(32).fill(9))],
    ["too long", base58.encode(new Uint8Array(65).fill(9))],
    ["not base58", "0".repeat(88)],
    ["empty", ""],
  ])("a signature %s is invalid_argument", async (_what, signature) => {
    const rig = makeRig()
    await expect(readTransaction(rig, signature)).rejects.toMatchObject({ code: "invalid_argument" })
    expect(rig.fake.requests).toHaveLength(0)
  })

  test("it needs a chain and a signature", async () => {
    const read = defineSolanaRead({ env: {} })
    await expect(invoke(read, { method: "transaction", chain: "solana" }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
    })
    await expect(invoke(read, { method: "transaction", signature: UNKNOWN_SIGNATURE }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
    })
    await expect(
      invoke(read, { method: "transaction", chain: "nowhere", signature: UNKNOWN_SIGNATURE }, CTX),
    ).rejects.toMatchObject({ code: "invalid_argument" })
  })

  test("the chains method takes neither", async () => {
    const read = defineSolanaRead({ env: {} })
    await expect(invoke(read, { method: "chains", signature: UNKNOWN_SIGNATURE }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("takes no `signature`"),
    })
  })
})
