import { evmChain } from "../chains/evm"
import { solanaChain } from "../chains/solana"
import { ToolError } from "../errors"
import { evmClient, solanaClient, type ClientOptions, type FetchLike, type JsonRpcClient } from "./client"
import { ALCHEMY_KEY_VARIABLE, HELIUS_KEY_VARIABLE, type Env } from "./providers"
import { fakeRpc, type FakeRpcHandler, type FakeRpcRequest } from "./testing"

export const ALCHEMY_KEY = "alch-0123456789abcdef"
export const HELIUS_KEY = "helius/key+0123456789"
export const ALCHEMY_ENV: Env = { [ALCHEMY_KEY_VARIABLE]: ALCHEMY_KEY }
export const HELIUS_ENV: Env = { [HELIUS_KEY_VARIABLE]: HELIUS_KEY }

/** A promise that never settles, for a reply that never comes. */
export const NEVER = () => new Promise<never>(() => {})

/** A Base client wired to a fake node answering `methods`; `env` decides the provider. */
export function baseClient(
  methods: Record<string, FakeRpcHandler>,
  options: ClientOptions = {},
): { client: JsonRpcClient; requests: FakeRpcRequest[] } {
  const { fetch, requests } = fakeRpc(methods)
  return { client: evmClient(evmChain("base"), { fetch, env: {}, ...options }), requests }
}

/** A client for Base through `fetch`, and one for Solana, both with the keys of `env`. */
export function clientsFor(
  fetch: FetchLike,
  env: Env,
  options: ClientOptions = {},
): { base: JsonRpcClient; solana: JsonRpcClient } {
  return {
    base: evmClient(evmChain("base"), { fetch, env, ...options }),
    solana: solanaClient(solanaChain("solana"), { fetch, env, ...options }),
  }
}

/** What a promise rejected with; fails when it resolved. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject, but it resolved")
}

/** The `ToolError` a promise rejected with; fails when it rejected with anything else. */
export async function toolError(promise: Promise<unknown>): Promise<ToolError> {
  const error = await rejection(promise)
  if (!(error instanceof ToolError)) throw new Error(`Expected a ToolError, got ${String(error)}`, { cause: error })
  return error
}

/** A reply body that streams `chunks` and then stays open, as a node that stalls does. */
export function stallingBody(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
    },
  })
}
