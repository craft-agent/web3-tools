import { describe, expect, test } from "bun:test"
import { setComputeUnitPrice } from "./instructions"
import { signatureStatus } from "./reads"
import { transferMessage } from "./reads.fixtures"
import { FakeSolanaCluster } from "./testing.cluster"
import { signedTransactionBase64 } from "./testing.cluster.sign"
import { ALICE, BOB, funded, refusalOf, send, transfer } from "./testing.cluster.send.fixtures"

describe("a signed transaction through the fake", () => {
  test("is accepted by its signature, waits as pending, and lands when asked, with its fee charged", async () => {
    const cluster = funded()
    const text = signedTransactionBase64(transfer(cluster, 1_000_000n), ALICE)
    const signature = await send(cluster, text)
    expect(cluster.pending.map((tx) => tx.signature)).toEqual([signature])
    expect(cluster.balanceOf(BOB.address)).toBe(0n)
    expect(await signatureStatus(cluster.client(), signature)).toBeNull()

    const [landed] = cluster.land()
    expect(landed).toMatchObject({ signature, err: null, fee: 5000n, unitsConsumed: 150 })
    expect(cluster.pending).toHaveLength(0)
    expect(cluster.balanceOf(BOB.address)).toBe(1_000_000n)
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n - 1_000_000n - 5000n)
    expect(await signatureStatus(cluster.client(), signature)).toEqual({
      slot: cluster.slot,
      confirmationStatus: "confirmed",
      err: null,
    })
    expect(cluster.blockHeight).toBe(1001n)
  })

  test("is charged 5000 and the priority fee on the limit, whatever the units it uses", async () => {
    const cluster = funded()
    const budget = { unitLimit: 200_000, unitPrice: 5_000n }
    await send(cluster, signedTransactionBase64(transfer(cluster, 1_000_000n, budget), ALICE))
    const [landed] = cluster.land()
    expect(landed).toMatchObject({ err: null, fee: 6000n, unitsConsumed: 450 })
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n - 1_000_000n - 6000n)
  })

  test("a transaction with no limit gets 200,000 units for each instruction", async () => {
    const cluster = funded()
    const message = transfer(cluster, 1_000_000n)
    message.instructions.unshift(setComputeUnitPrice(5_000n))
    await send(cluster, signedTransactionBase64(message, ALICE))
    expect(cluster.land()[0].fee).toBe(5000n + 1000n)
  })

  test("is charged on failure as on success: an instruction that fails keeps the fee and nothing else", async () => {
    const cluster = funded(1_000_000n)
    const budget = { unitLimit: 200_000, unitPrice: 5_000n }
    await send(cluster, signedTransactionBase64(transfer(cluster, 2_000_000n, budget), ALICE))
    const [landed] = cluster.land()
    expect(landed.err).toEqual({ InstructionError: [2, { Custom: 1 }] })
    expect(landed.fee).toBe(6000n)
    expect(cluster.balanceOf(ALICE.address)).toBe(1_000_000n - 6000n)
    expect(cluster.balanceOf(BOB.address)).toBe(0n)
    expect(cluster.statusOf(landed.signature)?.err).toEqual(landed.err)
  })

  test("a limit lower than the units used fails with the budget exceeded and is charged for the limit", async () => {
    const cluster = funded()
    await send(
      cluster,
      signedTransactionBase64(transfer(cluster, 1_000_000n, { unitLimit: 200, unitPrice: 10_000_000n }), ALICE),
    )
    const [landed] = cluster.land()
    expect(landed.err).toEqual({ InstructionError: [1, "ComputationalBudgetExceeded"] })
    expect(landed).toMatchObject({ unitsConsumed: 200, fee: 7000n })
    expect(cluster.balanceOf(BOB.address)).toBe(0n)
  })

  test("`revertWhen` lands a transaction with an error: the fee is charged and no effect is kept", async () => {
    const cluster = funded()
    cluster.revertWhen = (tx) => tx.message.feePayer === ALICE.address
    await send(cluster, signedTransactionBase64(transfer(cluster, 1_000_000n), ALICE))
    const [landed] = cluster.land()
    expect(landed.err).not.toBeNull()
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n - 5000n)
    expect(cluster.balanceOf(BOB.address)).toBe(0n)
    expect((await signatureStatus(cluster.client(), landed.signature))?.err).toEqual(landed.err)
  })

  test("sending it again while it waits changes nothing, and after it landed it has already been processed", async () => {
    const cluster = funded()
    const text = signedTransactionBase64(transfer(cluster, 1_000_000n), ALICE)
    const signature = await send(cluster, text)
    expect(await send(cluster, text)).toBe(signature)
    expect(cluster.pending).toHaveLength(1)
    cluster.land()
    const refusal = await refusalOf(send(cluster, text))
    expect(refusal.rpc.code).toBe(-32002)
    expect(refusal.message).toContain("already been processed")
    expect(cluster.balanceOf(BOB.address)).toBe(1_000_000n)
  })

  test("the pending transactions land in arrival order, each charged, in one block", async () => {
    const cluster = funded()
    const first = await send(cluster, signedTransactionBase64(transfer(cluster, 700_000n), ALICE))
    const second = await send(cluster, signedTransactionBase64(transfer(cluster, 800_000n), ALICE))
    expect(cluster.land().map((tx) => tx.signature)).toEqual([first, second])
    expect(cluster.statusOf(first)?.slot).toBe(cluster.statusOf(second)?.slot)
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n - 1_500_000n - 2n * 5000n)
  })
})

