# Getting Started

## Prerequisites

Before installing CoClaw, make sure you have:

- **VS Code 1.93** or newer
- **GitHub Copilot Chat** extension installed and active (`github.copilot-chat`)
- An active GitHub Copilot subscription

## Installation

### From the VS Code Marketplace

1. Open VS Code.
2. Go to the **Extensions** view (`Ctrl+Shift+X`).
3. Search for **CoClaw**.
4. Click **Install**.
5. Reload VS Code if prompted.

### From VSIX

1. Download the `.vsix` file from the [GitHub Releases](https://github.com/gdhanush27/Co-Claw/releases) page.
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`).
3. Run **Extensions: Install from VSIX…** and select the downloaded file.

## First Steps

Once installed, CoClaw is ready to use immediately:

1. **Open Copilot Chat** — Click the Copilot Chat icon in the sidebar or press `Ctrl+Shift+I`.
2. **Mention CoClaw** — Type `@CoClaw` followed by your message.
3. **Check the status bar** — The bottom status bar shows the active model and memory count.

CoClaw will automatically start remembering facts, preferences, and decisions from your conversations.

## Verify It Works

Send a test message in Copilot Chat:

```
@CoClaw What is this project about?
```

CoClaw will respond using the active Copilot model with memory-augmented context. After the response, it automatically extracts and stores relevant facts.

## What Happens on First Run

When CoClaw activates for the first time, it:

1. Creates its storage directory for memory files.
2. Generates default `SOUL.json` (assistant identity) and `USER.json` (your preferences).
3. Registers all commands and tools.
4. Starts background timers for auto-distillation and memory pruning.

## Next Steps

- [Learn about the memory system](memory-system.md) — How CoClaw remembers and recalls information.
- [Customize the identity](identity-profile.md) — Change CoClaw's name, role, tone, and your preferences.
- [Explore all commands](commands.md) — Full list of chat commands and palette commands.
- [Configure settings](configuration.md) — Tune memory limits, auto-extraction, and more.
