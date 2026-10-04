[![CI](https://github.com/isanchez31/opencode-sandbox-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/isanchez31/opencode-sandbox-plugin/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/opencode-sandbox)](https://www.npmjs.com/package/opencode-sandbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# opencode-sandbox

An [OpenCode](https://opencode.ai) plugin that sandboxes agent-executed commands using [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).

Shell commands run with OS-level filesystem and network restrictions — no containers, no VMs, just native OS sandboxing primitives. Supports OpenCode V2's `shell` tool and OpenCode V1's `bash` tool.

| Platform | Mechanism |
|----------|-----------|
| **macOS** | `sandbox-exec` (Seatbelt profiles) |
| **Linux** | `bubblewrap` (namespace isolation) |
| **Windows** | Not currently supported (commands pass through in `permissive` mode and are blocked in `enforce` mode) |

## Install

```json
// opencode.json
{
  "plugins": ["opencode-sandbox"]
}
```

The plugin is automatically installed from npm when OpenCode starts.

OpenCode V2 uses a default plugin definition with ID `opencode-sandbox`. The same package also exposes a V1 `server()` entrypoint, supported by OpenCode **1.18.29 and newer**. For V1, keep the singular config key:

```json
{
  "plugin": ["opencode-sandbox"]
}
```

Older V1 loaders can use the separate function entrypoint in a local plugin:

```ts
// .opencode/plugin/sandbox.ts (with opencode-sandbox installed)
export { default } from "opencode-sandbox/v1"
```

The V2 launcher requires `node` on `PATH`. Local source plugins require Node 22.18+ for TypeScript execution; published packages contain compiled JavaScript. Existing sandbox config files and environment variables work with both versions. See the [OpenCode plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

### Linux prerequisites

**1. Install bubblewrap:**

```bash
# Debian/Ubuntu
sudo apt install bubblewrap

# Fedora
sudo dnf install bubblewrap

# Arch
sudo pacman -S bubblewrap
```

**2. Ubuntu 24.04+ (AppArmor fix):**

Ubuntu 24.04 and later restrict unprivileged user namespaces via AppArmor, which prevents bubblewrap from working. You need to enable the `bwrap-userns-restrict` AppArmor profile:

```bash
# Install the AppArmor profiles package
sudo apt install apparmor-profiles

# Create the symlink to enable the profile
sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/force-complain/bwrap-userns-restrict

# Load the profile
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

You can verify bwrap works:

```bash
bwrap --ro-bind / / --dev /dev --proc /proc -- echo "sandbox works"
```

Without this fix, bwrap will fail with `loopback: Failed RTM_NEWADDR: Operation not permitted` or `setting up uid map: Permission denied`.

## What it does

When the agent runs a shell command, the sandbox enforces three layers of protection:

### Filesystem write protection

Commands can only write to the project directory and `/tmp`. Writing anywhere else returns "Read-only file system":

```
$ touch ~/some-file
touch: cannot touch '/home/user/some-file': Read-only file system

$ echo "data" > /etc/config
/usr/bin/bash: line 1: /etc/config: Read-only file system
```

### Sensitive file read protection

Access to credential directories is blocked:

```
$ cat ~/.ssh/id_rsa
cat: /home/user/.ssh/id_rsa: Permission denied
```

### Network allowlist

Only approved domains are reachable. All other traffic is blocked via a local proxy:

```
$ curl https://evil.com
Connection blocked by network allowlist

$ curl https://registry.npmjs.org
(works — npmjs.org is in the default allowlist)
```

### Default restrictions

**Filesystem (deny-read)**:
- `~/.ssh`, `~/.gnupg`
- `~/.aws/credentials`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`
- `~/.kube`, `~/.docker/config.json`
- `~/.npmrc`, `~/.netrc`, `~/.env`

**Filesystem (allow-read)**:
- Empty by default

**Filesystem (allow-write)**:
- Project directory
- Git worktree (validated — unsafe paths like `/` are rejected)
- `/tmp`

**Network (allow-only)**:
- `registry.npmjs.org`, `*.npmjs.org`
- `registry.yarnpkg.com`
- `pypi.org`, `*.pypi.org`, `crates.io`, `*.crates.io`
- `github.com`, `*.github.com`
- `gitlab.com`, `*.gitlab.com`, `bitbucket.org`, `*.bitbucket.org`
- `api.openai.com`, `api.anthropic.com`
- `*.googleapis.com`

Everything else is **blocked by default**.

## Configuration

Config files are stored outside the project directory (in `~/.config/opencode-sandbox/`) so that sandboxed commands cannot modify them. This prevents indirect prompt injection from weakening the sandbox by overwriting the config.

V2's project-local plugin `options` do not override these trusted settings. Configure the sandbox through the external files or environment variables below.

### Config file locations

The plugin searches for configuration in this order (first match wins):

1. **Environment variable** `OPENCODE_SANDBOX_CONFIG` (JSON string)
2. **Per-project config** `~/.config/opencode-sandbox/projects/<project-name>.json`
3. **Global config** `~/.config/opencode-sandbox/config.json`
4. **Built-in defaults**

The `<project-name>` is the basename of the project directory (e.g., `my-app` for `/home/user/projects/my-app`).

If `XDG_CONFIG_HOME` is set, it is used instead of `~/.config`.

### Example: Global config

```json
// ~/.config/opencode-sandbox/config.json
{
  "mode": "enforce",
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws/credentials"],
    "allowRead": ["~/.ssh/id_ed25519.pub"],
    "allowWrite": [".", "/tmp", "/var/data"],
    "denyWrite": [".env.production"]
  },
  "network": {
    "allowedDomains": [
      "registry.npmjs.org",
      "github.com",
      "*.github.com",
      "api.openai.com",
      "api.anthropic.com",
      "my-internal-api.company.com"
    ],
    "deniedDomains": ["malicious.example.com"]
  }
}
```

### Path precedence

Path precedence is inherited from `@anthropic-ai/sandbox-runtime`:

- Read: `allowRead` takes precedence over `denyRead`
- Write: `denyWrite` takes precedence over `allowWrite`

### Example: allow git commit signing with SSH public key

If your Git workflow needs to read a public key (for example `~/.ssh/id_ed25519.pub`) while keeping `~/.ssh` blocked by default, re-allow only that file:

```json
// ~/.config/opencode-sandbox/config.json
{
  "filesystem": {
    "denyRead": [
      "~/.ssh",
      "~/.gnupg",
      "~/.aws/credentials",
      "~/.azure",
      "~/.config/gcloud",
      "~/.config/gh",
      "~/.kube",
      "~/.docker/config.json",
      "~/.npmrc",
      "~/.netrc",
      "~/.env"
    ],
    "allowRead": ["~/.ssh/id_ed25519.pub"]
  }
}
```

### Example: Per-project config

```json
// ~/.config/opencode-sandbox/projects/my-app.json
{
  "network": {
    "allowedDomains": ["my-internal-api.company.com"]
  }
}
```

### Environment variable

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh"]},"network":{"allowedDomains":["github.com"]}}' opencode
```

Example allowing only the SSH public key to be read:

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh","~/.gnupg","~/.aws/credentials","~/.azure","~/.config/gcloud","~/.config/gh","~/.kube","~/.docker/config.json","~/.npmrc","~/.netrc","~/.env"],"allowRead":["~/.ssh/id_ed25519.pub"]}}' opencode
```

### Enforcement mode

The default mode is `permissive`: if the sandbox cannot initialize or wrap a command, the command runs without sandboxing.

Set `mode` to `enforce` to block shell commands whenever sandboxing cannot be applied, including on unsupported platforms:

```json
{
  "mode": "enforce"
}
```

### Disable

```bash
OPENCODE_DISABLE_SANDBOX=1 opencode
```

Or in any config file:

```json
{
  "disabled": true
}
```

## How it works

### OpenCode V2

The plugin registers `ctx.shell.hook("create.before", ...)` and selects an executable sandbox launcher. It preserves the original command so OpenCode's permission scanner, tool history, job titles, and background notifications continue to use the user's input.

Each launcher initializes its own sandbox runtime, wraps the command with `SandboxManager.wrapWithSandbox()`, executes it using the original shell, and resets the runtime after its child exits. This covers foreground and background commands, failures, timeouts, and graceful cancellation. Cancellation signals command descendants and escalates to SIGKILL after 500 ms if needed, before resetting the runtime. Remaining command descendants are also stopped after normal shell completion. The launcher stays in OpenCode's process group so OpenCode's own forced termination remains a backstop. If `ps` is unavailable, cleanup falls back to signalling the direct child. Cleanup failures produce a sanitized warning without replacing the command's exit status. Unloading the plugin removes its hook automatically; already-running launchers retain their restrictions until their commands exit.

This starts a runtime and network proxy per command, adding startup overhead compared with V1's shared runtime. Sandbox failures are reported in command stderr; enforce mode exits with status 126 without executing the command. A forced SIGKILL skips cleanup handlers.

An in-process shared runtime is not used: V2 runs `create.before` **before** permission scanning, with no separate post-permission spawn hook or per-command cleanup hook. Rewriting `command` there would change permission checks and recorded commands. In addition, the sandbox runtime's proxy applies one process-wide network policy; per-command filesystem overrides do not isolate different projects' network allowlists. Safe sharing would need a later spawn hook with lifecycle ownership and isolated runtime instances (or separate workers for different policies).

### OpenCode V1

The legacy implementation uses two OpenCode hooks:

1. **`tool.execute.before`** — Intercepts bash commands and wraps them with `SandboxManager.wrapWithSandbox()` before execution
2. **`tool.execute.after`** — Restores the original command on the tool arguments after execution

It also listens to OpenCode events to restore the original command in persisted tool history and clean up sandbox resources when commands finish or are interrupted.

```
Agent → bash tool → [plugin wraps command] → sandboxed execution → [plugin restores UI] → Agent
```

The AI model interprets sandbox errors (like "Read-only file system" or "Connection blocked") directly from command output — no additional annotation layer needed.

Sandbox initialization is deferred until the first `bash` command, so the plugin does not interfere with OpenCode startup. V1 plugin diagnostics are sent through OpenCode's structured logger instead of being printed into the TUI. Sandbox violations are correlated with each individual tool call, including concurrent or repeated commands.

### Windows status

`@anthropic-ai/sandbox-runtime` supports Windows through an argv-and-environment API. This plugin uses its command-string API on macOS and Linux. It leaves Windows commands unsandboxed in `permissive` mode and blocks the `shell` (V2) or `bash` (V1) tool in `enforce` mode.

### Failure behavior

In the default `permissive` mode, commands run normally if sandbox initialization or wrapping fails. In `enforce` mode, the affected shell command is blocked instead.

## Related

- [@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) — The underlying sandbox engine
- [OpenCode V2 Plugins Docs](https://opencode.ai/v2/docs/build/plugins/) — How to create and use plugins
- [Claude Code Sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing) — Anthropic's sandboxing documentation
