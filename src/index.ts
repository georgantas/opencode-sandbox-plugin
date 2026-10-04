import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { loadConfig, resolveConfig } from "./config"
import type { LaunchConfig } from "./shell"
import { SandboxPlugin } from "./v1"

export type { SandboxPluginConfig } from "./config"
export { SandboxPlugin, server } from "./v1"

export default {
  ...Plugin.define({
    id: "opencode-sandbox",
    async setup(ctx) {
      if (
        process.env.OPENCODE_DISABLE_SANDBOX === "1" ||
        process.env.OPENCODE_DISABLE_SANDBOX === "true"
      ) {
        return
      }

      const userConfig = await loadConfig(ctx.location.directory)
      if (userConfig.disabled) return

      if (process.platform === "win32") {
        if (userConfig.mode === "enforce") {
          await ctx.tool.hook("execute.before", (event) => {
            if (event.tool === "shell") {
              throw new ToolError({
                message: "Sandbox unavailable in enforce mode; command blocked",
              })
            }
          })
        } else {
          console.warn("[opencode-sandbox] Windows sandboxing unavailable; running without sandbox")
        }
        return
      }

      const config = resolveConfig(
        ctx.location.directory,
        ctx.location.project.directory,
        userConfig,
      )
      // V2 scans permissions after create.before and uses command in job history.
      // Select a launcher instead of rewriting it. Each launcher owns its runtime
      // until its child exits, including when the tool returns in the background.
      const launcher = fileURLToPath(
        new URL(import.meta.url.endsWith(".ts") ? "./shell.ts" : "./shell.js", import.meta.url),
      )
      await ctx.shell.hook("create.before", (event) => {
        const launch: LaunchConfig = {
          config,
          shell: event.shell,
          mode: userConfig.mode ?? "permissive",
        }
        event.env.OPENCODE_SANDBOX_LAUNCH = JSON.stringify(launch)
        event.shell = launcher
      })
    },
  }),
  server: SandboxPlugin,
}
