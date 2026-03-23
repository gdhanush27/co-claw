# Identity & Profile

CoClaw lets you customize both its personality and your coding preferences through two JSON files.

## SOUL.json — Assistant Identity

`SOUL.json` defines how CoClaw behaves, communicates, and introduces itself. The file is injected into every system prompt.

**Location:** VS Code global storage → `profile/SOUL.json`

### Default Configuration

```json
{
  "name": "CoClaw",
  "role": "AI pair programmer with persistent memory",
  "instructions": "You remember past conversations. Reference stored memories when relevant. Be concise and helpful.",
  "tone": "professional, direct"
}
```

### Fields

| Field | Description | Example |
|---|---|---|
| `name` | The assistant's display name | `"Cody"`, `"DevBot"` |
| `role` | What the assistant does | `"Senior TypeScript architect"` |
| `instructions` | Behavioral directives injected into every prompt | `"Always suggest tests. Prefer functional patterns."` |
| `tone` | Communication style | `"friendly, verbose"`, `"technical, terse"` |

### How to Edit

**Option 1 — Chat command:**

```
@CoClaw /soul
```

**Option 2 — Command Palette:**

1. Press `Ctrl+Shift+P`.
2. Run **CoClaw: Edit Identity (SOUL)**.

Both options open `SOUL.json` in the editor. Save the file — changes take effect on the next chat message.

### Examples

**Technical Lead persona:**

```json
{
  "name": "TechLead",
  "role": "Senior staff engineer who reviews code thoroughly",
  "instructions": "Always consider edge cases. Suggest tests for every change. Prefer type safety over convenience. Flag potential performance issues.",
  "tone": "constructive, detail-oriented"
}
```

**Minimal helper:**

```json
{
  "name": "Helper",
  "role": "Quick coding assistant",
  "instructions": "Keep answers short. Show code, skip explanations unless asked.",
  "tone": "concise, direct"
}
```

## USER.json — Your Preferences

`USER.json` stores your personal coding preferences. Non-empty fields are injected into the system prompt so CoClaw tailors its responses to your style.

**Location:** VS Code global storage → `profile/USER.json`

### Default Configuration

```json
{
  "preferredLanguage": "",
  "codeStyle": "",
  "indentation": "",
  "verbosity": "",
  "frameworks": []
}
```

### Fields

| Field | Type | Description | Example |
|---|---|---|---|
| `preferredLanguage` | string | Your primary programming language | `"TypeScript"` |
| `codeStyle` | string | Coding style preferences | `"Functional > OOP, minimize side effects"` |
| `indentation` | string | Indentation style | `"2 spaces"`, `"tabs"` |
| `verbosity` | string | How detailed responses should be | `"Concise"`, `"Detailed with examples"` |
| `frameworks` | string[] | Frameworks you use | `["React", "Node.js", "Express"]` |

### How to Edit

**Command Palette:**

1. Press `Ctrl+Shift+P`.
2. Run **CoClaw: Edit Profile (USER)**.

This opens `USER.json` in the editor. Save — changes apply on the next message.

### Example

```json
{
  "preferredLanguage": "TypeScript",
  "codeStyle": "Functional > OOP, minimize side effects",
  "indentation": "2 spaces",
  "verbosity": "Concise, direct explanations",
  "frameworks": ["React", "Next.js", "Prisma", "tRPC"]
}
```

With this profile, CoClaw will default to TypeScript examples, prefer functional patterns, use 2-space indentation, and be aware of your framework stack.

## How It's Injected

When building a prompt, CoClaw wraps these files into structured sections:

**SOUL → Identity block:**

```
You are CoClaw, AI pair programmer with persistent memory.
You remember past conversations. Reference stored memories when relevant.
Be concise and helpful.
Tone: professional, direct
```

**USER → Preferences block (only non-empty fields):**

```
Language: TypeScript
Style: Functional > OOP, minimize side effects
Indentation: 2 spaces
Verbosity: Concise, direct explanations
Frameworks: React, Next.js, Prisma, tRPC
```

Both sections appear before memory context and the user's message, ensuring CoClaw's behavior and your preferences are always respected.
