import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { invoke } from "../tool"
import { defineEvmRead } from "./read"
import { cleanRigs, ETHER, makeRig, nativeArgs, type SendRig } from "./send.testing"
import { FakeEvmChain } from "./testing"
import { EXAMPLE_REQUEST, HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1, signWithHardhat } from "./testing.sign"

afterEach(cleanRigs)

const CTX = { cwd: process.cwd() }
const UNKNOWN_HASH = `0x${"ab".repeat(32)}`

function fakeChain(): FakeEvmChain {
  return new FakeEvmChain("ethereum").setBalance(HARDHAT_ADDRESS_0, 10n * ETHER)
}

/** A transfer the fake's node takes into its pool, and its hash. */
async function broadcastTransfer(fake: FakeEvmChain): Promise<string> {
  const { raw } = await signWithHardhat({ ...EXAMPLE_REQUEST, chainId: 1 })
  return fake.client().call<string>("eth_sendRawTransaction", [raw])
}

function readTransaction(fake: FakeEvmChain, hash: string, ctx: Parameters<typeof invoke>[2] = CTX) {
  return invoke(defineEvmRead({ fetch: fake.fetch, env: {} }), { method: "transaction", chain: "ethereum", hash }, ctx)
}

describe("the status of a transaction", () => {
  test("pending while the node holds it without a result", async () => {
    const fake = fakeChain()
    const hash = await broadcastTransfer(fake)
    expect((await readTransaction(fake, hash)).transaction).toEqual({
      chain: "ethereum",
      hash,
      status: "pending",
      block: null,
      confirmations: null,
      explorer: `https://etherscan.io/tx/${hash}`,
      ledger: null,
    })
  })

  test("confirmed with its block, and a confirmation for every block since, its own included", async () => {
    const fake = fakeChain()
    const hash = await broadcastTransfer(fake)
    fake.mine()
    expect((await readTransaction(fake, hash)).transaction).toMatchObject({
      status: "confirmed",
      block: "101",
      confirmations: 1,
    })
    fake.mine()
    fake.mine()
    fake.mine()
    expect((await readTransaction(fake, hash)).transaction).toMatchObject({ block: "101", confirmations: 4 })
  })

  test("failed when it landed and reverted", async () => {
    const fake = fakeChain()
    fake.revertWhen = () => true
    const hash = await broadcastTransfer(fake)
    fake.mine()
    expect((await readTransaction(fake, hash)).transaction).toMatchObject({
      status: "failed",
      block: "101",
      confirmations: 1,
    })
  })

  test("not_found when the node knows nothing of it", async () => {
    expect((await readTransaction(fakeChain(), UNKNOWN_HASH)).transaction).toMatchObject({
      status: "not_found",
      block: null,
      confirmations: null,
      ledger: null,
    })
  })

  test("a hash in capitals is read as its lower case form", async () => {
    const fake = fakeChain()
    const hash = await broadcastTransfer(fake)
    const upper = `0x${hash.slice(2).toUpperCase()}`
    expect((await readTransaction(fake, upper)).transaction).toMatchObject({ hash, status: "pending" })
  })

  test("a node that fails is upstream_error, not a status", async () => {
    const fake = fakeChain()
    fake.inject("eth_getTransactionReceipt", { http: { status: 500, body: "Internal Server Error" } })
    await expect(readTransaction(fake, UNKNOWN_HASH)).rejects.toMatchObject({ code: "upstream_error" })
  })
})

describe("what the ledger adds", () => {
  async function sentRig(): Promise<{ rig: SendRig; hash: string }> {
    const rig = makeRig()
    const { hash } = await rig.run(nativeArgs())
    return { rig, hash }
  }

  test("the row of a send the tools made, left as it was", async () => {
    const { rig, hash } = await sentRig()
    const before = await rig.rows()
    const read = defineEvmRead({ fetch: rig.fake.fetch, env: {} })
    const { transaction } = await invoke(read, { method: "transaction", chain: "ethereum", hash }, rig.ctx)
    const [row] = before
    expect(transaction).toMatchObject({ status: "confirmed", block: "101" })
    expect(transaction?.ledger).toEqual({
      row: row!.id,
      outcome: "confirmed",
      kind: "native",
      sender: HARDHAT_ADDRESS_0,
      recipient: HARDHAT_ADDRESS_1,
      token: null,
      amount: String(ETHER),
      nonce: "0",
      created_at: row!.created_at,
      updated_at: row!.updated_at,
    })
    expect(await rig.rows()).toEqual(before)
  })

  test("a send still pending is pending on both sides", async () => {
    const rig = makeRig()
    rig.mineAtMs = undefined
    const { hash, outcome } = await rig.run(nativeArgs())
    expect(outcome).toBe("pending")
    const read = defineEvmRead({ fetch: rig.fake.fetch, env: {} })
    const { transaction } = await invoke(read, { method: "transaction", chain: "ethereum", hash }, rig.ctx)
    expect(transaction).toMatchObject({ status: "pending", block: null, ledger: { outcome: "pending" } })
  })

  test("nothing for a hash the tools did not send, and no ledger made by looking", async () => {
    const rig = makeRig()
    const read = defineEvmRead({ fetch: rig.fake.fetch, env: {} })
    const { transaction } = await invoke(
      read,
      { method: "transaction", chain: "ethereum", hash: UNKNOWN_HASH },
      rig.ctx,
    )
    expect(transaction?.ledger).toBeNull()
    expect(existsSync(`${rig.stateDir}/ledger`)).toBe(false)
  })

  test("nothing where the call has no runtime or state directory", async () => {
    const { rig, hash } = await sentRig()
    const read = defineEvmRead({ fetch: rig.fake.fetch, env: {} })
    const { transaction } = await invoke(read, { method: "transaction", chain: "ethereum", hash }, CTX)
    expect(transaction).toMatchObject({ status: "confirmed", ledger: null })
  })
})

describe("the arguments of the transaction method", () => {
  test.each([
    ["too short", "0x123"],
    ["without 0x", "ab".repeat(32)],
    ["not hex", `0x${"g".repeat(64)}`],
    ["a digit short", `0x${"a".repeat(63)}`],
    ["a digit over", `0x${"a".repeat(65)}`],
    ["empty", ""],
  ])("a hash %s is invalid_argument", async (_what, hash) => {
    const fake = fakeChain()
    await expect(readTransaction(fake, hash)).rejects.toMatchObject({ code: "invalid_argument" })
    expect(fake.requests).toHaveLength(0)
  })

  test("it needs a chain and a hash", async () => {
    const read = defineEvmRead({ env: {} })
    await expect(invoke(read, { method: "transaction", chain: "ethereum" }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
    })
    await expect(invoke(read, { method: "transaction", hash: UNKNOWN_HASH }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
    })
    await expect(
      invoke(read, { method: "transaction", chain: "nowhere", hash: UNKNOWN_HASH }, CTX),
    ).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("the chains method takes neither", async () => {
    const read = defineEvmRead({ env: {} })
    await expect(invoke(read, { method: "chains", hash: UNKNOWN_HASH }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("takes no `hash`"),
    })
    await expect(invoke(read, { method: "chains", chain: "ethereum" }, CTX)).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })
})
