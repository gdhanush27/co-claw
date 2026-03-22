<p align="center">
  <img src="icon.png" alt="CoClaw Logo" width="150" />
</p>

<h1 align="center">CoClaw</h1>

<p align="center">
  <strong>AI coding assistant with persistent memory, powered by GitHub Copilot.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-1.93%2B-blue?logo=visual-studio-code" alt="VS Code 1.93+" />
  <img src="https://img.shields.io/badge/Copilot-Required-orange?logo=github" alt="Copilot Required" />
  <img src="https://img.shields.io/badge/License-Apache-green" alt="Apache License" />
</p>

---

CoClaw adds a persistent memory layer to GitHub Copilot's LLM via the VS Code Language Model API. Instead of losing context between sessions, CoClaw stores and retrieves relevant memories — code conventions, user preferences, project patterns, past decisions — and injects them into LLM prompts automatically.

## Features

- **Persistent Memory** — Two-layer memory system (daily session logs + long-term distilled memory)
- **Automatic Memory Extraction** — Facts, decisions, and preferences extracted from every conversation
- **Agentic Coding** — Uses VS Code tools to read, edit, and search files autonomously with workspace-scoped safety
- **Model Switching** — Click the status bar to switch between available Copilot models
- **Identity System** — Customizable assistant persona (SOUL.json) and user preferences (USER.json)
- **Memory Browser** — Webview panel to browse, edit, promote, and delete memory entries
- **LM Tools** — Agent-mode tools for reading/writing memory mid-conversation
- **Import/Export** — Backup and restore memories as JSON
- **Progress Indicators** — Live status bar spinner and per-tool progress while working

## Requirements

- VS Code 1.93+
- GitHub Copilot Chat extension

## Usage

### Chat

Type `@CoClaw` in the chat panel to start a conversation with memory-augmented responses.

### Slash Commands

| Command | Description |
|---|---|
| `/memory` | Show what CoClaw remembers |
| `/distill` | Distill daily logs into long-term memory |
| `/clear` | Clear today's session memory |
| `/soul` | Edit CoClaw's identity/behavior |

### Commands (Command Palette)

| Command | Description |
|---|---|
| `CoClaw: Select Model` | Switch Copilot model via QuickPick |
| `CoClaw: Browse Memory` | Open memory browser webview |
| `CoClaw: Clear Session Memory` | Clear today's daily log |
| `CoClaw: Edit Identity (SOUL)` | Open SOUL.json in editor |
| `CoClaw: Edit Profile (USER)` | Open USER.json in editor |
| `CoClaw: Distill to Long-Term Memory` | AI-powered distillation of daily logs |
| `CoClaw: Import Memories` | Import memories from JSON file |
| `CoClaw: Export Memories` | Export all memories to JSON file |

## Settings

| Setting | Default | Description |
|---|---|---|
| `CoClaw.model.family` | `""` | Preferred Copilot model family (workspace override) |
| `CoClaw.memory.maxLongTermEntries` | `100` | Max long-term memory entries |
| `CoClaw.memory.dailyLogsRetentionDays` | `30` | Days to retain daily logs |
| `CoClaw.memory.autoExtract` | `true` | Auto-extract facts from conversations |
| `CoClaw.memory.tokenBudgetPercent` | `20` | Max % of context window for memory injection |
| `CoClaw.memory.autoDistillThreshold` | `20` | Auto-distill when daily log reaches this many entries (0 to disable) |
| `CoClaw.memory.autoDistillIntervalHours` | `24` | Auto-distill interval in hours (0 to disable) |
| `CoClaw.memory.staleAfterDays` | `14` | Downgrade entries not referenced in this many days (0 to disable) |

## How Memory Works

1. **During chat**: CoClaw retrieves relevant memories and injects them into the system prompt
2. **After each response**: A secondary LM call extracts notable facts, preferences, and decisions
3. **Daily logs**: Raw extracted facts stored per-day as JSON
4. **Long-term memory**: Distilled, curated entries that persist indefinitely
5. **Recall**: Entries ranked by `recency × importance × keyword_overlap` and injected within token budget

## Privacy

All memories are stored locally in VS Code's global storage. No data is sent to external services beyond the Copilot API calls. CoClaw enforces workspace boundaries — it will never read or write files outside your current workspace.

## License

[Apache](LICENSE)

---

<p align="center">
  <img src="icon.png" alt="CoClaw" width="40" /><br/>
  <sub>Built with ❤️ by <a href="https://github.com/gdhanush27">gdhanush27</a></sub>
</p>
