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