describe("what the fake refuses on arrival, as a node does", () => {
  test("a blockhash the cluster does not know, or one that has expired, is refused: Blockhash not found", async () => {
    const cluster = funded()
    const old = transfer(cluster, 1n)
    cluster.advance(150)
    expect(await send(cluster, signedTransactionBase64(old, ALICE))).toBeString()
    cluster.advance(1)
    const expired = await refusalOf(send(cluster, signedTransactionBase64(old, ALICE)))
    expect(expired.rpc.code).toBe(-32002)
    expect(expired.message).toContain("Blockhash not found")
    expect((expired.rpc.data as { err: string }).err).toBe("BlockhashNotFound")
    const unknown = { ...transfer(cluster, 1n), recentBlockhash: "11111111111111111111111111111111" }
    expect((await refusalOf(send(cluster, signedTransactionBase64(unknown, ALICE)))).message).toContain(
      "Blockhash not found",
    )
    expect(cluster.pending).toHaveLength(0)
  })

  test("a signature that does not verify is refused", async () => {
    const cluster = funded()
    const forged = signedTransactionBase64(transfer(cluster, 1n), BOB)
    const refusal = await refusalOf(send(cluster, forged))
    expect(refusal.rpc.code).toBe(-32003)
    expect(refusal.message).toContain("signature verification failure")
    const bytes = Buffer.from(signedTransactionBase64(transfer(cluster, 1n), ALICE), "base64")
    bytes[bytes.length - 1] ^= 1
    expect((await refusalOf(send(cluster, bytes.toString("base64")))).rpc.code).toBe(-32003)
    expect(cluster.pending).toHaveLength(0)
  })

  test("something that is not a transaction is refused as invalid params", async () => {
    const cluster = funded()
    for (const text of ["!!", "", Buffer.from([1, 2, 3]).toString("base64")]) {
      const refusal = await refusalOf(send(cluster, text))
      expect(refusal.rpc.code).toBe(-32602)
      expect(refusal.message).toContain("invalid transaction")
    }
  })

  test("a fee payer with no account, or too few lamports for the fee, is refused", async () => {
    const cluster = new FakeSolanaCluster()
    const missing = await refusalOf(send(cluster, signedTransactionBase64(transfer(cluster, 1n), ALICE)))
    expect(missing.message).toContain("no record of a prior credit")
    expect((missing.rpc.data as { err: string }).err).toBe("AccountNotFound")
    cluster.setBalance(ALICE.address, 4_999n)
    const poor = await refusalOf(send(cluster, signedTransactionBase64(transfer(cluster, 1n), ALICE)))
    expect((poor.rpc.data as { err: string }).err).toBe("InsufficientFundsForFee")
  })

  test("a transaction whose instructions would fail is accepted, and lands with the error", async () => {
    const cluster = funded(10_000n)
    await send(cluster, signedTransactionBase64(transfer(cluster, 9_000n), ALICE))
    expect(cluster.land()[0].err).toEqual({ InstructionError: [0, { Custom: 1 }] })
  })
})

describe("rent in the fake", () => {
  test("a transfer that leaves a new account below the rent-exempt minimum fails, and one of the minimum lands", async () => {
    const cluster = funded()
    await send(cluster, signedTransactionBase64(transfer(cluster, 650_239n), ALICE))
    const [short] = cluster.land()
    expect(short.err).toEqual({ InsufficientFundsForRent: { account_index: 1 } })
    expect(cluster.balanceOf(BOB.address)).toBe(0n)
    expect(cluster.balanceOf(ALICE.address)).toBe(10_000_000n - 5000n)

    await send(cluster, signedTransactionBase64(transfer(cluster, 650_240n), ALICE))
    expect(cluster.land()[0].err).toBeNull()
    expect(cluster.balanceOf(BOB.address)).toBe(650_240n)
  })

  test("a transfer that leaves the sender between 0 and the minimum fails, and one that empties it does not", async () => {
    const cluster = funded(1_000_000n)
    await send(cluster, signedTransactionBase64(transfer(cluster, 1_000_000n - 5000n - 650_239n), ALICE))
    expect(cluster.land()[0].err).toEqual({ InsufficientFundsForRent: { account_index: 0 } })
    expect(cluster.balanceOf(ALICE.address)).toBe(995_000n)
    await send(cluster, signedTransactionBase64(transfer(cluster, 995_000n - 5000n), ALICE))
    expect(cluster.land()[0].err).toBeNull()
    expect(cluster.balanceOf(ALICE.address)).toBe(0n)
    expect(cluster.entryAt(ALICE.address)).toBeUndefined()
  })

  test("the rent is the configured rate's: a cheaper rate lets a smaller transfer create an account", async () => {
    const cluster = funded()
    cluster.lamportsPerByte = 1000n
    await send(cluster, signedTransactionBase64(transfer(cluster, 128_000n), ALICE))
    expect(cluster.land()[0].err).toBeNull()
  })

  test("an account that was already below the minimum may pay out, and may not take more", async () => {
    const cluster = funded(100_000n).setBalance(BOB.address, 1_000_000n)
    await send(cluster, signedTransactionBase64(transfer(cluster, 10_000n), ALICE))
    expect(cluster.land()[0].err).toBeNull()
    expect(cluster.balanceOf(ALICE.address)).toBe(100_000n - 10_000n - 5000n)
    const back = transferMessage(cluster.latestBlockhash, BOB.address, ALICE.address, 10_000n)
    await send(cluster, signedTransactionBase64(back, BOB))
    expect(cluster.land()[0].err).toEqual({ InsufficientFundsForRent: { account_index: 1 } })
    expect(cluster.balanceOf(ALICE.address)).toBe(85_000n)
  })
})
