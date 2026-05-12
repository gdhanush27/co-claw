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
 *
 * Hardening notes (post-review):
 *
 * - `readFile` previously swallowed ALL I/O errors as empty content. A
 *   transient permission error or filesystem hiccup therefore caused the
 *   very next `doWrite` to treat the store as fresh and overwrite the
 *   entire prior history with a one-entry file. Now we only swallow
 *   "file not found"; every other error propagates and aborts the write.
 * - Keys are validated against a strict allow-list. The previous regex
 *   parser used a backreference (`\1`) on whatever the LLM emitted as the
 *   entry name, so an agent-controlled key with newlines / sentinels
 *   could either corrupt the file or be replayed as data.
 * - Values are sanitised so they cannot embed the `<!-- end:KEY -->`
 *   terminator, the `### ` entry-start marker, or the `## Run ` section
 *   header. Without this, value content could prematurely terminate an
 *   entry or graft itself onto another run, which is a real
 *   content-injection vector once you remember that everything in the
 *   store is untrusted (model output, tool output, user prompts).
 */

/** Strict allow-list for entry keys. Matches what the agents actually use. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Zero-width space inserted to neutralise sentinel sequences in untrusted values. */
const ZWSP = '\u200B';

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
        // Validate before queueing so the caller fails fast on bad input,
        // without holding up other writers on the chain.
        if (!isValidRunId(runId)) {
            throw new Error(`SharedMemoryStore: invalid runId ${JSON.stringify(runId)}`);
        }
        if (!isValidKey(key)) {
            throw new Error(
                `SharedMemoryStore: invalid key ${JSON.stringify(key)} — must match ${KEY_PATTERN}`,
            );
        }
        const safeValue = sanitizeValue(value ?? '');
        const next = this.writeChain.then(() => this.doWrite(runId, key, safeValue, writtenBy));
        // Keep the chain alive even if a write throws — but still propagate
        // the rejection to THIS caller so the failure isn't silently lost.
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    async list(runId: string): Promise<SharedValue[]> {
        if (!isValidRunId(runId)) { return []; }
        // Route reads through the same chain so we never observe a file
        // mid-write. The penalty is small (the chain only blocks on
        // writes, not on reads), but it guarantees readers and writers
        // see a consistent view of the store.
        const content = await this.serializedRead();
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

    /**
     * Read the store after the current write chain has drained, so we
     * don't observe a half-written file.
     */
    private async serializedRead(): Promise<string> {
        const pending = this.writeChain;
        try { await pending; } catch { /* writer errors don't affect readers */ }
        return this.readFile();
    }

    /**
     * Read the backing file. Returns '' ONLY when the file doesn't exist
     * yet (the legitimate "first write" path). Any other error — EACCES,
     * EBUSY, EIO, a malformed URI, etc. — is re-thrown so the next write
     * doesn't silently clobber prior data with a fresh one-entry file.
     */
    private async readFile(): Promise<string> {
        try {
            const data = await vscode.workspace.fs.readFile(this.fileUri);
            return Buffer.from(data).toString('utf-8');
        } catch (err) {
            if (isFileNotFound(err)) { return ''; }
            throw err;
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

/** Distinguish "file not found" from every other I/O failure. */
function isFileNotFound(err: unknown): boolean {
    if (!err || typeof err !== 'object') { return false; }
    const fse = err as vscode.FileSystemError & { code?: string };
    // vscode.FileSystemError.FileNotFound has `code: 'FileNotFound'`.
    // Node-style errors use `code: 'ENOENT'`. Cover both.
    return fse.code === 'FileNotFound' || fse.code === 'ENOENT' ||
        // VS Code wraps the underlying error and exposes it as `.name`.
        (fse as { name?: string }).name === 'EntryNotFound (FileSystemError)';
}

/** Pure validators / sanitizers — exported for tests. */
export function isValidKey(key: string): boolean {
    return typeof key === 'string' && KEY_PATTERN.test(key);
}

export function isValidRunId(runId: string): boolean {
    // Run IDs are UUIDs in production but tests use short ASCII strings,
    // so accept the same alphabet as keys without an explicit length cap.
    return typeof runId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(runId);
}

/**
 * Neutralise format sentinels that, if left in the value, would let the
 * value escape its entry and be interpreted as structure. We insert a
 * zero-width space inside each sentinel so it survives a markdown viewer
 * (still visually identical) but no longer matches the parser regex.
 *
 * Three things have to be neutralised:
 *   1. `<!-- end:KEY -->`  — terminates the current entry, allowing the
 *      attacker to truncate the value or graft tail content elsewhere.
 *   2. `\n## Run X`        — starts a new run section; a value containing
 *      this can plant an entire fake run with fake entries.
 *   3. `\n### KEY`         — starts a new entry within the current run;
 *      structural-marker-anchored only at line boundaries to avoid
 *      mangling agent prose that legitimately discusses markdown.
 */
export function sanitizeValue(value: string): string {
    return value
        .split('<!-- end:').join(`<!-- end${ZWSP}:`)
        .replace(/(^|\n)## Run /g, (_m, p1) => `${p1}#${ZWSP}# Run `)
        .replace(/(^|\n)### /g, (_m, p1) => `${p1}#${ZWSP}## `);
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
    // Anchored on `\n` boundaries so a value containing a fake `### foo`
    // can never start a phantom entry. The KEY capture is constrained to
    // the same allow-list we enforce on write — anything else is treated
    // as not-an-entry and skipped. The backreference (\1) terminates the
    // value at the matching `<!-- end:<key> -->` sentinel.
    const entryRegex = /\n### ([A-Za-z0-9._:-]{1,200})\n- writtenBy: (.+?)\n- writtenAt: (.+?)\n\n([\s\S]*?)\n<!-- end:\1 -->/g;
    let m: RegExpExecArray | null;
    while ((m = entryRegex.exec(runSection)) !== null) {
        const [, key, writtenBy, iso, value] = m;
        // Defence-in-depth: re-validate the captured key. Old files
        // written before the sanitiser landed may contain corrupt entries
        // that the regex still happens to match; skip those rather than
        // surface them to dependent agents.
        if (!isValidKey(key)) { continue; }
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
