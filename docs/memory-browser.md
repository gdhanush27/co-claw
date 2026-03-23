# Memory Browser

The Memory Browser is an interactive webview panel for inspecting, editing, and managing all of CoClaw's stored memories.

## Opening the Browser

**Command Palette:**

1. Press `Ctrl+Shift+P`.
2. Run **CoClaw: Browse Memory**.

The Memory Browser opens as a panel within VS Code.

## Interface

The browser shows all memory entries across both layers (daily log and long-term). Each entry displays:

- **Type badge** — Color-coded label (fact, decision, preference, convention, code_context, pattern).
- **Content** — The memory text.
- **Importance** — Numeric score from 0 to 1.
- **Source** — How the entry was created (auto-extracted, manual, distilled).
- **Timestamps** — Created date and last-used date.
- **Pin status** — Whether the entry is pinned.

## Actions

### Search & Filter

Use the search bar to filter entries by keyword. You can also filter by memory type using the type dropdown.

### Edit an Entry

Click on an entry to edit its content and importance score. Changes are saved immediately.

### Pin / Unpin

Toggle the pin on an entry to protect it from:

- **Pruning** — Pinned entries are never removed when the long-term memory cap is reached.
- **Decay** — Pinned entries don't lose importance over time.

### Promote to Long-Term

Daily log entries can be promoted to long-term memory directly from the browser. This is useful when you spot an important fact that shouldn't wait for distillation.

### Delete

Remove individual entries from either memory layer.

## When to Use

- **After a coding session** — Review what was auto-extracted and pin important memories.
- **Before a complex task** — Check what CoClaw already knows about the project.
- **Periodic cleanup** — Delete outdated or irrelevant entries, promote valuable daily logs.
- **Debugging memory** — Verify that CoClaw is extracting the right information.
