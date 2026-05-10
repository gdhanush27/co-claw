# Configuration

All CoClaw settings are under the `CoClaw.*` namespace. Open them quickly with **CoClaw: Open Settings** from the Command Palette.

## Memory Settings

### `CoClaw.memory.maxLongTermEntries`

- **Type:** number
- **Default:** `100`
- **Description:** Maximum number of long-term memory entries. When exceeded, the least important unpinned entries are removed.

### `CoClaw.memory.dailyLogsRetentionDays`

- **Type:** number
- **Default:** `30`
- **Description:** Daily log files older than this many days are automatically pruned on startup.

### `CoClaw.memory.autoExtract`

- **Type:** boolean
- **Default:** `true`
- **Description:** When enabled, CoClaw automatically extracts facts, decisions, and preferences from each conversation exchange. Disable if you prefer to manage memories manually.

### `CoClaw.memory.tokenBudgetPercent`

- **Type:** number
- **Default:** `20`
- **Description:** Percentage of the model's maximum input tokens reserved for memory context. Higher values inject more memories but leave less room for conversation history and tool results.

### `CoClaw.memory.autoDistillThreshold`

- **Type:** number
- **Default:** `20`
- **Description:** When the daily log reaches this many entries, auto-distillation triggers. Set to `0` to disable threshold-based auto-distillation.

### `CoClaw.memory.autoDistillIntervalHours`

- **Type:** number
- **Default:** `24`
- **Description:** How often (in hours) auto-distillation runs. Set to `0` to disable interval-based auto-distillation.

### `CoClaw.memory.staleAfterDays`

- **Type:** number
- **Default:** `14`
- **Description:** Entries unused for this many days receive a reduced ranking score during recall. Set to `0` to disable staleness penalties.

## Model Settings

### `CoClaw.model.family`

- **Type:** string
- **Default:** `""` (empty — uses global preference)
- **Description:** Override the Copilot model family at the workspace level. When set, this workspace uses the specified model regardless of the global selection. Leave empty to use the globally selected model.

## Heartbeat Settings (`/open` mode)

### `CoClaw.heartbeat.enabled`

- **Type:** boolean
- **Default:** `true`
- **Description:** Enable proactive heartbeat checks while `/open` mode is running.

### `CoClaw.heartbeat.intervalMinutes`

- **Type:** number
- **Default:** `30`
- **Description:** Minutes between heartbeats. Range: 5–1440.

### `CoClaw.heartbeat.activeHoursStart` / `CoClaw.heartbeat.activeHoursEnd`

- **Type:** string (`HH:MM`, 24h format)
- **Defaults:** `"08:00"` / `"22:00"`
- **Description:** Heartbeats only fire inside this window.

## Telegram Settings

### `CoClaw.telegram.tone`

- **Type:** string (enum)
- **Default:** `"sarcastic"`
- **Allowed:** `sarcastic`, `friendly`, `professional`, `playful`, `neutral`
- **Description:** Conversational tone the assistant uses in Telegram `/open` mode. Pick `neutral` if you want no tone addendum on top of the base `SOUL.json` persona.

### `CoClaw.telegram.useEmojis`

- **Type:** boolean
- **Default:** `true`
- **Description:** Master switch for emojis. When off, the assistant is told to write plain text only AND incoming-message reactions are skipped.

### `CoClaw.telegram.sarcasticReactions`

- **Type:** boolean
- **Default:** `true`
- **Description:** When enabled (and `useEmojis` is on), each user message in `/open` mode gets a sarcastic emoji reaction.

## Multi-Agent Settings

### `CoClaw.agents.mode`

- **Type:** string (enum)
- **Default:** `"slash"`
- **Allowed:** `off`, `slash`, `always`
- **Description:** When `slash`, the orchestrator runs only on `/agents`. When `always`, every prompt is routed through the orchestrator (experimental). `off` disables orchestration entirely.

### `CoClaw.agents.maxParallelCoders`

- **Type:** integer
- **Default:** `4`
- **Range:** 1–8
- **Description:** Maximum number of coder agents that may run in parallel during a `/agents` run.

## Recommended Configurations

### Minimal Memory Footprint

```json
{
  "CoClaw.memory.maxLongTermEntries": 50,
  "CoClaw.memory.dailyLogsRetentionDays": 7,
  "CoClaw.memory.tokenBudgetPercent": 10,
  "CoClaw.memory.autoDistillThreshold": 10
}
```

### Maximum Context

```json
{
  "CoClaw.memory.maxLongTermEntries": 200,
  "CoClaw.memory.dailyLogsRetentionDays": 60,
  "CoClaw.memory.tokenBudgetPercent": 30,
  "CoClaw.memory.staleAfterDays": 30
}
```

### Manual Memory Only

```json
{
  "CoClaw.memory.autoExtract": false,
  "CoClaw.memory.autoDistillThreshold": 0,
  "CoClaw.memory.autoDistillIntervalHours": 0
}
```
