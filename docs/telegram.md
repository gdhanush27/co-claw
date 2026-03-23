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

## Telegram Commands

Once the bridge is running, send these commands to your bot on Telegram:

| Command | Description |
|---|---|
| `/start` | Welcome message — confirms the bot is ready |
| `/stop` | Stop the polling bridge |
| `/status` | Show active model, memory counts, tool count, and conversation turns |
| `/clear` | Clear the Telegram conversation history |
| `/memory` | Show memory summary (top 15 long-term, top 10 daily entries) |
| `/help` | List all available commands |
| *Any other text* | Processed as a full agentic request with all tools available |

## Full Tool Access

When you send a regular message (not a command), CoClaw processes it exactly like a Copilot Chat request — with access to all VS Code tools:

- Read and edit files in the workspace
- Run terminal commands
- Search the codebase
- Read and write memories

In Telegram mode, tools are auto-approved (no confirmation dialogs), making it ideal for remote coding.

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
