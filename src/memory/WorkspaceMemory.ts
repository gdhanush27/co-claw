import * as vscode from 'vscode';

/**
 * OpenClaw-style workspace memory layer.
 * Reads/writes MEMORY.md (long-term) and memory/YYYY-MM-DD.md (daily logs)
 * as plain Markdown files in the workspace root.
 *
 * These files are git-trackable, human-readable, and editable.
 */
export class WorkspaceMemory {
    /**
     * Get the workspace root URI, or undefined if no workspace is open.
     */
    private static getWorkspaceRoot(): vscode.Uri | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return undefined; }
        return folders[0].uri;
    }

    // ── MEMORY.md (Long-Term) ─────────────────────────────────────

    /**
     * Read MEMORY.md from the workspace root.
     * Returns empty string if the file doesn't exist.
     */
    static async readMemoryMd(): Promise<string> {
        const root = this.getWorkspaceRoot();
        if (!root) { return ''; }

        const memoryUri = vscode.Uri.joinPath(root, 'MEMORY.md');
        try {
            const data = await vscode.workspace.fs.readFile(memoryUri);
            return Buffer.from(data).toString('utf-8');
        } catch {
            return '';
        }
    }

    /**
     * Write content to MEMORY.md in the workspace root.
     */
    static async writeMemoryMd(content: string): Promise<void> {
        const root = this.getWorkspaceRoot();
        if (!root) { return; }

        const memoryUri = vscode.Uri.joinPath(root, 'MEMORY.md');
        await vscode.workspace.fs.writeFile(memoryUri, Buffer.from(content, 'utf-8'));
    }

    /**
     * Append a line to MEMORY.md.
     */
    static async appendToMemoryMd(line: string): Promise<void> {
        const existing = await this.readMemoryMd();
        const updated = existing ? `${existing.trimEnd()}\n${line}\n` : `# Memory\n\n${line}\n`;
        await this.writeMemoryMd(updated);
    }

    /**
     * Check if MEMORY.md exists in the workspace.
     */
    static async memoryMdExists(): Promise<boolean> {
        const root = this.getWorkspaceRoot();
        if (!root) { return false; }

        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, 'MEMORY.md'));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create a default MEMORY.md if it doesn't exist.
     */
    static async ensureMemoryMd(): Promise<void> {
        if (await this.memoryMdExists()) { return; }

        const defaultContent = `# Memory

## User Preferences
<!-- CoClaw will add your preferences here automatically -->

## Project Context
<!-- Key facts about the current project -->

## Decisions
<!-- Important decisions made during development -->
`;
        await this.writeMemoryMd(defaultContent);
    }

    // ── Daily Logs (memory/YYYY-MM-DD.md) ─────────────────────────

    /**
     * Get today's date string in YYYY-MM-DD format.
     */
    private static getTodayString(): string {
        const now = new Date();
        return now.toISOString().split('T')[0];
    }

    /**
     * Get yesterday's date string in YYYY-MM-DD format.
     */
    private static getYesterdayString(): string {
        const now = new Date();
        now.setDate(now.getDate() - 1);
        return now.toISOString().split('T')[0];
    }

    /**
     * Read a daily log file for a given date.
     */
    static async readDailyLog(dateStr: string): Promise<string> {
        const root = this.getWorkspaceRoot();
        if (!root) { return ''; }

        const logUri = vscode.Uri.joinPath(root, 'memory', `${dateStr}.md`);
        try {
            const data = await vscode.workspace.fs.readFile(logUri);
            return Buffer.from(data).toString('utf-8');
        } catch {
            return '';
        }
    }

    /**
     * Read today's daily log.
     */
    static async readTodayLog(): Promise<string> {
        return this.readDailyLog(this.getTodayString());
    }

    /**
     * Read yesterday's daily log.
     */
    static async readYesterdayLog(): Promise<string> {
        return this.readDailyLog(this.getYesterdayString());
    }

    /**
     * Append a line to today's daily log.
     * Creates the memory/ directory and file if needed.
     */
    static async appendToDailyLog(line: string): Promise<void> {
        const root = this.getWorkspaceRoot();
        if (!root) { return; }

        const dateStr = this.getTodayString();
        const dirUri = vscode.Uri.joinPath(root, 'memory');
        const logUri = vscode.Uri.joinPath(dirUri, `${dateStr}.md`);

        // Ensure directory exists
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            // may already exist
        }

        const existing = await this.readDailyLog(dateStr);
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

        const updated = existing
            ? `${existing.trimEnd()}\n- [${timestamp}] ${line}\n`
            : `# Daily Log — ${dateStr}\n\n- [${timestamp}] ${line}\n`;

        await vscode.workspace.fs.writeFile(logUri, Buffer.from(updated, 'utf-8'));
    }

    // ── Auto-Sync from Memory Engine ──────────────────────────────

    /**
     * Sync extracted facts from the memory engine to MEMORY.md.
     * - If a fact with the same topic already exists, it REPLACES the old line.
     * - Otherwise, it appends under the appropriate section header.
     * - Exact duplicates are skipped.
     */
    static async syncFactsToMemoryMd(facts: { type: string; content: string; importance: number }[]): Promise<number> {
        if (facts.length === 0) { return 0; }

        let content = await this.readMemoryMd();
        if (!content.trim()) {
            await this.ensureMemoryMd();
            content = await this.readMemoryMd();
        }

        let changedCount = 0;

        for (const fact of facts) {
            const section = this.factTypeToSection(fact.type);
            const newLine = `- ${fact.content}`;

            // Check for exact duplicate
            if (content.includes(newLine)) {
                continue;
            }

            // Extract the topic/subject key from the fact for conflict detection
            const factKey = this.extractFactKey(fact.content);

            // Find the section boundaries
            const sectionHeader = `## ${section}`;
            const sectionIdx = content.indexOf(sectionHeader);

            if (sectionIdx !== -1) {
                const afterHeader = sectionIdx + sectionHeader.length;
                const nextSectionIdx = content.indexOf('\n## ', afterHeader);
                const sectionEnd = nextSectionIdx !== -1 ? nextSectionIdx : content.length;
                const sectionContent = content.substring(afterHeader, sectionEnd);

                // Check if there's a conflicting line (same topic key)
                const conflictingLine = factKey ? this.findConflictingLine(sectionContent, factKey) : null;

                if (conflictingLine) {
                    // Replace the conflicting line with the new fact
                    content = content.replace(conflictingLine, newLine);
                    changedCount++;
                } else {
                    // Append at end of section
                    const insertion = `\n${newLine}`;
                    content = content.substring(0, sectionEnd) + insertion + content.substring(sectionEnd);
                    changedCount++;
                }
            } else {
                // Section doesn't exist — create it
                content = content.trimEnd() + `\n\n${sectionHeader}\n${newLine}\n`;
                changedCount++;
            }
        }

        if (changedCount > 0) {
            await this.writeMemoryMd(content);
        }

        return changedCount;
    }

    /**
     * Extract a topic "key" from a fact for conflict detection.
     * E.g., "User's name is Dhanush" → "user's name"
     *       "Prefers Python for backend" → "prefers * for backend"
     *       "Uses tabs for indentation" → "uses * for indentation"
     *       "Timezone: Asia/Kolkata" → "timezone"
     */
    private static extractFactKey(content: string): string | null {
        const lower = content.toLowerCase().trim();

        // Pattern: "X is Y" → key is X
        const isMatch = lower.match(/^(.+?)\s+(?:is|are|was|were)\s+/);
        if (isMatch) {
            return isMatch[1].replace(/[^a-z0-9\s']/g, '').trim();
        }

        // Pattern: "X: Y" → key is X
        const colonMatch = lower.match(/^(.+?):\s*/);
        if (colonMatch) {
            return colonMatch[1].replace(/[^a-z0-9\s']/g, '').trim();
        }

        // Pattern: "Prefers/Uses X for Y" → key is "* for Y"
        const forMatch = lower.match(/^(?:prefers?|uses?|chose?|picked)\s+.+?\s+(for\s+.+)/);
        if (forMatch) {
            return forMatch[1].replace(/[^a-z0-9\s]/g, '').trim();
        }

        // Pattern: "Primary X" → key is "primary X" 
        const primaryMatch = lower.match(/^(primary|default|main|preferred)\s+(\w+)/);
        if (primaryMatch) {
            return `${primaryMatch[1]} ${primaryMatch[2]}`;
        }

        // If the fact is short enough, use the whole thing as key
        if (lower.length < 30) {
            return lower.replace(/[^a-z0-9\s']/g, '').trim();
        }

        return null;
    }

    /**
     * Find a line in a section that conflicts with the given topic key.
     * Returns the full line (including "- " prefix) or null.
     */
    private static findConflictingLine(sectionContent: string, factKey: string): string | null {
        const lines = sectionContent.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('- ')) { continue; }

            const lineContent = trimmed.substring(2); // Remove "- " prefix
            const lineKey = this.extractFactKey(lineContent);

            if (lineKey && lineKey === factKey) {
                return trimmed;
            }
        }

        return null;
    }

    /**
     * Map fact types to MEMORY.md section headers.
     */
    private static factTypeToSection(type: string): string {
        switch (type) {
            case 'preference': return 'User Preferences';
            case 'convention': return 'Coding Conventions';
            case 'decision': return 'Decisions';
            case 'fact': return 'Project Context';
            case 'code_context': return 'Project Context';
            case 'pattern': return 'Coding Conventions';
            default: return 'Notes';
        }
    }

    // ── Combined Injection ────────────────────────────────────────

    /**
     * Build the full workspace memory context for prompt injection.
     * Returns MEMORY.md + today's log + yesterday's log (like OpenClaw).
     */
    static async buildMemoryContext(): Promise<string> {
        const parts: string[] = [];

        const memoryMd = await this.readMemoryMd();
        if (memoryMd.trim()) {
            parts.push(`<workspace_memory file="MEMORY.md">\n${memoryMd.trim()}\n</workspace_memory>`);
        }

        const todayLog = await this.readTodayLog();
        if (todayLog.trim()) {
            const dateStr = this.getTodayString();
            parts.push(`<daily_log file="memory/${dateStr}.md">\n${todayLog.trim()}\n</daily_log>`);
        }

        const yesterdayLog = await this.readYesterdayLog();
        if (yesterdayLog.trim()) {
            const dateStr = this.getYesterdayString();
            parts.push(`<daily_log file="memory/${dateStr}.md" day="yesterday">\n${yesterdayLog.trim()}\n</daily_log>`);
        }

        return parts.join('\n\n');
    }
}