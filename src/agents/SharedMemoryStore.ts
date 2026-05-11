import * as vscode from 'vscode';
import { AgentRole, SharedValue } from './types';

/**
 * Shared key/value store for multi-agent runs, persisted to a single
 * Markdown file (`agents/shared-memory.md` under the extension storage URI).
 *
 * File layout:
 *
 *     # Shared Agent Memory
 *
 *     ## Run <runId>
 *
 *     ### <key>
 *     - writtenBy: <role>
 *     - writtenAt: <iso-timestamp>
 *
 *     <value>
 *
 *     <!-- end:<key> -->
 *
 * Writes are serialised through an in-process mutex to avoid clobbering
 * concurrent agent writes.
 */
export class SharedMemoryStore {
    private readonly fileUri: vscode.Uri;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(storageUri: vscode.Uri) {
        this.fileUri = vscode.Uri.joinPath(storageUri, 'agents', 'shared-memory.md');
    }

    /** Public for diagnostics / UI. */
    getFileUri(): vscode.Uri {
        return this.fileUri;
    }

    async write(runId: string, key: string, value: string, writtenBy: AgentRole): Promise<void> {
        const next = this.writeChain.then(() => this.doWrite(runId, key, value, writtenBy));
        // Keep the chain alive even if a write throws.
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    async list(runId: string): Promise<SharedValue[]> {
        const content = await this.readFile();
        return parseRun(content, runId);
    }

    async read(runId: string, key?: string): Promise<SharedValue[]> {
        const all = await this.list(runId);
        if (!key) { return all; }
        return all.filter(v => v.key === key);
    }

    private async doWrite(runId: string, key: string, value: string, writtenBy: AgentRole): Promise<void> {
        const existing = await this.readFile();
        const updated = upsertEntry(existing, runId, key, value, writtenBy, Date.now());
        await this.ensureDir();
        await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(updated, 'utf-8'));
    }

    private async readFile(): Promise<string> {
        try {
            const data = await vscode.workspace.fs.readFile(this.fileUri);
            return Buffer.from(data).toString('utf-8');
        } catch {
            return '';
        }
    }

    private async ensureDir(): Promise<void> {
        const dir = vscode.Uri.joinPath(this.fileUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            // already exists
        }
    }
}

const HEADER = '# Shared Agent Memory\n';

function runHeading(runId: string): string {
    return `## Run ${runId}`;
}

function entryStart(key: string): string {
    return `### ${key}`;
}

function entryEnd(key: string): string {
    return `<!-- end:${key} -->`;
}

function upsertEntry(
    content: string,
    runId: string,
    key: string,
    value: string,
    writtenBy: AgentRole,
    writtenAt: number,
): string {
    let doc = content.trim().length === 0 ? HEADER + '\n' : content;
    if (!doc.startsWith('# Shared Agent Memory')) {
        doc = HEADER + '\n' + doc;
    }

    const block = renderEntry(key, value, writtenBy, writtenAt);
    const runHeader = runHeading(runId);
    const runIdx = doc.indexOf(runHeader);

    if (runIdx === -1) {
        // Append a new run section at the end.
        const trimmed = doc.replace(/\s+$/, '');
        return `${trimmed}\n\n${runHeader}\n\n${block}\n`;
    }

    // Find the slice for this run (up to next "## Run " or EOF).
    const after = doc.slice(runIdx + runHeader.length);
    const nextRunRel = after.indexOf('\n## Run ');
    const runEnd = nextRunRel === -1 ? doc.length : runIdx + runHeader.length + nextRunRel;
    const runSection = doc.slice(runIdx, runEnd);

    const startMarker = `\n${entryStart(key)}\n`;
    const endMarker = entryEnd(key);
    const startInRun = runSection.indexOf(startMarker);

    let newRunSection: string;
    if (startInRun === -1) {
        // Append entry to this run.
        const trimmed = runSection.replace(/\s+$/, '');
        newRunSection = `${trimmed}\n\n${block}\n`;
    } else {
        const endInRun = runSection.indexOf(endMarker, startInRun);
        if (endInRun === -1) {
            // Malformed: replace from the entry start to end of section.
            newRunSection = runSection.slice(0, startInRun).replace(/\s+$/, '') + `\n\n${block}\n`;
        } else {
            const replaceFrom = startInRun + 1; // keep leading newline
            const replaceTo = endInRun + endMarker.length;
            newRunSection = runSection.slice(0, replaceFrom) + block + runSection.slice(replaceTo);
        }
    }

    return doc.slice(0, runIdx) + newRunSection + doc.slice(runEnd);
}

function renderEntry(key: string, value: string, writtenBy: AgentRole, writtenAt: number): string {
    const iso = new Date(writtenAt).toISOString();
    return [
        entryStart(key),
        `- writtenBy: ${writtenBy}`,
        `- writtenAt: ${iso}`,
        '',
        value,
        '',
        entryEnd(key),
    ].join('\n');
}

function parseRun(content: string, runId: string): SharedValue[] {
    if (!content) { return []; }
    const runHeader = runHeading(runId);
    const runIdx = content.indexOf(runHeader);
    if (runIdx === -1) { return []; }
    const after = content.slice(runIdx + runHeader.length);
    const nextRunRel = after.indexOf('\n## Run ');
    const runSection = nextRunRel === -1 ? after : after.slice(0, nextRunRel);

    const out: SharedValue[] = [];
    const entryRegex = /\n### (.+?)\n- writtenBy: (.+?)\n- writtenAt: (.+?)\n\n([\s\S]*?)\n<!-- end:\1 -->/g;
    let m: RegExpExecArray | null;
    while ((m = entryRegex.exec(runSection)) !== null) {
        const [, key, writtenBy, iso, value] = m;
        const ts = Date.parse(iso);
        out.push({
            key: key.trim(),
            value: value.replace(/\s+$/, ''),
            writtenBy: writtenBy.trim() as AgentRole,
            writtenAt: Number.isNaN(ts) ? 0 : ts,
        });
    }
    return out.sort((a, b) => b.writtenAt - a.writtenAt);
}
