# CoClaw

AI coding assistant with persistent memory, powered by GitHub Copilot.

![Version](https://img.shields.io/badge/version-0.2-informational)
[![CI](https://github.com/gdhanush27/co-claw/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gdhanush27/co-claw/actions/workflows/ci.yml)
![VS Code](https://img.shields.io/badge/VS%20Code-1.93%2B-blue?logo=visual-studio-code)
![Copilot Required](https://img.shields.io/badge/Copilot-Required-orange?logo=github)
![License](https://img.shields.io/badge/License-Apache--2.0-green)

---

CoClaw adds a persistent memory layer to GitHub Copilot through the VS Code Language Model API. It stores and recalls relevant context across sessions, injects that context into future prompts, and can also run remotely through Telegram with full tool access.

## Features

- **Persistent Memory** - Two-layer memory with daily logs and long-term storage
- **Automatic Extraction** - Captures facts, conventions, preferences, and decisions from conversations
- **Agentic Coding** - Uses VS Code tools to read, edit, search, and inspect the workspace
- **Multi-Agent Orchestration** - `/agents` splits a task across Planner, Coder, Reviewer, Tester, and Memory agents that can run in parallel with shared memory; auto-fanout decides how many parallel coders to spawn
- **Agents Sidebar** - Live tree view of orchestration runs and per-task status (in the CoClaw activity bar icon)
- **Memory Browser** - Inspect, edit, promote, and delete stored memory entries
- **Model Switching** - Choose available Copilot models from the status bar or command palette
- **Identity + Profile** - Customize assistant persona with `SOUL.json` and user preferences with `USER.json`
- **Telegram Bridge** - Control CoClaw remotely from Telegram with full tool access
- **OpenClaw Mode** - Persistent `/open` mode with workspace memory, heartbeat checks, and cron jobs
- **Telegram Settings UI** - `/settings` (or `/s`) opens an interactive button panel to tune any CoClaw setting from your phone
- **Tone & Emoji Controls** - Pick the assistant's Telegram tone (`sarcastic`, `friendly`, `professional`, `playful`, `neutral`) and toggle emoji use globally
- **Telegram File Delivery** - Ask the assistant to send any workspace file and it ships it as a real Telegram document (up to 50 MB)
- **Streamed Telegram Replies** - Prose between tool calls is delivered as separate Telegram messages instead of one giant blob at the end
- **Telegram Formatting** - Telegram replies render a safe subset of markdown including bold, italics, links, and code blocks
- **Telegram Cron UI** - Manage cron jobs from Telegram with inline buttons for pause, resume, delete, refresh, and clear-all

### Telegram Chat Demo

https://github.com/user-attachments/assets/6d7bb303-7e22-4ca3-9a23-2f0f4d7b0e37

[▶ Click the link if the above video doesn't work](https://youtu.be/rRH_7dtXpb0)

## Requirements

- VS Code `1.93+`
- GitHub Copilot Chat extension (`github.copilot-chat`)

## Quick Start

1. Install the extension in VS Code.
2. Open Copilot Chat and send `@CoClaw` followed by your request.
3. CoClaw starts remembering useful context automatically.
4. Optionally link Telegram with `CoClaw: Link Telegram Bot` for remote access.

## Chat Commands

Use these in Copilot Chat with `@CoClaw /command`.

| Command | Description |
|---|---|
| `/memory` | Show what CoClaw remembers |
| `/distill` | Distill recent logs into long-term memory |
| `/clear` | Clear session memory |
| `/soul` | Edit CoClaw identity and behavior |
| `/agents` | Run a task through the multi-agent orchestrator (Planner → Coders/Reviewer/Tester/Memory) |
| `/auto` | Start the Telegram bridge for remote control |
| `/open` | Start OpenClaw mode with Telegram bridge, workspace memory, heartbeat, and cron support |

## Command Palette

| Command | Description |
|---|---|
| `CoClaw: Select Model` | Switch Copilot model |
| `CoClaw: Browse Memory` | Open the memory browser |
| `CoClaw: Clear Session Memory` | Clear memory for the current session |
| `CoClaw: Edit Identity (SOUL)` | Open `SOUL.json` |
| `CoClaw: Edit Profile (USER)` | Open `USER.json` |
| `CoClaw: Distill to Long-Term Memory` | Distill daily logs |
| `CoClaw: Import Memories` | Import memories from JSON |
| `CoClaw: Export Memories` | Export memories to JSON |
| `CoClaw: Deduplicate Memory` | Remove duplicate memory entries |
| `CoClaw: Stop Response` | Stop the active CoClaw response |
| `CoClaw: Link Telegram Bot` | Link your Telegram bot |
| `CoClaw: Unlink Telegram Bot` | Remove Telegram link |
| `CoClaw: Clear All Cron Jobs` | Remove all persisted cron jobs from VS Code storage |
| `CoClaw: Open Cron Storage` | Open the cron storage folder in your OS file explorer |
| `CoClaw: Open Settings` | Open CoClaw settings |

## Telegram Highlights

- `/auto` starts the remote Telegram bridge
- `/open` starts OpenClaw mode with heartbeat and cron job support
- `/cron` opens a Telegram button-based cron control panel
- `/settings` (or `/s`) opens an interactive settings panel — tweak tone, emojis, agents, memory, heartbeat, and model preferences without leaving Telegram
- Tone presets: sarcastic (default), friendly, professional, playful, neutral
- Ask "send me &lt;path&gt;" and the assistant uploads the file as a Telegram document
- Sarcastic emoji reactions appear on each incoming message in `/open` mode (toggleable)
- Telegram replies render a Telegram-safe subset of markdown
- Natural-language cron deletion requests are intercepted before the LLM path when possible

For full setup and remote usage details, see [docs/telegram.md](docs/telegram.md).

## Settings

| Setting | Default | Description |
|---|---|---|
| `CoClaw.model.family` | `""` | Preferred Copilot model family |
| `CoClaw.memory.maxLongTermEntries` | `100` | Max long-term entries |
| `CoClaw.memory.dailyLogsRetentionDays` | `30` | Daily log retention in days |
| `CoClaw.memory.autoExtract` | `true` | Auto-extract conversation facts |
| `CoClaw.memory.tokenBudgetPercent` | `20` | Max context percentage for memory injection |
| `CoClaw.memory.autoDistillThreshold` | `20` | Auto-distill when daily log reaches this count (`0` disables) |
| `CoClaw.memory.autoDistillIntervalHours` | `24` | Auto-distill interval in hours (`0` disables) |
| `CoClaw.memory.staleAfterDays` | `14` | Reduce ranking weight for stale memories (`0` disables) |
| `CoClaw.heartbeat.enabled` | `true` | Enable heartbeat checks in `/open` mode |
| `CoClaw.heartbeat.intervalMinutes` | `30` | Heartbeat interval in minutes |
| `CoClaw.heartbeat.activeHoursStart` | `08:00` | Start of active hours for heartbeat |
| `CoClaw.heartbeat.activeHoursEnd` | `22:00` | End of active hours for heartbeat |
| `CoClaw.heartbeat.timezone` | `""` | IANA time zone for heartbeat active hours (`Asia/Kolkata`, etc.). Empty = host local time |
| `CoClaw.logging.level` | `error` | Verbosity for the **CoClaw** output channel (`off`, `error`, `warn`, `info`, `debug`) |
| `CoClaw.telegram.tone` | `sarcastic` | Conversational tone in `/open` mode (`sarcastic`, `friendly`, `professional`, `playful`, `neutral`) |
| `CoClaw.telegram.useEmojis` | `true` | Master switch for emojis in replies and message reactions |
| `CoClaw.telegram.sarcasticReactions` | `true` | React to each `/open` user message with a sarcastic emoji (also requires `useEmojis`) |
| `CoClaw.telegram.silentUnauthorized` | `false` | When `true`, silently drop messages from non-linked users instead of replying with `Unauthorized` |
| `CoClaw.agents.mode` | `slash` | Multi-agent mode: `off`, `slash` (only on `/agents`), or `always` (route every prompt) |
| `CoClaw.agents.maxParallelCoders` | `4` | Maximum number of coder agents that may run in parallel (1–8) |
| `CoClaw.agents.minParallelCoders` | `1` | Minimum number of coder agents to spawn per task. The splitter pads small tasks with generic lanes (implementation, tests, docs, …) up to this floor. Capped to `maxParallelCoders` |
| `CoClaw.agents.summaryMaxChars` | `8000` | Per-task character cap for the multi-agent run summary and the copy persisted to shared memory. `0` = unlimited |
| `CoClaw.agents.alwaysShowFullOutput` | `false` | When `true`, every `/agents` run skips the per-task cap (equivalent to typing `--full` on every prompt). One-shot alternative: prefix or suffix your prompt with `--full` (aliases: `--all`, `--no-truncate`) |
| `CoClaw.tools.maxPerRequest` | `120` | Hard cap on tools sent per LM request. Lower this if a model rejects calls with “Cannot have more than N tools per request” (most providers cap at 128) |
| `CoClaw.tools.exclude` | `[]` | Substring patterns; matching tool names are dropped before the request reaches the model (e.g. `["mssql", "jupyter"]`) |
| `CoClaw.tools.priority` | `[]` | Substring patterns; matching tools are bumped above CoClaw’s own tools so they survive the per-request cap |

## Development

```bash
# Install dependencies
npm install

# Build (production)
npm run build

# Watch mode (development)
npm run watch

# Type-check
npm run typecheck

# Lint
npm run lint

# Run tests
npm test

# Package as .vsix
npm run package
```

To debug, open the project in VS Code and press **F5** — this launches an Extension Development Host with CoClaw loaded.

## Architecture

```
src/
├── extension.ts          # Extension entry point
├── agents/               # Multi-agent orchestration (Planner, Coder, Reviewer, Tester, Memory)
├── commands/             # VS Code command implementations
├── cron/                 # Cron job scheduler for /open mode
├── heartbeat/            # Heartbeat checks for /open mode
├── lm/                   # Language model integration (model manager, prompt builder, tool filter)
├── memory/               # Two-layer memory system (daily + long-term)
├── participant/          # Copilot Chat participant handler
├── profile/              # Identity (SOUL) and user profile (USER) management
├── telegram/             # Telegram bot bridge
├── tools/                # LM tool definitions and handlers
├── ui/                   # Tree views, webviews, status bar
└── util/                 # Shared utilities
```

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for branch protection rules and PR requirements.

In short: open a PR against `main`. CI must pass (`typecheck`, `test`, `build`, `package`) and one CODEOWNER must approve before merging.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Commands](docs/commands.md)
- [Memory System](docs/memory-system.md)
- [Memory Browser](docs/memory-browser.md)
- [Identity & Profile](docs/identity-profile.md)
- [Model Switching](docs/model-switching.md)
- [Tools & Agentic Coding](docs/tools-agentic.md)
- [Telegram Bridge](docs/telegram.md)
- [Configuration](docs/configuration.md)
- [Documentation Index](docs/index.md)

## Privacy

All memory data is stored locally in VS Code global storage. No external service is used beyond GitHub Copilot API calls. CoClaw enforces workspace boundaries and does not access files outside the current workspace.

## License

[Apache-2.0](LICENSE)
