# CoClaw

AI coding assistant with persistent memory, powered by GitHub Copilot.

![VS Code](https://img.shields.io/badge/VS%20Code-1.93%2B-blue?logo=visual-studio-code)
![Copilot Required](https://img.shields.io/badge/Copilot-Required-orange?logo=github)
![License](https://img.shields.io/badge/License-Apache-green)

---

CoClaw adds a persistent memory layer to GitHub Copilot through the VS Code Language Model API. It stores and recalls relevant context across sessions — preferences, code conventions, patterns, and decisions — and injects it into prompts automatically.

## Features

- **Persistent Memory** — Two-layer memory system with daily logs and long-term storage.
- **Automatic Extraction** — Captures facts, decisions, and preferences from conversations.
- **Agentic Coding** — Uses VS Code tools to read, edit, and search within workspace boundaries.
- **Multi-Agent Orchestration** — `/agents` plans and parallelizes tasks across Planner, Coders, Reviewer, Tester, and Memory agents with shared memory and a live sidebar view.
- **Memory Browser** — Inspect, edit, promote, and delete memory entries in a webview panel.
- **Model Switching** — Choose from available Copilot models via status bar or command palette.
- **Identity + Profile** — Customize the assistant persona and your coding preferences.
- **Import/Export** — Backup and restore memories as JSON.
- **Telegram Bridge** — Control CoClaw remotely from Telegram with full tool access, an interactive `/settings` panel, configurable tone, file uploads, and prose streamed between tool calls.

## Documentation

| Guide | Description |
|---|---|
| [Getting Started](getting-started.md) | Installation, prerequisites, and first steps |
| [Memory System](memory-system.md) | How daily logs, long-term memory, extraction, recall, and distillation work |
| [Commands Reference](commands.md) | All slash commands and command palette commands |
| [Identity & Profile](identity-profile.md) | Customize SOUL.json and USER.json |
| [Model Switching](model-switching.md) | Select and switch Copilot models |
| [Memory Browser](memory-browser.md) | The interactive memory management panel |
| [Tools & Agentic Mode](tools-agentic.md) | How CoClaw uses tools, safety features, and result persistence |
| [Telegram Bridge](telegram.md) | Setup and use CoClaw from Telegram |
| [Configuration](configuration.md) | All settings with descriptions and recommended presets |

## Quick Start

1. Install the extension from the VS Code Marketplace.
2. Open Copilot Chat and type `@CoClaw` followed by your message.
3. CoClaw starts remembering automatically.

See the [Getting Started](getting-started.md) guide for full instructions.

## Privacy

All memory data is stored locally in VS Code global storage. No external service is used beyond GitHub Copilot API calls. CoClaw enforces workspace boundaries and does not access files outside the current workspace.

## License

[Apache-2.0](https://github.com/gdhanush27/Co-Claw/blob/main/LICENSE)
