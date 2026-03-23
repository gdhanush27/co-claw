# Memory System

CoClaw uses a two-layer memory architecture to store and recall context across sessions. Memories are extracted automatically from conversations and injected into future prompts.

## Architecture Overview

```
Conversation
    │
    ▼
┌──────────────────┐
│ Memory Extractor  │  ← Extracts facts from each exchange
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   Daily Log       │  ← Short-term, one file per day
└────────┬─────────┘
         │  (distill)
         ▼
┌──────────────────┐
│ Long-Term Memory  │  ← Persistent knowledge base
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Memory Recall    │  ← Ranks & injects into prompts
└──────────────────┘
```

## Daily Log (Short-Term)

The daily log captures facts extracted from each conversation, stored in one file per calendar day (e.g., `2026-03-23.json`).

**Key behaviors:**

- New entries are appended to today's log automatically after each response.
- Entries older than the retention period (default: 30 days) are pruned automatically.
- You can view today's entries with the `/memory` slash command.
- Clearing session memory (`/clear`) wipes only the daily log.

## Long-Term Memory (Persistent)

Long-term memory is a curated knowledge base stored in a single `longterm.json` file. Entries arrive here through **distillation** — a process where the model consolidates daily logs into concise, deduplicated long-term entries.

**Key behaviors:**

- Capped at a configurable maximum (default: 100 entries).
- When the cap is reached, the least important unpinned entries are removed.
- Entries can be **pinned** to protect them from pruning and decay.
- Importance decays over time for unused entries (after 30 days of non-use).

## Memory Entry Structure

Each memory entry contains:

| Field | Description |
|---|---|
| `id` | Unique identifier (UUID) |
| `content` | The memory text |
| `type` | Category — see below |
| `tags` | Searchable metadata tags |
| `importance` | Weight from 0 to 1 (higher = more relevant) |
| `createdAt` | When the entry was created |
| `lastUsedAt` | Last time the entry was recalled |
| `source` | How it was created: `auto-extracted`, `manual`, or `distilled` |
| `pinned` | If true, exempt from pruning and decay |

### Memory Types

| Type | Description | Example |
|---|---|---|
| `fact` | Technical project fact | "API runs on port 3000" |
| `decision` | Architecture or design choice | "Chose PostgreSQL over MongoDB" |
| `preference` | User tool/framework preference | "Prefers functional style over OOP" |
| `convention` | Coding style or naming rule | "Use camelCase for variables" |
| `code_context` | File or module structure info | "UserService handles authentication" |
| `pattern` | Recurring code idiom | "Factory pattern for service creation" |

## Automatic Extraction

After each conversation exchange, CoClaw automatically extracts up to **3 facts** using a lightweight Copilot model. The extractor categorizes each fact, assigns an importance score, and stores it in the daily log.

**Importance ranges:**

- **0.3–0.5** — Nice-to-know information
- **0.5–0.7** — Useful, referenced occasionally
- **0.7–1.0** — Critical decisions or preferences

**What gets extracted:**

- Coding conventions and naming rules
- Architecture and design decisions
- Tool and framework preferences
- Technical project facts
- File and module relationships
- Recurring patterns

**What gets skipped:**

- Greetings and small talk
- Obvious code facts (e.g., "this is a function")
- Error messages and stack traces
- Generic programming knowledge

You can disable auto-extraction by setting `CoClaw.memory.autoExtract` to `false`.

## Memory Recall

When you send a message, CoClaw recalls the most relevant memories and injects them into the system prompt. The recall algorithm scores each entry based on:

1. **Keyword overlap** — How well the memory matches your message.
2. **Importance** — The entry's assigned importance weight.
3. **Recency** — More recent entries score higher.
4. **Staleness penalty** — Unused entries (beyond `staleAfterDays`) are ranked lower.

Results are fitted within a token budget (default: 20% of the model's context window).

## Distillation

Distillation consolidates daily logs into curated long-term memories. It:

1. Collects recent daily log entries.
2. Uses the model to summarize, deduplicate, and prioritize.
3. Stores the result as long-term entries with source `distilled`.
4. Automatically deduplicates the long-term store afterward.

**Trigger distillation manually:**

- In chat: `@CoClaw /distill`
- From the Command Palette: **CoClaw: Distill to Long-Term Memory**

**Auto-distillation** runs when:

- The daily log reaches a threshold (default: 20 entries).
- The configured interval has passed (default: every 24 hours).

Configure these via `CoClaw.memory.autoDistillThreshold` and `CoClaw.memory.autoDistillIntervalHours`. Set either to `0` to disable.

## Deduplication

CoClaw detects near-duplicate entries using word overlap analysis. Two entries with more than **60% word overlap** are considered duplicates — the older/less important one is removed.

Run deduplication manually from the Command Palette: **CoClaw: Deduplicate Memory**.

Deduplication also runs automatically after each distillation.

## Workspace Isolation

Each workspace/folder gets a unique ID (SHA256 hash of workspace folder paths). Memories are tagged with a workspace identifier to prevent cross-project leakage. When recalling memories, only entries tagged for the current workspace are returned.

## Import & Export

**Export** all memories (daily + long-term) as a JSON file:

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **CoClaw: Export Memories**.
3. Choose a save location.

**Import** memories from a JSON file:

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **CoClaw: Import Memories**.
3. Select the JSON file.

The import validates each entry's type, content length, and tags before adding it.

## Privacy

All memory data is stored locally in VS Code's global storage directory. No external services are used beyond GitHub Copilot API calls. CoClaw enforces workspace boundaries and never accesses files outside the current workspace.
