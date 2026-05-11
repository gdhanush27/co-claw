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

### `CoClaw.heartbeat.timezone`

- **Type:** string (IANA zone)
- **Default:** `""`
- **Description:** Optional IANA time zone (e.g. `Asia/Kolkata`, `America/New_York`) used to evaluate active hours. Useful when CoClaw runs on a server set to UTC but you want heartbeats to follow your local clock. Leave empty to use the host's local time.

## Logging

### `CoClaw.logging.level`

- **Type:** string (enum)
- **Default:** `"error"`
- **Allowed:** `off`, `error`, `warn`, `info`, `debug`
- **Description:** Verbosity of the **CoClaw** output channel (View → Output → CoClaw). Bump to `info` to see lifecycle events; bump to `debug` when filing a bug so the channel captures full traces.

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

### `CoClaw.telegram.silentUnauthorized`

- **Type:** boolean
- **Default:** `false`
- **Description:** When `true`, messages from non-linked users are dropped silently instead of receiving an `⛔ Unauthorized` reply. Useful if your bot is added to shared chats and you don't want to advertise its presence.

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

## Tool-Selection Settings

These settings control which tools CoClaw forwards to the language model on every request. They apply uniformly across the chat participant, the Telegram bridge, and the multi-agent orchestrator.

### `CoClaw.tools.maxPerRequest`

- **Type:** integer
- **Default:** `120`
- **Range:** 1–256
- **Description:** Hard ceiling on tool count per LM request. Most providers (OpenAI, Gemini) reject requests carrying more than 128 tools with `Cannot have more than 128 tools per request`. The default 120 leaves an 8-tool headroom for any platform-injected tools. Lower this if your model is stricter (some Anthropic-routed setups cap at 64).
- **Selection order when the cap is hit:**
    1. Tools matched by `CoClaw.tools.priority` (user-pinned).
    2. Tools whose name starts with `CoClaw_` (memory, telegram, etc.).
    3. Common file/edit/search/terminal tools (`read_file`, `apply_patch`, `grep`, `codebase`, …).
    4. Everything else, sorted alphabetically for deterministic cache hits.
- A `warn`-level entry is written to the **CoClaw** output channel listing the first 10 dropped tool names whenever the cap kicks in.

### `CoClaw.tools.exclude`

- **Type:** string array
- **Default:** `[]`
- **Description:** Case-insensitive substring patterns. Any tool whose name contains a listed pattern is dropped before the request reaches the model. Use this to mute noisy MCP servers or extension tools you never want the assistant to call.
- **Examples:**

```json
{
  "CoClaw.tools.exclude": ["mssql", "jupyter", "preview"]
}
```

### `CoClaw.tools.priority`

- **Type:** string array
- **Default:** `[]`
- **Description:** Case-insensitive substring patterns. Matching tools are bumped to the top tier so they survive the per-request cap even when the registry is huge. Use sparingly — `CoClaw_*` tools are already auto-prioritized; you only need this for niche third-party tools you can't afford to lose.
- **Example:**

```json
{
  "CoClaw.tools.priority": ["github_pr", "k8s_apply"]
}
```

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
