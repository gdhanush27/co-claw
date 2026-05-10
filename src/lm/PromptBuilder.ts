import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';
import { WorkspaceMemory } from '../memory/WorkspaceMemory';
import { SoulConfig } from '../profile/SoulConfig';
import { UserProfile } from '../profile/UserProfile';
import { MemorySearchResult } from '../memory/types';

export class PromptBuilder {
    constructor(
        private readonly memoryEngine: MemoryEngine,
        private readonly soulConfig: SoulConfig,
        private readonly userProfile: UserProfile,
    ) {}

    async build(userMessage: string, model: vscode.LanguageModelChat, telegramMode = false, openMode = false): Promise<string> {
        const soul = await this.soulConfig.load();
        const user = await this.userProfile.load();

        // Retrieve relevant memories
        const tokenBudgetPercent = vscode.workspace.getConfiguration('CoClaw.memory').get<number>('tokenBudgetPercent', 20);
        const maxMemoryTokens = Math.floor(model.maxInputTokens * (tokenBudgetPercent / 100));

        const relevantMemories = await this.memoryEngine.recall(userMessage, maxMemoryTokens);

        // Also get workspace context entries (cached file structures, search results)
        const workspaceContext = await this.memoryEngine.searchMemory('workspace', 'all');

        // In /open mode, also load workspace-based MEMORY.md + daily logs
        let workspaceMemoryContext = '';
        if (openMode) {
            workspaceMemoryContext = await WorkspaceMemory.buildMemoryContext();
        }

        return this.assemblePrompt(soul, user, relevantMemories, workspaceContext, telegramMode, openMode, workspaceMemoryContext);
    }

