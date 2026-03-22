import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';
import { SoulConfig } from '../profile/SoulConfig';
import { UserProfile } from '../profile/UserProfile';
import { MemorySearchResult } from '../memory/types';

export class PromptBuilder {
    constructor(
        private readonly memoryEngine: MemoryEngine,
        private readonly soulConfig: SoulConfig,
        private readonly userProfile: UserProfile,
    ) {}

    async build(userMessage: string, model: vscode.LanguageModelChat, telegramMode = false): Promise<string> {
        const soul = await this.soulConfig.load();
        const user = await this.userProfile.load();

        // Retrieve relevant memories
        const tokenBudgetPercent = vscode.workspace.getConfiguration('CoClaw.memory').get<number>('tokenBudgetPercent', 20);
        const maxMemoryTokens = Math.floor(model.maxInputTokens * (tokenBudgetPercent / 100));

        const relevantMemories = await this.memoryEngine.recall(userMessage, maxMemoryTokens);

        // Also get workspace context entries (cached file structures, search results)
        const workspaceContext = await this.memoryEngine.searchMemory('workspace', 'all');

        return this.assemblePrompt(soul, user, relevantMemories, workspaceContext, telegramMode);
    }

    private assemblePrompt(
        soul: { name: string; role: string; instructions: string; tone: string },
        user: { preferredLanguage: string; codeStyle: string; indentation: string; verbosity: string; frameworks: string[] },
        memories: MemorySearchResult[],
        workspaceContext: import('../memory/types').MemoryEntry[],
        telegramMode = false,
    ): string {
        const parts: string[] = [];

        // Identity + agentic instructions
        parts.push(`<identity>
You are ${soul.name}, ${soul.role}.
${soul.instructions}
Tone: ${soul.tone}
</identity>

<behavior>
You are an agentic coding assistant. You MUST use tools to complete tasks — never just talk about changes.

WORKFLOW:
1. Check the <workspace_context> section below — it contains known file structures and locations from previous sessions. Use this to skip redundant file searches.
2. If you already know which files to edit from context/memory, go STRAIGHT to reading and editing them. Do NOT re-search for files you already know about.
3. Read only the specific files you need to change — read the relevant section, then IMMEDIATELY edit it in the same round or next round.
4. Make all edits using tools — one file at a time, moving quickly.
5. After ALL files are edited, give a brief summary.

EFFICIENCY RULES (CRITICAL):
- Spend at most 3-4 tool rounds on exploration (searching + reading). After that, START EDITING.
- When you read a file, form your plan and start editing in the NEXT tool call. Do NOT keep reading more files first.
- Read large sections at once (e.g. 200+ lines) instead of many small reads of the same file.
- NEVER search for the same thing twice with different patterns. One search is enough.
- NEVER call the same tool with the same arguments twice — results are cached.
- If a search returns no results, try ONE alternative, then move on.
- ONLY access files within the current workspace. NEVER read, write, or reference files outside the workspace folders.

CONVERSATIONAL HANDLING:
- Not every message is a coding task. Greetings, questions, and casual conversation do NOT require tools.
- If the user is just chatting (e.g. "hi", "how are you", "what do you remember"), respond naturally and conversationally. Do NOT mention tasks, edits, or pending work unless the user asked about them.
- Only use the agentic workflow above when the user gives you an actual coding task to perform.

GENERAL RULES:
- NEVER ask the user to paste code. Read files with tools.
- When given a coding task, NEVER just describe or plan changes. Execute them with tools.
- NEVER stop mid-task. Keep calling tools until EVERY file is updated.
- Be efficient: if workspace_context tells you where a file is, don't search for it again.
- When reading files, read only the sections you need, not the entire file if it's large.
</behavior>`);

        // Telegram-mode addendum: minimize operations that trigger VS Code approval dialogs
        if (telegramMode) {
            parts.push(`<telegram_mode>
The user is controlling you REMOTELY from Telegram and CANNOT interact with VS Code's UI.
They CANNOT click any approve/allow/confirm dialogs. You must avoid ALL patterns that trigger them.

ABSOLUTE RULES — VIOLATIONS WILL BLOCK EXECUTION:
1. NEVER use terminal/shell/command tools. They ALWAYS show an approval dialog the user cannot click.
2. NEVER directly edit dotfiles (.env, .gitignore, .npmrc, .htaccess, .dockerignore, etc.) with file edit/create tools — they trigger a "sensitive file" dialog.
3. Use ONLY file read and file write/edit tools on regular source code files (.py, .js, .ts, .html, .css, .json, .yaml, .md, etc.).
4. If you need to create or modify a dotfile (.env, .gitignore, etc.), WRITE A HELPER SCRIPT (e.g. setup.py, setup.js) that creates it when run, then tell the user to run it later.
5. If a task absolutely requires a terminal command, tell the user what command to run — do NOT execute it yourself.
6. Keep responses SHORT — the user reads on a phone.
7. Summarize results. Never dump full file contents in responses.

SAFE WORKFLOW:
- Read files → make edits to source code files → summarize what you did
- For config/dotfiles: create a helper script that writes them, or tell the user the commands to run

EXAMPLES:
- Task: "add password hashing to .env" → Create a setup_env.py script that writes .env, tell user to run it
- Task: "edit flask_app.py" → Read it, edit it directly (safe, not a dotfile)
- Task: "run pip install" → Reply: "Run this when you're back: pip install flask bcrypt"
</telegram_mode>`);
        }

        // User preferences
        const prefs: string[] = [];
        if (user.preferredLanguage) { prefs.push(`Language: ${user.preferredLanguage}`); }
        if (user.codeStyle) { prefs.push(`Style: ${user.codeStyle}`); }
        if (user.indentation) { prefs.push(`Indentation: ${user.indentation}`); }
        if (user.verbosity) { prefs.push(`Verbosity: ${user.verbosity}`); }
        if (user.frameworks.length > 0) { prefs.push(`Frameworks: ${user.frameworks.join(', ')}`); }

        if (prefs.length > 0) {
            parts.push(`<user_preferences>
${prefs.join('\n')}
</user_preferences>`);
        }

        // Memories
        if (memories.length > 0) {
            const memoryLines = memories.map(m =>
                `  <entry type="${m.entry.type}" importance="${m.entry.importance.toFixed(1)}">${this.sanitizeForPrompt(m.entry.content)}</entry>`
            );
            parts.push(`<memory>
${memoryLines.join('\n')}
</memory>`);
        }

        // Workspace context from previous sessions (cached file reads, search results)
        const wsEntries = workspaceContext.filter(e => e.tags.includes('workspace'));
        if (wsEntries.length > 0) {
            const wsLines = wsEntries.slice(0, 30).map(e => `  ${this.sanitizeForPrompt(e.content)}`);
            parts.push(`<workspace_context>
These are known files and structures from previous tool calls. Use this to avoid redundant searches:
${wsLines.join('\n')}
</workspace_context>`);
        }

        return parts.join('\n\n');
    }

    /**
     * Sanitize memory content before embedding in prompt markup.
     * Escapes XML-special characters and strips sequences that could be
     * interpreted as prompt control instructions.
     */
    private sanitizeForPrompt(content: string): string {
        let s = content;
        // Escape XML-special characters to prevent markup injection
        s = s.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;');
        // Strip patterns resembling prompt control tags (e.g. &lt;system&gt;, &lt;/identity&gt;)
        s = s.replace(/&lt;\/?\s*(system|identity|behavior|user_preferences|memory|workspace_context|instructions?)\s*&gt;/gi, '');
        return s;
    }
}
