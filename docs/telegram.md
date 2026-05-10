# Telegram Bridge

CoClaw can be controlled remotely from Telegram. The Telegram bridge gives you full agentic access — file edits, terminal commands, code searches — all from your phone.

## Setup

### Step 1: Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to name your bot.
3. Copy the **Bot Token** that BotFather provides (format: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`).

### Step 2: Get Your User ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram.
2. It replies with your numeric **User ID** (e.g., `123456789`).

### Step 3: Link the Bot in VS Code

1. Press `Ctrl+Shift+P` to open the Command Palette.
2. Run **CoClaw: Link Telegram Bot**.
3. Paste your **Bot Token** when prompted.
4. Enter your **User ID** when prompted.

CoClaw validates the token format and stores credentials securely (token in VS Code's encrypted SecretStorage, user ID in global state).

### Step 4: Start the Bridge

In Copilot Chat, type:

```
@CoClaw /auto
```

CoClaw begins polling your Telegram bot for messages. You'll see a confirmation in the chat.

To start the full persistent mode with heartbeat and cron support, use:

```
@CoClaw /open
```

## Telegram Commands

Once the bridge is running, send these commands to your bot on Telegram:

| Command | Description |
|---|---|
| `/start` | Welcome message — confirms the bot is ready |
| `/stop` | Stop the polling bridge |
| `/status` | Show active model, memory counts, tool count, and conversation turns |
| `/clear` | Clear the Telegram conversation history |
| `/memory` | Show memory summary (top 15 long-term, top 10 daily entries) |
| `/settings` (or `/s`) | Open the interactive settings panel — toggle/edit any CoClaw setting from inline buttons |
| `/cron` | Open the Telegram cron control panel with pause, resume, delete, refresh, and clear-all buttons |
| `/cron add <schedule> <name> | <prompt>` | Create a cron job from Telegram |
| `/cron delete <name or id>` | Delete cron jobs by exact name or by job id |
| `/cron pause <name or id>` | Pause a cron job |
| `/cron resume <name or id>` | Resume a paused cron job |
| `/heartbeat` | Force a heartbeat check in `/open` mode |
| `/help` | List all available commands |
| *Any other text* | Processed as a full agentic request with all tools available |

## Full Tool Access

When you send a regular message (not a command), CoClaw processes it exactly like a Copilot Chat request — with access to all VS Code tools:

- Read and edit files in the workspace
- Run terminal commands
- Search the codebase
- Read and write memories
- Send workspace files to Telegram via the `CoClaw_telegram_send_file` tool (just ask: *"send me the package.json"*)

In Telegram mode, tools are auto-approved (no confirmation dialogs), making it ideal for remote coding. Tools that require an interactive VS Code prompt (Simple Browser, Live Preview, screenshot, webview, etc.) are filtered out automatically since you can't answer their dialogs from Telegram.

## Streamed Replies

Prose generated between tool calls is delivered as separate Telegram messages instead of one giant blob at the end. Each chunk arrives as soon as the model produces it, so long agentic runs feel conversational instead of silent.

## Tone & Emojis

In `/open` mode the assistant adopts a configurable tone. Switch via `/settings` → Telegram → Tone, or via VS Code settings (`CoClaw.telegram.tone`):

- `sarcastic` (default) — dry one-liner, then the real answer
- `friendly` — warm, conversational
- `professional` — concise and businesslike
- `playful` — enthusiastic with extra emojis
- `neutral` — plain (no tone addendum)

`CoClaw.telegram.useEmojis` is the master switch — turning it off removes emojis from replies AND disables incoming-message reactions. `CoClaw.telegram.sarcasticReactions` separately controls whether each user message gets a sarcastic emoji reaction in `/open` mode (it also requires `useEmojis`).

## Settings Panel

Send `/settings` (or `/s`) to open an interactive panel with inline buttons. Settings are grouped into Agents, Memory, Heartbeat, Telegram, and Model. Each entry supports the right input style:

- **Booleans** — on/off toggle
- **Enums** — one button per allowed value
- **Numbers** — `−step` / `+step` / `Min` / `Max` / `⌨ Type` for an exact value
- **Strings** — `⌨ Type` / `🗑 Clear`

All changes are written to global VS Code settings.

## Dual Output

Every response appears in **two places**:

1. **Telegram** — Sent back to your chat as a bot reply.
2. **VS Code** — Logged in the Copilot Chat panel for reference.

Incoming Telegram messages are displayed in VS Code as:

> **📩 Telegram:** your message here

## Conversation History

The Telegram session maintains its own conversation history (up to 20 turns / 40 messages). Memory extraction works in Telegram mode — facts are auto-extracted and stored just like in VS Code chat.

## Message Handling

- Long responses are automatically split at the 4,096-character Telegram limit.
- A **typing indicator** is shown while CoClaw processes your request.
- Only messages from your authorized User ID are processed — all others are ignored.

## Formatting

Telegram replies now render a Telegram-safe subset of the markdown CoClaw produces.

- Bold text such as `**important**` is rendered as bold.
- Italic text such as `*note*` or `_note_` is rendered as italic.
- Inline code and fenced code blocks are rendered as code.
- Markdown headings are rendered as bold lines.
- Markdown links are preserved as clickable links.
- Unordered list markers like `- item` and `* item` are rendered as bullet points.

Formatting is normalized before sending so Telegram can render it reliably. If a markdown pattern is not safely supported, CoClaw falls back to readable plain text instead of sending a malformed message.

## Cron Control Panel

In `/open` mode, send `/cron` to open a button-driven cron control panel directly in Telegram.

- Pause or resume a job with one tap.
- Delete a specific job from the panel.
- Refresh the panel after changes.
- Clear all cron jobs with a confirmation prompt.
- Each job entry shows its job ID for precise text-based commands when needed.

If you prefer text commands, `/cron delete`, `/cron pause`, and `/cron resume` also accept job ids from the control panel.

Natural-language requests like "delete the drink water reminder" are also intercepted when CoClaw can confidently map them to cron operations. When the request is ambiguous, CoClaw will ask for a more exact name or a job id instead of claiming it succeeded.

## VS Code Cron Commands

These Command Palette commands are useful when you want to manage cron storage directly from VS Code:

- **CoClaw: Clear All Cron Jobs** — Remove all persisted cron jobs from VS Code storage.
- **CoClaw: Open Cron Storage** — Open the cron storage folder in your OS file explorer.

## Stopping the Bridge

You can stop the bridge in three ways:

1. Send `/stop` from Telegram.
2. Run **CoClaw: Unlink Telegram Bot** from the Command Palette (also removes credentials).
3. Close VS Code — the bridge stops automatically.

## Unlinking

To completely remove the Telegram connection:

1. Press `Ctrl+Shift+P`.
2. Run **CoClaw: Unlink Telegram Bot**.
3. Confirm in the dialog.

This stops the bot, clears the stored token and user ID.

## Security

- **Authorized user only** — Only messages from the linked User ID are processed.
- **Encrypted token storage** — The bot token is stored in VS Code's SecretStorage (OS-level encryption).
- **Token validation** — The token format is validated before storage.
- **No auto-discovery** — Linking requires explicit manual setup.
