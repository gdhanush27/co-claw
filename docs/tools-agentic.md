# Tools & Agentic Mode

CoClaw operates as an **agentic** assistant — it can use VS Code tools to read files, edit code, run commands, and manage its own memory autonomously.

## How Agentic Mode Works

When you send a message, CoClaw can decide to use tools before responding. The tool execution loop:

1. The model generates a response, optionally requesting tool calls.
2. All requested tools are invoked concurrently.
3. Results are cached and added to the conversation.
4. The model processes tool results and may make additional calls.
5. The loop repeats until the model responds without tool calls (max 30 rounds).

## Available Tools

### VS Code Built-in Tools

CoClaw has access to all tools provided by VS Code and the Copilot Chat extension:

- **File reading** — Read file contents within the workspace.
- **File editing** — Create and modify files.
- **Terminal** — Run shell commands.
- **Code search** — Search across the workspace.

### CoClaw Memory Tools

CoClaw can also manage its own memory through dedicated tools:

| Tool | Description |
|---|---|
| `CoClaw_memory_read` | Query memories by keyword and layer (daily/longterm/all) |
| `CoClaw_memory_write` | Store a new memory with type and importance |
| `CoClaw_memory_update` | Modify an existing entry by ID or keyword |
| `CoClaw_memory_delete` | Remove entries by ID, keyword, or clear entire layers |

### Workspace Context Tool

| Tool | Description |
|---|---|
| `CoClaw_workspace_context` | Returns current workspace state — open tabs, active file, language, selection |

The workspace context tool provides:

```json
{
  "workspaceFolders": ["path/to/folder"],
  "openTabs": ["file1.ts", "file2.py"],
  "activeFile": "current/file.ts",
  "language": "typescript",
  "lineCount": 250,
  "selectedText": "[current selection, max 2000 chars]"
}
```

This lets the model understand your current context without searching.

### Multi-Agent & Orchestration Tools

These tools are used internally by the multi-agent orchestrator (`/agents`) and by specialized agents running in parallel:

| Tool | Description |
|---|---|
| `CoClaw_shared_memory_read` | Read key/value entries written by sibling agents in the current orchestration run |
| `CoClaw_shared_memory_write` | Write a key/value entry so dependent agents can read it |
| `CoClaw_get_task_status` | Inspect the live status (pending/running/done/failed) of all tasks in a multi-agent run |
| `CoClaw_spawn_agent` | Spawn a new specialized agent within an orchestration run |

### Telegram Tool

| Tool | Description |
|---|---|
| `CoClaw_telegram_send_file` | Upload a workspace file to the linked Telegram user as a document (up to 50 MB) |

## Safety Features

### Workspace Boundaries

CoClaw blocks access to files outside the current workspace folders. All file operations are scoped — including in multi-root workspaces, where any of the registered roots is accepted.

### Interactive UI Tool Filter

Across every surface CoClaw drives autonomously (chat participant, Telegram bridge, multi-agent orchestrator), tools that pop up a blocking VS Code dialog — Simple Browser, Live Preview, browser screenshot/click tools, etc. — are stripped from the model's tool list. Otherwise an off-screen "Share existing tab?" prompt would silently hang the run. The shared denylist lives in `src/lm/toolFilter.ts`.

### Context Management

- **Result truncation** — Tool results are capped at 16,000 characters to prevent context overflow.
- **Context trimming** — When approaching the token limit, older tool exchanges are removed in whole assistant/user-result pairs (the last 3 rounds are always kept) so the transcript never desyncs the model.
- **Session caching** — Duplicate tool calls within the same request return cached results.

### Loop Protection

- **Max rounds** — Tool execution stops after 30 rounds.
- **Exploration detection** — If the model makes more than 5 consecutive read-only rounds without edits, it's nudged to start implementing.
- **Continuation limit** — If the model stops early during edits, up to 5 auto-continuations are attempted.

## Result Persistence

Valuable tool results (file reads, code searches) are automatically summarized and stored in memory:

- **File reads** — File path, line count, and key function/class signatures are stored as `code_context` memories.
- **Search results** — Query and matched file paths are stored as `code_context` memories.

This means CoClaw gradually builds a map of your codebase through normal use.
