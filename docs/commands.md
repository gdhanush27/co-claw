# Commands Reference

CoClaw provides commands through two interfaces: **slash commands** in Copilot Chat and **Command Palette** commands.

## Chat Slash Commands

Use these in Copilot Chat by typing `@CoClaw /command`.

### `/memory` — Show Memory

Displays a summary of what CoClaw currently remembers:

- **Long-term entries** — Top 20 entries sorted by importance, showing type, importance score, and content.
- **Daily log** — Top 10 entries from today's session.

**Usage:**

```
@CoClaw /memory
```

### `/distill` — Distill to Long-Term

Triggers distillation of today's daily log entries into curated long-term memory. The model consolidates, deduplicates, and prioritizes entries.

**Usage:**

```
@CoClaw /distill
```

After distillation, CoClaw reports the number of entries created. Automatic deduplication runs afterward.

### `/clear` — Clear Session Memory

Clears today's daily log. Long-term memory is preserved.

**Usage:**

```
@CoClaw /clear
```

### `/soul` — Edit Identity

Opens the `SOUL.json` file for in-line editing of CoClaw's identity and behavior. See [Identity & Profile](identity-profile.md) for details.

**Usage:**

```
@CoClaw /soul
```

### `/auto` — Start Telegram Bridge

> **⚠️ Deprecated:** `/auto` will be removed in version **1.0.0**. Use [`/open`](#open--start-openclaw-mode) instead.

Starts the Telegram polling bridge. CoClaw begins listening for messages from your linked Telegram bot and processes them with full tool access.

**Usage:**

```
@CoClaw /auto
```

Requires a linked Telegram bot. See [Telegram Bridge](telegram.md) for setup instructions.

### `/open` — Start OpenClaw Mode

Starts OpenClaw mode, which extends the Telegram bridge with:

- Workspace-backed `MEMORY.md` integration
- Daily logs in the workspace
- Heartbeat checks
- Cron job support

**Usage:**

```
@CoClaw /open
```

Use this mode when you want a more persistent, proactive Telegram workflow.

### `/agents` — Multi-Agent Orchestration

Runs your task through the multi-agent orchestrator. A Planner produces a JSON DAG of subtasks, the Coder agent (or several in parallel) implements them, the Reviewer reads the result, the Tester adds tests, and the Memory agent persists facts. Coder tasks are auto-fanned out across multiple parallel agents based on file paths and concern lanes (frontend / backend / data / tests / docs / etc.).

**Usage:**

```
@CoClaw /agents Build a login page with API and tests
```

Live progress is shown in the **Agents** sidebar (the CoClaw activity bar icon). Tune fan-out width with `CoClaw.agents.maxParallelCoders` and switch modes with `CoClaw.agents.mode` (`off`, `slash`, `always`).

## Command Palette Commands

Open the Command Palette with `Ctrl+Shift+P` and type the command name.

### CoClaw: Select Model

Opens a quick-pick dialog showing all available Copilot models. Displays each model's name, family, and maximum input tokens. Your selection is persisted across sessions.

### CoClaw: Browse Memory

Opens the **Memory Browser** — a webview panel where you can:

- View all long-term and daily log entries.
- Search and filter entries by type or keyword.
- Edit entry content and importance.
- Pin/unpin entries to protect them from decay and pruning.
- Promote daily log entries to long-term memory.
- Delete individual entries.

### CoClaw: Clear Session Memory

Shows a modal dialog with three options:

- **Daily Only** — Clear today's daily log.
- **Long-Term Only** — Clear all long-term entries.
- **All Memory** — Clear everything.

### CoClaw: Edit Identity (SOUL)

Opens `SOUL.json` in the editor. This file controls CoClaw's name, role, instructions, and tone. Changes take effect on the next chat message.

### CoClaw: Edit Profile (USER)

Opens `USER.json` in the editor. This file stores your coding preferences (language, style, frameworks, etc.). Changes take effect on the next chat message.

### CoClaw: Distill to Long-Term Memory

Same as the `/distill` slash command — consolidates daily logs into long-term memory using the active model.

### CoClaw: Import Memories

Opens a file picker for JSON files. Imports an array of memory entries, validating each entry's type, content length, and tags.

### CoClaw: Export Memories

Opens a save dialog. Exports all memories (long-term + daily) as a JSON array.

### CoClaw: Deduplicate Memory

Scans both memory layers for near-duplicate entries (>60% word overlap) and removes the less important duplicates.

### CoClaw: Stop Response

Cancels the currently active CoClaw response. Useful if the assistant is stuck in a long tool-use loop.

### CoClaw: Link Telegram Bot

Two-step setup process:

1. Enter your **Bot Token** (from [@BotFather](https://t.me/BotFather) on Telegram).
2. Enter your **User ID** (numeric, from [@userinfobot](https://t.me/userinfobot)).

After linking, use `/auto` in chat to start the bridge. See [Telegram Bridge](telegram.md).

### CoClaw: Unlink Telegram Bot

Shows a confirmation dialog, then stops the bot and removes stored credentials.

### CoClaw: Clear All Cron Jobs

Removes all persisted cron jobs from VS Code storage. If OpenClaw mode is currently running, active in-memory cron jobs are also cleared immediately.

### CoClaw: Open Cron Storage

Opens the persisted cron storage folder in your operating system's file explorer. Useful for debugging or manual inspection.

### CoClaw: Open Settings

Opens VS Code settings filtered to the `CoClaw.*` section for quick access to all configuration options.

## Follow-Up Suggestions

After each chat response, CoClaw offers two follow-up actions:

1. **"Check memory"** — Runs `/memory` to see what was remembered.
2. **"Distill to long-term"** — Runs `/distill` to save facts to long-term storage.
