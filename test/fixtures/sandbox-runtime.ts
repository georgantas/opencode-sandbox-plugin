export const SandboxManager = {
  async initialize(config: {
    failInitialize?: boolean
    failReset?: boolean
    delayInitialize?: boolean
  }) {
    failReset = config.failReset ?? false
    if (config.failInitialize) throw new Error("fixture initialization failure")
    // Mirror the dependency's automatic cleanup registration, including the
    // async initialization window where receiving a signal used to race reset.
    process.once("exit", () => void SandboxManager.reset())
    process.once("SIGTERM", () => void SandboxManager.reset())
    process.once("SIGINT", () => void SandboxManager.reset())
    if (config.delayInitialize) {
      process.stderr.write("fixture:initializing\n")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    process.stderr.write("fixture:initialized\n")
  },
  async wrapWithSandbox(command: string) {
    process.stderr.write("fixture:wrapped\n")
    return command
  },
  async reset() {
    process.stderr.write("fixture:reset\n")
    if (failReset) throw new Error("fixture cleanup secret")
  },
}

let failReset = false
