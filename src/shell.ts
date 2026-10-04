#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

export interface LaunchConfig {
  config: SandboxRuntimeConfig
  shell: string
  mode: "permissive" | "enforce"
}

export async function prepareCommand(
  command: string,
  launch: LaunchConfig,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  // This dedicated launcher owns teardown. The runtime also registers automatic
  // exit/signal handlers; retaining them would reset it before the command stops.
  try {
    if (process.platform === "win32") {
      throw new Error("Windows sandboxing is not available through the command-string API")
    }
    const ownCleanup = (event: string | symbol, listener: () => void) => {
      if (event === "exit" || event === "SIGTERM" || event === "SIGINT") {
        // newListener fires before insertion. Remove on the next microtask,
        // before signals can run, including while initialize is still pending.
        queueMicrotask(() => process.removeListener(event, listener))
      }
    }
    process.on("newListener", ownCleanup)
    try {
      await SandboxManager.initialize(launch.config)
    } finally {
      process.off("newListener", ownCleanup)
    }
    signal?.throwIfAborted()
    return await SandboxManager.wrapWithSandbox(command, launch.shell, undefined, signal, {
      commandId: randomUUID(),
      commandText: command,
    })
  } catch {
    signal?.throwIfAborted()
    if (launch.mode === "enforce") {
      throw new Error("Sandbox unavailable in enforce mode; command blocked")
    }
    console.warn("[opencode-sandbox] Sandbox unavailable; running command without sandbox")
    return command
  }
}

function signalDescendants(
  signal: NodeJS.Signals,
  child: ReturnType<typeof spawn> | undefined,
  known: Map<number, number>,
) {
  let signalled = false
  try {
    // Do not resolve cleanup utilities through a command-controlled PATH.
    const rows = execFileSync(
      process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps",
      ["-A", "-o", "pid=,ppid=,pgid="],
      {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
      .trim()
      .split("\n")
      .map((row) => row.trim().split(/\s+/).map(Number))
    // V2 starts the launcher as a process-group leader. Keep descendants in
    // that group so OpenCode's own SIGKILL remains a backstop. Also walk parent
    // IDs: bubblewrap starts a new session on Linux. Remember observed PID/group
    // pairs for escalation even if a terminated parent leaves them reparented.
    const groupLeader = rows.some(([pid, , group]) => pid === process.pid && group === process.pid)
    const descendants = new Set([process.pid])
    for (const [pid, , group] of rows) {
      if (pid && group && known.get(pid) === group) descendants.add(pid)
    }
    for (let previous = -1; previous !== descendants.size; ) {
      previous = descendants.size
      for (const [pid, parent] of rows) {
        if (pid && parent && descendants.has(parent)) descendants.add(pid)
      }
    }
    for (const [pid, , group] of rows) {
      if (!pid || !group || pid === process.pid) continue
      if (!descendants.has(pid) && !(groupLeader && group === process.pid)) continue
      known.set(pid, group)
      try {
        process.kill(pid, signal)
        signalled = true
      } catch {
        // A process can exit between the snapshot and the signal.
      }
    }
  } catch {
    // ps may be unavailable; retain direct-child cancellation as a fallback.
    if (child && child.exitCode === null && child.signalCode === null) {
      signalled = child.kill(signal)
    }
  }
  return signalled
}

async function main() {
  // OpenCode passes shell-style argv. -c's next argument is the exact command.
  const commandIndex = process.argv.indexOf("-c", 2)
  const command = commandIndex === -1 ? undefined : process.argv[commandIndex + 1]
  const settings = process.env.OPENCODE_SANDBOX_LAUNCH
  delete process.env.OPENCODE_SANDBOX_LAUNCH
  if (command === undefined || settings === undefined) {
    throw new Error("Sandbox launcher requires a command and launch configuration")
  }
  const launch = JSON.parse(settings) as LaunchConfig
  if (
    typeof launch.shell !== "string" ||
    !launch.shell ||
    (launch.mode !== "permissive" && launch.mode !== "enforce") ||
    typeof launch.config !== "object" ||
    launch.config === null
  ) {
    throw new Error("Invalid sandbox launch configuration")
  }

  const controller = new AbortController()
  let child: ReturnType<typeof spawn> | undefined
  let stopping: Promise<void> | undefined
  const stop = (signal: NodeJS.Signals) => {
    stopping ??= (async () => {
      const known = new Map<number, number>()
      if (!signalDescendants(signal, child, known)) return
      await new Promise((resolve) => setTimeout(resolve, 500))
      signalDescendants("SIGKILL", child, known)
    })()
    return stopping
  }
  const cancel = (signal: "SIGTERM" | "SIGINT") => {
    if (controller.signal.aborted) return
    controller.abort(signal)
    void stop(signal)
  }
  const terminate = () => cancel("SIGTERM")
  const interrupt = () => cancel("SIGINT")
  process.on("SIGTERM", terminate)
  process.on("SIGINT", interrupt)
  try {
    const wrapped = await prepareCommand(command, launch, controller.signal)
    controller.signal.throwIfAborted()
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child = spawn(launch.shell, ["-c", wrapped], { stdio: "inherit" })
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal === "SIGINT" ? 130 : 143))
      })
    })
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    try {
      if (stopping) await stopping
      await SandboxManager.reset().catch(() => {
        console.warn("[opencode-sandbox] Sandbox cleanup failed")
      })
      // Reap command descendants left behind after their shell exited. Reset
      // first on normal exits so runtime-owned bridges can shut down themselves.
      stopping = undefined
      await stop("SIGTERM")
      if (controller.signal.aborted) {
        process.exitCode = controller.signal.reason === "SIGINT" ? 130 : 143
      }
    } finally {
      process.off("SIGTERM", terminate)
      process.off("SIGINT", interrupt)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(`[opencode-sandbox] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 126
  })
}
