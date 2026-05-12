# Model Switching

CoClaw lets you choose which Copilot model to use and switch between models at any time.

## How It Works

CoClaw queries the VS Code Language Model API for all available Copilot models. The selected model is persisted in global state and used for all subsequent conversations, even across VS Code restarts.

## Selecting a Model

### From the Command Palette

1. Press `Ctrl+Shift+P`.
2. Run **CoClaw: Select Model**.
3. A quick-pick dialog appears showing all available models.

Each entry displays:

- **Model name** — The display name (e.g., "GPT-4o", "Claude 3.5 Sonnet").
- **Model family** — The identifier used internally.
- **Max input tokens** — The context window size.

Select a model and it becomes active immediately.

### From the Status Bar

The bottom status bar shows the currently active model name. Click it to open the model selector.

## Model Fallback

If your preferred model becomes unavailable (e.g., after a Copilot update), CoClaw falls back to the first available model automatically.

## Workspace Override

You can set a per-workspace model preference via settings:

1. Open Settings (`Ctrl+,`).
2. Search for `CoClaw.model.family`.
3. Set the model family identifier (e.g., `"gpt-4o"`).

When set, this workspace-level preference overrides the global selection for that workspace only.

## Token Budget Interaction

The model's `maxInputTokens` determines how much memory context CoClaw can inject. With a larger context window model, more memories are included in each prompt. The token budget is controlled by `CoClaw.memory.tokenBudgetPercent` (default: 20%).

**Example:** With a 128K-token model and 20% budget, up to ~25,600 tokens of memory are injected.

## Tier-Based Model Selection

CoClaw supports assigning different Copilot models to different task difficulty tiers: **light**, **medium**, and **hard**. This is most useful for multi-agent orchestration (`/agents`): the Planner tags each sub-task with a difficulty, and the Orchestrator routes that sub-task to the model you configured for that tier.

| Tier   | Intended workload                                                                |
|--------|----------------------------------------------------------------------------------|
| light  | Trivial / formulaic work — typos, renames, version bumps, one-line patches.     |
| medium | Typical implementation, review, and test work. The default when unsure.          |
| hard   | Multi-file refactors, architectural design, security-sensitive logic.            |

### Pick models via VS Code Quick Pick

1. Press `Ctrl+Shift+P`.
2. Run **CoClaw: Select Tier Models (Light / Medium / Hard)**.
3. Pick the tier you want to configure.
4. Pick a Copilot model family from the list — or pick **Clear override** to reset that tier back to the default model.

Repeat for the other tiers as needed. Selections persist as VS Code settings (`CoClaw.models.light` / `.medium` / `.hard`), so they roam with Settings Sync.

### Pick models from Telegram

There are two equivalent flows:

- Send `/models` (alias `/m`) to jump straight into the **Model Tiers** panel.
- Or send `/settings` (alias `/s`) and tap the **Model Tiers** group.

For each tier, the bot renders one inline button per available Copilot model family — tap to assign. Tap **🗑 Clear (use default)** to drop the override.

### Pick models from chat with `/model`

The `/model` chat command lets you inspect and change models without leaving the conversation.

| Command | Effect |
|---|---|
| `/model` | Show the active model, all tier overrides, and one-click "Pick…" buttons. |
| `/model list` | List every Copilot model family currently available to you (live). |
| `/model gpt-4o-mini` | Switch the **general** model directly. Fuzzy match — `/model claude` will list every Claude family as buttons if more than one matches. |
| `/model tier hard` | Open the Quick Pick for the **hard** tier (skips the "which tier?" step). |
| `/model tier hard claude-opus-4` | Set the **hard** tier model directly. |
| `/model clear` | Drop the general model preference (revert to first available). |
| `/model clear hard` | Drop the **hard** tier override (revert to general default). |
| `/model help` | Print the table above. |

The status bar and the next `/agents` run pick up the change immediately — no reload needed.

### Pick models from VS Code Settings GUI

1. Open Settings (`Ctrl+,`).
2. Search for `CoClaw.models`.
3. Each of the three tier settings (`light`, `medium`, `hard`) plus the top-level `CoClaw.model.family` now renders as a **dropdown** of known Copilot model families, with friendly labels like "GPT-5", "Claude Opus 4", and "Gemini 2.5 Pro".
4. Pick `(default — use top-level model)` on a tier to clear its override.

> **Note:** the dropdown ships with a curated list of stable Copilot model family identifiers. If Copilot ever exposes a new family that isn't in the dropdown yet, use **CoClaw: Select Tier Models** from the Command Palette (or `/models` in Telegram) — both surfaces pull the **live** list from Copilot at the moment you open them, so they always reflect what's actually available to you right now.

If you'd rather edit `settings.json` directly:

| Setting | Example value |
|---|---|
| `CoClaw.models.light` | `gpt-4o-mini` |
| `CoClaw.models.medium` | `gpt-4o` |
| `CoClaw.models.hard` | `claude-3.5-sonnet` |

Leave any tier empty to fall back to the general `CoClaw.model.family` selection (or the first available model).

### How It Works End-to-End

1. The Planner agent emits a `"difficulty"` field on each sub-task in its JSON DAG (`"light"`, `"medium"`, or `"hard"`).
2. The Orchestrator calls `ModelManager.getModelForTier(difficulty ?? "medium")` immediately before invoking each sub-task agent.
3. If no tier-specific override is configured — or the configured family isn't currently available — the call falls back to the general active model. A one-shot warning is logged to the **CoClaw** output channel whenever a configured family resolves to nothing, so silent fallback can't slip past you.
4. Dynamic tasks spawned via `CoClaw_spawn_agent` can also pass an explicit `"difficulty"`; without it they default to medium.
5. When the Coder fan-out splits a single task into parallel units, each child inherits the parent's difficulty.
