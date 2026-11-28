import { bytesToHex, hexToBytes } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { rmSync } from "node:fs"
import { approvalOf, checkPin, type Approval } from "../../entry/pin"
import type { z } from "zod"
import { readLedger } from "../ledger/store"
import type { FetchLike } from "../rpc/client"
import type { ToolRuntime } from "../runtime"
import { ABANDON_PHRASE, fakeRuntime, HARDHAT_KEY_0, makeStateDir } from "../signer/testing"
import { invoke, type ToolContext } from "../tool"
import { defineEvmSend } from "./send"
import type { sendOutput } from "./send.schema"
import { FakeEvmChain } from "./testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"
import { WAIT_POLL_MS } from "./send.wait"

export const GWEI = 10n ** 9n
export const ETHER = 10n ** 18n

/** A token address, as Base's USDC is written. */
export const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

/** A fee ceiling that covers a plain transfer and a token's transfer with room to spare, in wei. */
export const MAX_FEE = "200000000000000"

/** The clock of the fixtures, in epoch milliseconds. */
export const NOW = Date.parse("2026-06-01T12:00:00.000Z")

/** How long a hanging request is left to hang before the fixture's fetch gives up on it, in milliseconds. */
const HANG_LIMIT_MS = 25

/** The result of the tool. */
export type SendResult = z.output<typeof sendOutput>

/** The hash of a raw transaction, as a node and the ledger know it. */
export function hashOfRaw(raw: string): string {
  return `0x${bytesToHex(keccak_256(hexToBytes(raw.slice(2))))}`
}

/** The raw arguments of a send from the wallet `main` to Hardhat's second account. */
export function nativeArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { chain: "ethereum", account: "main", to: HARDHAT_ADDRESS_1, amount: "1", max_fee: MAX_FEE, ...changes }
}

/** The raw arguments of a send of `TOKEN_ADDRESS`. */
export function tokenArgs(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return nativeArgs({ token: TOKEN_ADDRESS, amount: "5", ...changes })
}

/** A send tool wired to a fake chain, a fresh state directory, a clock and a wait that mines instead of waiting. */
export type SendRig = {
  fake: FakeEvmChain
  stateDir: string
  runtime: ToolRuntime
  /** The call's context; a test may replace it between calls. */
  ctx: ToolContext
  tool: ReturnType<typeof defineEvmSend>
  /** The pauses the wait asked for, in order. */
  sleeps: number[]
  /** The fake chain mines a block once the wait has paused this long in all (the first poll's pause by default); never, when `undefined`. */
  mineAtMs: number | undefined
  /** Runs before every request reaches the fake, so a test can change the chain at an exact step of a call. */
  beforeRequest: RequestHook | undefined
  /** Gives the next calls a cancellation signal, and returns the controller that aborts it. */
  cancel(): AbortController
  approve(args: unknown): Promise<Approval>
  /** The whole approval flow of a native entry point: gate and approval, the pin check, then the run. */
  run(args: unknown): Promise<SendResult>
  /** Runs the call without the approval flow, as an MCP client's call is. */
  invoke(args: unknown): Promise<SendResult>
  rows(): ReturnType<typeof readLedger>
  /** The raw transactions the fake received, in order. */
  broadcasts(): string[]
}

/** What a test sees of a request before the fake does: its method and parameters. */
type RequestHook = (method: string, params: unknown[]) => void | Promise<void>

type RigOptions = {
  chain?: string
  /** Replaces the wallets: label to key, as `WEB3_TOOLS_WALLET_<LABEL>` holds them. */
  wallets?: Record<string, string>
  options?: ToolContext["options"]
}

const stateDirs: string[] = []

/** Removes the state directories the rigs made. */
export function cleanRigs(): void {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A fetch that gives up on a request the fake never answers, so a lost reply takes milliseconds, and lets a test act first. */
function impatient(fake: FakeEvmChain, hook: () => RequestHook | undefined): FetchLike {
  return async (url, init) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] }
    await hook()?.(method, params)
    return fake.fetch(url, {
      ...init,
      signal: AbortSignal.any([init.signal as AbortSignal, AbortSignal.timeout(HANG_LIMIT_MS)]),
    })
  }
}

/**
 * The wallet `main` (Hardhat's first key) and `savings` (a seed phrase) are set up, `main` holds 10 coins, and
 * a token at `TOKEN_ADDRESS` gives it 1000 of its units. The fake mines when the wait first pauses.
 */
export function makeRig({ chain = "ethereum", wallets, options }: RigOptions = {}): SendRig {
  const stateDir = makeStateDir()
  stateDirs.push(stateDir)
  const env = wallets ?? { WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0, WEB3_TOOLS_WALLET_SAVINGS: ABANDON_PHRASE }
  const runtime = fakeRuntime(env, { now: () => NOW })
  const fake = new FakeEvmChain(chain).setBalance(HARDHAT_ADDRESS_0, 10n * ETHER)
  fake.addErc20(TOKEN_ADDRESS, { balances: { [HARDHAT_ADDRESS_0]: 1000n * ETHER }, symbol: "TKN" })
  const ctx: ToolContext = { cwd: process.cwd(), runtime, stateDir, ...(options && { options }) }
  const sleeps: number[] = []
  const rig: SendRig = {
    fake,
    stateDir,
    runtime,
    ctx,
    sleeps,
    mineAtMs: WAIT_POLL_MS,
    beforeRequest: undefined,
    tool: defineEvmSend({
      fetch: impatient(fake, () => rig.beforeRequest),
      env: {},
      sleep: async (ms, signal) => {
        signal?.throwIfAborted()
        const before = sleeps.reduce((total, paused) => total + paused, 0)
        sleeps.push(ms)
        if (rig.mineAtMs !== undefined && before < rig.mineAtMs && before + ms >= rig.mineAtMs) fake.mine()
      },
    }),
    cancel() {
      const controller = new AbortController()
      rig.ctx = { ...rig.ctx, signal: controller.signal }
      return controller
    },
    approve: (args) => approvalOf(rig.tool, args, rig.ctx),
    async run(args) {
      const approval = await rig.approve(args)
      if (approval.refused) throw approval.refused
      await checkPin(rig.tool, args, rig.ctx, approval.pin)
      return rig.invoke(args)
    },
    invoke(args) {
      sleeps.length = 0
      return invoke(rig.tool, args, rig.ctx)
    },
    rows: () => readLedger(stateDir),
    broadcasts: () => fake.requestsOf("eth_sendRawTransaction").map(([raw]) => String(raw)),
  }
  return rig
}
