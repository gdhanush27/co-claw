import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';

/**
 * Caches tool results within a session to prevent redundant tool calls.
 * Also persists important workspace knowledge (file reads, project structure)
 * to long-term memory for future sessions.
 */
export class ToolResultCache {
    /** In-session cache: key = tool_name + JSON(input) -> result text */
    private readonly sessionCache = new Map<string, string>();
    /** Track which file paths have been cached to memory this session */
    private readonly persistedFiles = new Set<string>();

    constructor(private readonly memoryEngine: MemoryEngine) {}

    /**
     * Generate a cache key from tool name and input.
     */
    private cacheKey(toolName: string, input: object): string {
        return `${toolName}::${JSON.stringify(input)}`;
    }

    /**
     * Check if we have a cached result for this exact tool call.
     * Returns the cached text or undefined.
     */
    get(toolName: string, input: object): string | undefined {
        return this.sessionCache.get(this.cacheKey(toolName, input));
    }

    /**
     * Store a tool result in the session cache.
     */
    set(toolName: string, input: object, resultText: string): void {
        this.sessionCache.set(this.cacheKey(toolName, input), resultText);
    }

    /**
     * After a tool returns, decide whether to persist the result as workspace knowledge.
     * We persist file reads and structured search results so future sessions
     * can skip redundant exploration.
     */
    async persistIfValuable(toolName: string, input: object, resultText: string): Promise<void> {
        // Only persist file-read-like results
        const isFileRead = this.isFileReadTool(toolName);
        const isSearch = this.isSearchTool(toolName);

        if (!isFileRead && !isSearch) {
            return;
        }

        if (isFileRead) {
            const filePath = this.extractFilePath(input);
            if (!filePath || this.persistedFiles.has(filePath)) {
                return;
            }
            this.persistedFiles.add(filePath);

            // Extract a compact summary: file path + key signatures (functions, classes, routes)
            const summary = this.summarizeFileContent(filePath, resultText);
            if (summary) {
                await this.memoryEngine.writeMemory(
                    summary,
                    'code_context',
                    0.6,
                    ['workspace', 'file-structure', ...this.extractPathTags(filePath)],
                    'auto-extracted',
                    'daily',
                ).catch(() => { /* silent */ });
            }
        }

        if (isSearch) {
            // Store search results as workspace context so model knows where things are
            const searchSummary = this.summarizeSearchResult(toolName, input, resultText);
            if (searchSummary) {
                await this.memoryEngine.writeMemory(
                    searchSummary,
                    'code_context',
                    0.5,
                    ['workspace', 'search-cache'],
                    'auto-extracted',
                    'daily',
                ).catch(() => { /* silent */ });
            }
        }
    }

    private isFileReadTool(toolName: string): boolean {
        const fileReadTools = ['vscode_readFile', 'readFile', 'read_file', 'cat_file'];
        return fileReadTools.some(t => toolName.toLowerCase().includes(t.toLowerCase()))
            || toolName.toLowerCase().includes('readfile')
            || toolName.toLowerCase().includes('read_file')
            || toolName.toLowerCase().includes('getfilecontent');
    }

    private isSearchTool(toolName: string): boolean {
        const searchTools = ['file_search', 'grep_search', 'search', 'find'];
        return searchTools.some(t => toolName.toLowerCase().includes(t.toLowerCase()));
    }

    private extractFilePath(input: object): string | undefined {
        const obj = input as Record<string, unknown>;
        // Common field names for file paths in tool inputs
        for (const key of ['filePath', 'path', 'file', 'uri', 'fileName']) {
            if (typeof obj[key] === 'string') {
                const filePath = obj[key] as string;
                // Only return paths that are inside a workspace folder
                if (this.isInsideWorkspace(filePath)) {
                    return filePath;
                }
                return undefined;
            }
        }
        return undefined;
    }

    private isInsideWorkspace(fsPath: string): boolean {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return true; } // No workspace, allow all
        const path = require('path');
        const normalized = path.normalize(fsPath);
        return folders.some((wf: vscode.WorkspaceFolder) => {
            const root = path.normalize(wf.uri.fsPath);
            return normalized.startsWith(root + path.sep) || normalized === root;
        });
    }

    private extractPathTags(filePath: string): string[] {
        const parts = filePath.replace(/\\/g, '/').split('/');
        const fileName = parts[parts.length - 1];
        const ext = fileName.includes('.') ? fileName.split('.').pop()! : '';
        const tags: string[] = [fileName];
        if (ext) { tags.push(ext); }
        // Include parent folder name for context
        if (parts.length >= 2) {
            tags.push(parts[parts.length - 2]);
        }
        return tags;
    }

    /**
     * Create a compact summary of a file's contents: path + key definitions.
     * This is what gets stored in memory so future sessions know the file structure.
     */
    private summarizeFileContent(filePath: string, content: string): string | null {
        if (!content || content.length < 20) { return null; }

        const lines = content.split('\n');
        const signatures: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // Python: def, class
            if (/^(def |class |async def )/.test(trimmed)) {
                signatures.push(trimmed.split(':')[0].trim());
            }
            // JS/TS: function, class, export, const ... = () =>
            if (/^(export )?(function |class |const |let |var |interface |type )/.test(trimmed)) {
                const sig = trimmed.substring(0, Math.min(trimmed.length, 80));
                signatures.push(sig);
            }
            // Routes: @app.route, router.get, app.get
            if (/(@app\.(route|get|post|put|delete|patch)|router\.(get|post|put|delete|patch)|app\.(get|post|put|delete|patch))/.test(trimmed)) {
                signatures.push(trimmed.substring(0, Math.min(trimmed.length, 100)));
            }
            // HTML: form, key div/section IDs
            if (/^<(form|div|section|main|header)[\s>]/.test(trimmed) && trimmed.includes('id=')) {
                signatures.push(trimmed.substring(0, Math.min(trimmed.length, 80)));
            }
        }

        const uniqueSigs = [...new Set(signatures)].slice(0, 20);
        if (uniqueSigs.length === 0) {
            // Just store that the file exists with its line count
            return `File: ${filePath} (${lines.length} lines)`;
        }

        return `File: ${filePath} (${lines.length} lines) — Contains: ${uniqueSigs.join('; ')}`;
    }

    /**
     * Summarize search results into a compact memory entry.
     */
    private summarizeSearchResult(toolName: string, input: object, resultText: string): string | null {
        if (!resultText || resultText.length < 20) { return null; }

        const obj = input as Record<string, unknown>;
        const query = obj.query || obj.pattern || obj.search || '';

        // Extract just the matched file paths from the result
        const pathMatches = resultText.match(/[^\s"']+\.(py|ts|js|html|css|json|yaml|yml|md|tsx|jsx)/g);
        if (pathMatches && pathMatches.length > 0) {
            const uniquePaths = [...new Set(pathMatches)].slice(0, 10);
            return `Search "${query}" found matches in: ${uniquePaths.join(', ')}`;
        }

        return null;
    }

    /**
     * Clear the session cache (e.g. when context is flushed).
     */
    clear(): void {
        this.sessionCache.clear();
        this.persistedFiles.clear();
    }

    get size(): number {
        return this.sessionCache.size;
    }
}
