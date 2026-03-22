# CoClaw

AI coding assistant with persistent memory, powered by GitHub Copilot.

![VS Code](https://img.shields.io/badge/VS%20Code-1.93%2B-blue?logo=visual-studio-code)
![Copilot Required](https://img.shields.io/badge/Copilot-Required-orange?logo=github)
![License](https://img.shields.io/badge/License-Apache-green)

---

CoClaw adds a persistent memory layer to GitHub Copilot through the VS Code Language Model API. It stores and recalls relevant context across sessions (preferences, code conventions, patterns, and decisions) and injects it into prompts automatically.

## Features

- **Persistent Memory** - Two-layer memory (daily logs + long-term memory)
- **Automatic Extraction** - Captures facts, decisions, and preferences from conversations
- **Agentic Coding** - Uses VS Code tools to read/edit/search within workspace boundaries
- **Memory Browser** - Inspect, edit, promote, and delete memory entries
- **Model Switching** - Choose available Copilot models from the status bar
- **Identity + Profile** - Customize assistant persona (`SOUL.json`) and user preferences (`USER.json`)
- **Import/Export** - Backup and restore memories as JSON
- **Telegram Bridge** - Control CoClaw remotely from Telegram

## Requirements

- VS Code `1.93+`
- GitHub Copilot Chat extension (`github.copilot-chat`)

## Usage

### Chat

Use `@CoClaw` in Copilot Chat for memory-augmented responses.

### Slash Commands

| Command | Description |
|---|---|
| `/memory` | Show what CoClaw remembers |
| `/distill` | Distill recent logs into long-term memory |
| `/clear` | Clear session memory |
| `/soul` | Edit CoClaw identity and behavior |
| `/auto` | Start Telegram bridge for remote control |

### Command Palette

| Command | Description |
|---|---|
| `CoClaw: Select Model` | Switch Copilot model |
| `CoClaw: Browse Memory` | Open memory browser |
| `CoClaw: Clear Session Memory` | Clear today’s daily log |
| `CoClaw: Edit Identity (SOUL)` | Open `SOUL.json` |
| `CoClaw: Edit Profile (USER)` | Open `USER.json` |
| `CoClaw: Distill to Long-Term Memory` | Distill daily logs |
| `CoClaw: Import Memories` | Import memories from JSON |
| `CoClaw: Export Memories` | Export memories to JSON |
| `CoClaw: Deduplicate Memory` | Remove duplicate memory entries |
| `CoClaw: Stop Response` | Stop the active CoClaw response |
| `CoClaw: Link Telegram Bot` | Link your Telegram bot |
| `CoClaw: Unlink Telegram Bot` | Remove Telegram link |
| `CoClaw: Open Settings` | Open CoClaw settings |

## Settings

| Setting | Default | Description |
|---|---|---|
| `CoClaw.model.family` | `""` | Preferred Copilot model family |
| `CoClaw.memory.maxLongTermEntries` | `100` | Max long-term entries |
| `CoClaw.memory.dailyLogsRetentionDays` | `30` | Daily log retention (days) |
| `CoClaw.memory.autoExtract` | `true` | Auto-extract conversation facts |
| `CoClaw.memory.tokenBudgetPercent` | `20` | Max context % for memory injection |
| `CoClaw.memory.autoDistillThreshold` | `20` | Auto-distill when daily log reaches this count (`0` disables) |
| `CoClaw.memory.autoDistillIntervalHours` | `24` | Auto-distill interval in hours (`0` disables) |
| `CoClaw.memory.staleAfterDays` | `14` | Reduce ranking weight for stale memories (`0` disables) |

## How Memory Works

1. **Recall:** CoClaw ranks relevant memories and injects them into prompt context.
2. **Extraction:** After each response, it extracts facts/preferences/decisions.
3. **Daily Logs:** Extracted items are saved per day.
4. **Distillation:** Daily logs are compressed into curated long-term memory.
5. **Reuse:** Long-term memory is reused across future sessions.

## Privacy

All memory data is stored locally in VS Code global storage. No external service is used beyond GitHub Copilot API calls. CoClaw enforces workspace boundaries and does not access files outside the current workspace.

## License

[Apache-2.0](LICENSE)
