import { constants } from "node:fs"
import type { Stats } from "node:fs"
import { lstat, open } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { isToolError, ToolError } from "../errors"
import type { ToolRuntime } from "../runtime"
import { parseKey, WalletKey } from "./keys"
import { checkLabel, errnoCode, walletPaths, walletVariable } from "./labels"
import type { KeySource } from "./labels"

export type { KeySource } from "./labels"

/** The largest wallet file read: far above any phrase or key, so a stray file is refused, not read whole. */
export const MAX_KEY_BYTES = 4096

/** Permission bits that let others write to a directory. */
const DIRECTORY_WRITE_BITS = 0o022

/** Permission bits of group and others; a wallet file may have none of them. */
const GROUP_OTHER_BITS = 0o077

/**
 * What a refused `open` with `O_NOFOLLOW` says of a link: `ELOOP` on Linux and
 * macOS, `EMLINK` on FreeBSD, `EFTYPE` on other BSDs.
 */
const LINK_CODES = new Set(["ELOOP", "EMLINK", "EFTYPE"])

/**
 * `O_NONBLOCK` keeps the open of a FIFO from waiting for a writer, so it ends
 * at the `fstat` check as any other file that is not a regular one.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

function noWallet(label: string, runtime: ToolRuntime): ToolError {
  const variable = walletVariable(label, runtime.envPrefix)
  return new ToolError(
    "unauthenticated",
    `No wallet "${label}": set ${variable} or run "${runtime.cli} wallet import --account ${label}".`,
  )
}

function unreadable(noun: "file" | "directory", path: string, error: unknown): ToolError {
  return new ToolError(
    "unauthenticated",
    `The wallet ${noun} ${path} could not be read (${errnoCode(error) ?? "error"}).`,
  )
}

function tooLarge(path: string): ToolError {
  return new ToolError("unauthenticated", `The wallet file ${path} is larger than ${MAX_KEY_BYTES} bytes.`)
}

/** Whether another user than the process's owns `stat`'s file, where the system has users. */
function foreignOwner(stat: Stats): boolean {
  const uid = process.getuid?.()
  return uid !== undefined && stat.uid !== uid
}

async function checkDirectory(path: string, label: string, runtime: ToolRuntime): Promise<void> {
  let stat: Stats
  try {
    stat = await lstat(path)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") throw noWallet(label, runtime)
    throw unreadable("directory", path, error)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || foreignOwner(stat) || stat.mode & DIRECTORY_WRITE_BITS) {
    throw new ToolError(
      "forbidden",
      `The wallet directory ${path} is a link, not a directory, owned by another user or writable by others; fix it before using wallet "${label}".`,
    )
  }
}

async function openWalletFile(path: string, label: string, runtime: ToolRuntime): Promise<FileHandle> {
  try {
    return await open(path, OPEN_FLAGS)
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT") throw noWallet(label, runtime)
    if (code !== undefined && LINK_CODES.has(code)) {
      throw new ToolError("forbidden", `The wallet file ${path} is a link; replace it with the file itself.`)
    }
    throw unreadable("file", path, error)
  }
}

function checkFile(stat: Stats, path: string): void {
  if (!stat.isFile()) {
    throw new ToolError("forbidden", `The wallet file ${path} is not a regular file; replace it.`)
  }
  if (foreignOwner(stat)) {
    throw new ToolError("forbidden", `The wallet file ${path} is owned by another user; only its owner may hold a key.`)
  }
  if (stat.mode & GROUP_OTHER_BITS) {
    throw new ToolError(
      "forbidden",
      `The wallet file ${path} can be read or written by other users; run chmod 600 ${JSON.stringify(path)}.`,
    )
  }
  if (stat.size > MAX_KEY_BYTES) throw tooLarge(path)
}

/** Reads the open file through `handle`, never past `MAX_KEY_BYTES`, and zeroes the bytes it read. */
async function readText(handle: FileHandle, path: string): Promise<string> {
  const bytes = new Uint8Array(MAX_KEY_BYTES + 1)
  try {
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_KEY_BYTES) throw tooLarge(path)
    return new TextDecoder().decode(bytes.subarray(0, length))
  } finally {
    bytes.fill(0)
  }
}

async function readFileText(path: string, label: string, runtime: ToolRuntime): Promise<string> {
  const handle = await openWalletFile(path, label, runtime)
  try {
    checkFile(await handle.stat(), path)
    return await readText(handle, path)
  } catch (error) {
    if (isToolError(error)) throw error
    throw unreadable("file", path, error)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Parses `text`; a failure that is not a refusal is replaced by a fixed message, since it may hold the key. */
function parseHeld(text: string, label: string): WalletKey {
  try {
    return parseKey(text, label)
  } catch (error) {
    if (isToolError(error)) throw error
    throw new ToolError("internal_error", `The signer failed while reading wallet "${label}".`)
  }
}

/**
 * The key of wallet `label` and where it came from. `<envPrefix>_WALLET_<LABEL>`
 * wins when it is defined, even empty or invalid, and the file is then never
 * read. Else the label's file, which is reached through directories that are
 * not links, owned by the process's user and not writable by others, and read
 * through one descriptor opened without following a link.
 *
 * A missing key or one that does not parse is `unauthenticated`, a file or
 * directory anyone else can reach is `forbidden`; no message holds any of the
 * key. This is the only reader of the variable and of the file.
 */
export async function readWalletKey(
  label: string,
  runtime: ToolRuntime,
  stateDir: string,
): Promise<{ source: KeySource; key: WalletKey }> {
  checkLabel(label)
  const fromVariable = runtime.env[walletVariable(label, runtime.envPrefix)]
  if (fromVariable !== undefined) return { source: "variable", key: parseHeld(fromVariable, label) }

  const paths = walletPaths(stateDir, label)
  for (const directory of [paths.root, paths.accounts, paths.dir]) {
    await checkDirectory(directory, label, runtime)
  }
  const text = await readFileText(paths.file, label, runtime)
  return { source: "file", key: parseHeld(text, label) }
}
