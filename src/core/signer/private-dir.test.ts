import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isToolError } from "../errors"
import { ensurePrivateDir } from "./private-dir"
import { makeStateDir } from "./testing"

let tempDir: string

beforeEach(() => {
  tempDir = makeStateDir()
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  return undefined
}

describe("ensurePrivateDir", () => {
  test("creates the directory and its missing parents with mode 700", async () => {
    const dir = join(tempDir, "a", "b", "c")
    await ensurePrivateDir(dir)
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(tempDir, "a"))).toBe(0o700)
  })

  test("sets an existing permissive directory to 700 and leaves its content", async () => {
    const dir = join(tempDir, "open")
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, "kept"), "x")
    await ensurePrivateDir(dir)
    expect(mode(dir)).toBe(0o700)
    expect(statSync(join(dir, "kept")).isFile()).toBe(true)
  })

  test("refuses a file as forbidden and names the path", async () => {
    const path = join(tempDir, "file")
    writeFileSync(path, "x")
    const error = await failure(() => ensurePrivateDir(path))
    expect(isToolError(error) && error.code).toBe("forbidden")
    expect((error as Error).message).toContain(path)
  })

  test("refuses a symlink to a directory without following it", async () => {
    const real = join(tempDir, "real")
    mkdirSync(real, { mode: 0o755 })
    chmodSync(real, 0o755)
    const link = join(tempDir, "link")
    symlinkSync(real, link)
    const error = await failure(() => ensurePrivateDir(link))
    expect(isToolError(error) && error.code).toBe("forbidden")
    expect((error as Error).message).toContain(link)
    expect(mode(real)).toBe(0o755)
  })

  test("refuses a dangling symlink", async () => {
    const link = join(tempDir, "dangling")
    symlinkSync(join(tempDir, "nowhere"), link)
    const error = await failure(() => ensurePrivateDir(link))
    expect(isToolError(error) && error.code).toBe("forbidden")
  })
})
