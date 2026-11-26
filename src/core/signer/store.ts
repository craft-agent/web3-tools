import { randomBytes } from "node:crypto"
import { link, lstat, open, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { isToolError, ToolError } from "../errors"
import { checkLabel, errnoCode, isMissingPath, walletPaths } from "./labels"
import { ensurePrivateDir } from "./private-dir"

/** Mode of a wallet file: owner read and write only. */
const WALLET_FILE_MODE = 0o600

/** Bytes of randomness in a temporary file's name: 16 hex digits. */
const TEMP_SUFFIX_BYTES = 8

const TEMP_PREFIX = ".wallet-"

const TEMP_SUFFIX = ".tmp"

/** What a write or its check was doing, for the fixed message of an unexpected failure. */
type Step = "writing" | "checking"

function alreadyExists(label: string, file: string): ToolError {
  return new ToolError(
    "invalid_argument",
    `Wallet "${label}" already exists at ${file}; a wallet is never overwritten.`,
  )
}

/**
 * `error` when it is a refusal; else a fixed message that carries no cause and
 * only the system error code, since the failure happened while the key was held.
 */
function failed(error: unknown, label: string, step: Step): ToolError {
  if (isToolError(error)) return error
  const code = errnoCode(error)
  return new ToolError(
    "internal_error",
    `The signer failed while ${step} wallet "${label}"${code === undefined ? "" : ` (${code})`}.`,
  )
}

/** Writes `text` through `handle` of a new file with mode 600, flushes it to disk and closes the handle. */
async function writeTemp(handle: FileHandle, text: string): Promise<void> {
  try {
    // The mode given to open is masked by the umask; chmod sets it exactly.
    await handle.chmod(WALLET_FILE_MODE)
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Gives `temp` the name `file` without replacing anything: a link fails when `file` exists, a rename would not. */
async function publish(temp: string, file: string, label: string): Promise<void> {
  try {
    await link(temp, file)
  } catch (error) {
    if (errnoCode(error) === "EEXIST") throw alreadyExists(label, file)
    throw error
  }
}

/** Flushes the label directory so the new name survives a crash; best effort, never an error of the write. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // The file is written; a directory that cannot be flushed is no reason to report a failure.
  }
}

/** Refuses with `invalid_argument` when anything stands at the file of wallet `label`; a missing path is fine. */
export async function refuseExistingWallet(stateDir: string, label: string): Promise<void> {
  checkLabel(label)
  const { file } = walletPaths(stateDir, label)
  try {
    await lstat(file)
  } catch (error) {
    if (isMissingPath(error)) return
    throw failed(error, label, "checking")
  }
  throw alreadyExists(label, file)
}

/**
 * Writes `text` as the file of wallet `label` under `stateDir`, create-only,
 * and returns its path. The directories are created with mode 700 (a link or a
 * file in their place is refused as `forbidden`); the text goes to a temporary
 * file with mode 600, flushed, and is then given its name by a link, so the
 * file appears whole or not at all and one that exists, of any kind, is
 * refused as `invalid_argument` and left untouched. The temporary file is
 * removed on every path.
 *
 * Nothing after the link can fail the write, so a thrown error always means no
 * wallet file was published. An unexpected failure is a fixed `internal_error`
 * with no cause, since `text` is the key.
 */
export async function writeWalletFile(stateDir: string, label: string, text: string): Promise<string> {
  checkLabel(label)
  const { root, accounts, dir, file } = walletPaths(stateDir, label)
  try {
    for (const directory of [root, accounts, dir]) await ensurePrivateDir(directory)
  } catch (error) {
    throw failed(error, label, "writing")
  }

  const temp = join(dir, `${TEMP_PREFIX}${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}${TEMP_SUFFIX}`)
  let handle: FileHandle
  try {
    handle = await open(temp, "wx", WALLET_FILE_MODE)
  } catch (error) {
    throw failed(error, label, "writing")
  }
  try {
    await writeTemp(handle, text)
    await publish(temp, file, label)
  } catch (error) {
    throw failed(error, label, "writing")
  } finally {
    await unlink(temp).catch(() => undefined)
  }

  await syncDirectory(dir)
  return file
}
