import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("V2 launcher process", () => {
  let directory: string
  let launcher: string
  const ps = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps"
  const canInspectProcessTree = (() => {
    try {
      execFileSync(ps, ["-p", String(process.pid), "-o", "stat="])
      return true
    } catch {
      return false // Some test sandboxes forbid process inspection.
    }
  })()

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sandbox-launcher-"))
    const build = await Bun.build({
      entrypoints: [path.resolve("src/shell.ts")],
      outdir: directory,
      target: "node",
      plugins: [
        {
          name: "fixture-runtime",
          setup(builder) {
            builder.onResolve({ filter: /^@anthropic-ai\/sandbox-runtime$/ }, () => ({
              path: path.resolve("test/fixtures/sandbox-runtime.ts"),
            }))
          },
        },
      ],
    })
    expect(build.success).toBe(true)
    launcher = path.join(directory, "shell.js")
  })

  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  const start = (command: string, mode = "enforce", config = {}, shell = "/bin/sh") =>
    Bun.spawn(["node", launcher, "-c", command], {
      env: {
        ...process.env,
        OPENCODE_SANDBOX_LAUNCH: JSON.stringify({ mode, config, shell }),
      },
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })

  test("preserves exact command, output, and exit code and resets runtime", async () => {
    if (process.platform === "win32") return
    const child = start(
      `printf '%s' '$(literal)'; printf '%s' "\${OPENCODE_SANDBOX_LAUNCH-unset}"; exit 7`,
    )
    expect(await new Response(child.stdout).text()).toBe("$(literal)unset")
    expect(await child.exited).toBe(7)
    expect(await new Response(child.stderr).text()).toBe(
      "fixture:initialized\nfixture:wrapped\nfixture:reset\n",
    )
  })

  test("enforce mode never runs the command after initialization fails", async () => {
    if (process.platform === "win32") return
    const child = start("echo unsafe", "enforce", { failInitialize: true })
    expect(await new Response(child.stdout).text()).toBe("")
    expect(await child.exited).toBe(126)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain("fixture:reset")
    expect(stderr).toContain("Sandbox unavailable in enforce mode; command blocked")
    expect(stderr).not.toContain("fixture initialization failure")
  })

  test("permissive mode runs the original command and resets after failed initialization", async () => {
    if (process.platform === "win32") return
    const child = start("echo hello", "permissive", { failInitialize: true })
    expect(await new Response(child.stdout).text()).toBe("hello\n")
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toContain("fixture:reset")
  })

  test("resets when the child shell cannot spawn", async () => {
    if (process.platform === "win32") return
    const child = start("echo unsafe", "enforce", {}, "/does-not-exist")
    expect(await child.exited).toBe(126)
    expect(await new Response(child.stderr).text()).toContain("fixture:reset")
  })

  test("rejects invalid launch settings without executing anything", async () => {
    const child = start("echo unsafe", "invalid")
    expect(await new Response(child.stdout).text()).toBe("")
    expect(await child.exited).toBe(126)
    expect(await new Response(child.stderr).text()).toContain(
      "Invalid sandbox launch configuration",
    )
  })

  test("holds runtime until a background child exits and cleans up on cancellation", async () => {
    if (process.platform === "win32") return
    const child = start("echo ready; exec sleep 30")
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n")
    expect(child.exitCode).toBeNull()
    child.kill("SIGTERM")
    expect(await child.exited).toBe(143)
    expect(await new Response(child.stderr).text()).toBe(
      "fixture:initialized\nfixture:wrapped\nfixture:reset\n",
    )
  })

  test("cancels initialization without running the command or resetting twice", async () => {
    if (process.platform === "win32") return
    const child = start("echo unsafe", "permissive", { delayInitialize: true })
    const reader = child.stderr.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("fixture:initializing\n")
    child.kill("SIGTERM")
    expect(await child.exited).toBe(143)
    expect(await new Response(child.stdout).text()).toBe("")
    const remaining: string[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      remaining.push(new TextDecoder().decode(next.value))
    }
    expect(remaining.join("")).toBe("fixture:initialized\nfixture:reset\n")
  })

  const alive = (pid: number) => {
    try {
      const status = execFileSync(ps, ["-p", String(pid), "-o", "stat="], {
        encoding: "utf8",
      }).trim()
      return status !== "" && !status.startsWith("Z")
    } catch {
      return false
    }
  }

  test.skipIf(!canInspectProcessTree)(
    "escalates cancellation for a shell and grandchild that ignore signals",
    async () => {
      if (process.platform === "win32") return
      const child = start(`trap '' TERM INT; sleep 30 & printf '%s\n' "$!"; wait`)
      try {
        const reader = child.stdout.getReader()
        const pid = Number(new TextDecoder().decode((await reader.read()).value).trim())
        expect(alive(pid)).toBe(true)
        child.kill("SIGTERM")
        child.kill("SIGTERM")
        expect(await child.exited).toBe(143)
        expect(alive(pid)).toBe(false)
        expect(await new Response(child.stderr).text()).toBe(
          "fixture:initialized\nfixture:wrapped\nfixture:reset\n",
        )
      } finally {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          /* Already gone. */
        }
      }
    },
  )

  test("handles OpenCode-style process-group cancellation and SIGINT", async () => {
    if (process.platform === "win32") return
    const child = start("echo ready; exec sleep 30")
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n")
    process.kill(-child.pid, "SIGINT")
    expect(await child.exited).toBe(130)
    expect(await new Response(child.stderr).text()).toBe(
      "fixture:initialized\nfixture:wrapped\nfixture:reset\n",
    )
  })

  test.skipIf(!canInspectProcessTree)(
    "tracks descendants in new sessions even after their parent is terminated",
    async () => {
      if (process.platform === "win32") return
      // Model bubblewrap's --new-session without requiring a Linux machine.
      const script = `const {spawn} = require("node:child_process");
        const child = spawn("/bin/sh", ["-c", ${JSON.stringify('trap "" TERM INT; echo ready; exec sleep 30')}], {detached: true});
        child.stdout.once("data", () => console.log(child.pid));`
      const child = start(`node -e '${script}'`)
      let pid: number | undefined
      try {
        const reader = child.stdout.getReader()
        pid = Number(new TextDecoder().decode((await reader.read()).value).trim())
        expect(alive(pid)).toBe(true)
        child.kill("SIGTERM")
        expect(await child.exited).toBe(143)
        expect(alive(pid)).toBe(false)
        expect(await new Response(child.stderr).text()).toBe(
          "fixture:initialized\nfixture:wrapped\nfixture:reset\n",
        )
      } finally {
        for (const group of [child.pid, pid]) {
          if (!group || group <= 0) continue
          try {
            process.kill(-group, "SIGKILL")
          } catch {
            /* Already gone. */
          }
        }
      }
    },
  )

  test.skipIf(!canInspectProcessTree)(
    "stops orphaned descendants after their shell exits normally",
    async () => {
      if (process.platform === "win32") return
      const child = start(`sleep 30 & printf '%s\n' "$!"; exit 7`)
      try {
        const output = await new Response(child.stdout).text()
        const pid = Number(output.trim())
        expect(pid).toBeGreaterThan(0)
        expect(await child.exited).toBe(7)
        expect(alive(pid)).toBe(false)
        expect(await new Response(child.stderr).text()).toBe(
          "fixture:initialized\nfixture:wrapped\nfixture:reset\n",
        )
      } finally {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          /* Already gone. */
        }
      }
    },
  )

  test("warns safely about cleanup errors without changing the command's exit status", async () => {
    if (process.platform === "win32") return
    const child = start("exit 7", "enforce", { failReset: true })
    expect(await child.exited).toBe(7)
    expect(await new Response(child.stderr).text()).toBe(
      "fixture:initialized\nfixture:wrapped\nfixture:reset\n[opencode-sandbox] Sandbox cleanup failed\n",
    )
  })
})
