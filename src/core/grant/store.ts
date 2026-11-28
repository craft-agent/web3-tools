import { createHmac, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { isRecord } from "../describe"
import { ToolError } from "../errors"
import { hasSystemCode, withLock as withNamedLock, withReadLock as withNamedReadLock, writeAtomic } from "../lock"
import type { HeldLock, LockOptions } from "../lock"
import { canonicalJson } from "../pin"
import type { Grant } from "./model"
import { grantRefusal } from "./match"

export { hasSystemCode, writeAtomic }
export type { HeldLock }

/** Where grants and their use are kept, and the key that signs them. */
export type GrantStoreOptions = {
  /** The directory grants and their log are kept in; created (mode 0o700) when missing. */
  dir: string
  /** The HMAC key; absent means no key is set. */
  key: Buffer | undefined
}

/** The only version of `grants.json` this package reads and writes. */
const GRANTS_VERSION = 1

const GRANTS_FILE = "grants.json"

const GRANTS_LOCK: LockOptions = { name: "grants" }

const grantSchema = z.object({
  id: z.string(),
  tool: z.string(),
  targets: z.array(z.string()),
  bounds: z.record(z.string(), z.union([z.number(), z.boolean(), z.array(z.string())])),
  rate: z.number().int().min(1).nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  reason: z.string(),
})

/** What a file in the directory holds when it was changed outside the package. */
export function tamperedError(): ToolError {
  return new ToolError("forbidden", grantRefusal("tampered", "").message, { details: { reason: "tampered" } })
}

/** The refusal when no key is set, for a caller that knows no tool. */
export function noKeyError(): ToolError {
  return new ToolError("forbidden", "No grant key is set, so grants cannot be read or written.", {
    details: { reason: "no_key" },
  })
}

/** The key of the options; `forbidden` when none is set. */
export function requireKey(options: GrantStoreOptions): Buffer {
  if (options.key === undefined) throw noKeyError()
  return options.key
}

/** The lowercase hex HMAC-SHA256 of a value's canonical JSON. */
export function macOf(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex")
}

/** Whether `mac` is the MAC of `value`, compared in constant time. */
export function macMatches(key: Buffer, value: unknown, mac: unknown): boolean {
  if (typeof mac !== "string") return false
  const expected = Buffer.from(macOf(key, value))
  const given = Buffer.from(mac)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** Runs `fn` under the grants directory's lock, which a call waits 5 seconds for; see `withLock` in `../lock`. */
export function withLock<T>(dir: string, fn: (lock: HeldLock) => Promise<T>): Promise<T> {
  return withNamedLock(dir, fn, GRANTS_LOCK)
}

/** Runs `fn` as a reader under the grants directory's lock; see `withReadLock` in `../lock`. */
export function withReadLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withNamedReadLock(dir, fn, GRANTS_LOCK)
}

/** The entries of `grants.json` as stored; none when the file is missing, and tampered when it is not `{ version, grants }`. */
async function readEntries(dir: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(join(dir, GRANTS_FILE), "utf8")
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return []
    throw error
  }
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    throw tamperedError()
  }
  if (!isRecord(file) || file.version !== GRANTS_VERSION || !Array.isArray(file.grants)) throw tamperedError()
  return file.grants
}

async function writeEntries(dir: string, grants: unknown[], lock: HeldLock): Promise<void> {
  await writeAtomic(join(dir, GRANTS_FILE), `${JSON.stringify({ version: GRANTS_VERSION, grants }, null, 2)}\n`, lock)
}

function entryId(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.id === "string" && entry.id !== "" ? entry.id : undefined
}

function verifiedGrant(key: Buffer, entry: unknown): Grant | undefined {
  if (!isRecord(entry)) return undefined
  const { mac, ...grant } = entry
  if (!macMatches(key, grant, mac)) return undefined
  const parsed = grantSchema.safeParse(grant)
  return parsed.success ? parsed.data : undefined
}

/**
 * Reads the grants. A grant whose MAC or shape fails is left out of `grants`
 * and its id (`?` when it has none) is listed in `failed`; a missing file holds
 * none. A file that is not valid JSON, or not `{ version: 1, grants: [] }`, is
 * `forbidden` as tampered; so is a missing key.
 */
export async function readGrants(options: GrantStoreOptions): Promise<{ grants: Grant[]; failed: string[] }> {
  const key = requireKey(options)
  const grants: Grant[] = []
  const failed: string[] = []
  for (const entry of await readEntries(options.dir)) {
    const grant = verifiedGrant(key, entry)
    if (grant) grants.push(grant)
    else failed.push(entryId(entry) ?? "?")
  }
  return { grants, failed }
}

/** Signs a grant and adds it to the file, keeping the entries already there as they are, whether or not they verify. */
export async function addGrant(options: GrantStoreOptions, grant: Grant): Promise<void> {
  const { dir } = options
  const key = requireKey(options)
  await withLock(dir, async (lock) => {
    const entries = await readEntries(dir)
    await writeEntries(dir, [...entries, { ...grant, mac: macOf(key, grant) }], lock)
  })
}

/**
 * Removes the grant with this id, even when its MAC fails, since revoking only
 * narrows what runs and needs no key. True when one was removed. A file that is
 * not valid JSON is `forbidden` as tampered.
 */
export async function removeGrant(options: GrantStoreOptions, id: string): Promise<boolean> {
  const { dir } = options
  return withLock(dir, async (lock) => {
    const entries = await readEntries(dir)
    const kept = entries.filter((entry) => entryId(entry) !== id)
    if (kept.length === entries.length) return false
    await writeEntries(dir, kept, lock)
    return true
  })
}