    private assemblePrompt(
        soul: { name: string; role: string; instructions: string; tone: string },
        user: { preferredLanguage: string; codeStyle: string; indentation: string; verbosity: string; frameworks: string[] },
        memories: MemorySearchResult[],
        workspaceContext: import('../memory/types').MemoryEntry[],
        telegramMode = false,
        openMode = false,
        workspaceMemoryContext = '',
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

        // Telegram-mode addendum
        if (telegramMode) {
            parts.push(`<telegram_mode>
The user is controlling you REMOTELY from Telegram. Auto-approve is enabled — all tools work without dialogs.

RULES:
1. Use ALL tools normally — file read, file edit/create, terminal, search — everything works.
2. Edit files DIRECTLY using tools. NEVER create helper scripts (.py, .js, etc.) to make edits. Use the file edit/create tools directly on any file, including dotfiles (.env, .gitignore, etc.).
3. Run terminal commands directly when needed. Do NOT tell the user to run them — just run them.
4. Keep responses SHORT — the user reads on a phone.
5. Summarize results briefly. Never dump full file contents in responses.
</telegram_mode>`);
        }

        // OpenClaw /open mode addendum
        if (openMode) {
            parts.push(`<open_mode>
You are running in OpenClaw mode (/open). This means:
- You are a PERSISTENT, PROACTIVE agent connected via Telegram
- You have access to workspace-based MEMORY.md and daily logs (memory/YYYY-MM-DD.md)
- A heartbeat system periodically checks HEARTBEAT.md and may notify the user proactively
- MEMORY.md is automatically updated after each conversation with important facts (preferences, decisions, conventions)
- You can also EXPLICITLY write to MEMORY.md using file tools when the user says "remember this" or you discover something important
- Daily logs (memory/YYYY-MM-DD.md) are automatically appended with conversation summaries
- You can ONLY access files within the current workspace folder
- Think of yourself as a colleague who works alongside the user, not just a chatbot

CRON JOBS — You can schedule tasks! When the user asks you to:
- Do something later ("remind me in 20 minutes", "check the build in 1 hour")
- Set up a recurring task ("every morning at 7am summarize my inbox")
- Schedule any delayed or periodic work

Respond with a CRON_PROPOSAL block like this:
\`\`\`cron
SCHEDULE: <cron expression or relative time like 20m, 1h>
NAME: <short descriptive name>
PROMPT: <the task prompt for the scheduled job>
\`\`\`

The system will parse this and ask the user for Y/N confirmation before creating the job.
Do NOT use /cron commands directly — use the CRON_PROPOSAL format above so the user can confirm.
For existing cron jobs, do NOT claim you deleted, paused, resumed, or listed them unless the system command path confirmed it. If cron management is ambiguous, ask the user to use /cron list and a specific job id.

Examples of schedules:
- "20m" or "1h" or "2h30m" = one-shot timer (auto-deletes after running)
- "0 7 * * *" = every day at 7:00 AM
- "0 */2 * * *" = every 2 hours
- "30 9 * * 1-5" = weekdays at 9:30 AM

FILE DELIVERY — When the user asks you to "send", "share", "give me", or "upload" a file (e.g. "send me the package.json", "share that log file"), use the \`CoClaw_telegram_send_file\` tool with the workspace-relative path. Do NOT just paste the file contents into chat — actually call the tool so the user gets the real file in Telegram.
</open_mode>`);

            // Tone + emoji preferences for /open mode (Telegram session).
            const tgCfg = vscode.workspace.getConfiguration('CoClaw.telegram');
            const tone = tgCfg.get<string>('tone', 'sarcastic');
            const useEmojis = tgCfg.get<boolean>('useEmojis', true);
            const toneBlock = buildToneBlock(tone, useEmojis);
            if (toneBlock) {
                parts.push(toneBlock);
            }
        }

        // Workspace-based memory (MEMORY.md + daily logs) — injected in /open mode
        if (workspaceMemoryContext) {
            parts.push(workspaceMemoryContext);
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

/**
 * Build a tone-and-emoji prompt block for /open mode based on user settings.
 * Returns an empty string when tone is "neutral" and emojis are off.
 */
function buildToneBlock(tone: string, useEmojis: boolean): string {
    const t = (tone || 'sarcastic').toLowerCase();
    const emojiNote = useEmojis
        ? '- Use emojis freely (1-3 per message) to add personality and color.'
        : '- Do NOT use emojis. Plain text only.';

    let toneRules: string;
    switch (t) {
        case 'sarcastic':
            toneRules = [
                '- Open every reply with a single dry, sarcastic one-liner (max ~15 words).',
                useEmojis
                    ? '- Sprinkle 1-3 fitting emojis (🤡 🥱 🤔 👀 🤨 🌚 💩 🦄 🥴 🤓 🤯 🍌 🙈).'
                    : emojiNote,
                '- After the snark, deliver the ACTUAL answer / do the actual work properly. Sarcasm never replaces correctness.',
                '- Keep it playful, never mean. Punch up at the task, not down at the user.',
                "- Don't repeat the same opener twice in a row.",
            ].join('\n');
            break;
        case 'friendly':
            toneRules = [
                '- Be warm, encouraging, and conversational. Talk like a helpful friend.',
                emojiNote,
                '- Acknowledge what the user wants briefly before diving in.',
                '- Celebrate small wins ("nice", "got it", "done") without overdoing it.',
            ].join('\n');
            break;
        case 'professional':
            toneRules = [
                '- Be concise, precise, and businesslike. No filler, no jokes, no chit-chat.',
                useEmojis
                    ? '- Use emojis sparingly (0-1) and only when functional (✅ ❌ ⚠️ 📁).'
                    : emojiNote,
                '- Lead with the answer. Use short paragraphs and clear bullet points.',
            ].join('\n');
            break;
        case 'playful':
            toneRules = [
                '- Be enthusiastic, fun, and a little silly. Use casual language.',
                useEmojis
                    ? '- Lean into emojis (2-4 per message): 🚀 ✨ 🎉 🐾 🔥 💪 🦞 🤩 😎.'
                    : emojiNote,
                '- Hype the user up a bit, but always finish the actual work properly.',
            ].join('\n');
            break;
        case 'neutral':
        default:
            // Neutral + no-emojis = no addendum needed (use the base soul prompt as-is).
            if (!useEmojis) { return ''; }
            toneRules = [
                '- Keep tone calm and matter-of-fact.',
                emojiNote,
            ].join('\n');
            break;
    }

    return `<tone_preferences>
You are running in a Telegram session. Apply this tone on top of your normal behavior:
${toneRules}
- Tone is the WRAPPER, not the substance. Always complete the actual task correctly using tools.
</tone_preferences>`;
}
