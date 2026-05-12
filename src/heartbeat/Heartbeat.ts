import * as vscode from 'vscode';
import { ModelManager } from '../lm/ModelManager';
import { PromptBuilder } from '../lm/PromptBuilder';
import { MemoryEngine } from '../memory/MemoryEngine';
import { WorkspaceMemory } from '../memory/WorkspaceMemory';
import { Logger } from '../util/Logger';

const HEARTBEAT_OK = 'HEARTBEAT_OK';

/**
 * Parse an "HH:MM" clock string with strict integer validation and a
 * defaulting strategy that preserves explicit `0` values.
 *
 * The previous implementation used `Number(x) || default`, which silently
 * treats a legitimate `0` (e.g. midnight) as missing and substitutes the
 * default. This helper distinguishes "actually missing / non-numeric" from
 * "zero", and additionally clamps to the valid 24h/60m ranges so a typo
 * like `25:00` doesn't blow up downstream arithmetic.
 *
 * Exported for direct unit testing.
 */
export function parseClock(
    raw: string | undefined,
    defaultH: number,
    defaultM: number,
): [number, number] {
    if (typeof raw !== 'string' || raw.trim() === '') {
        // Empty / missing input: use BOTH defaults. We can't apply the
        // "missing minute defaults to 0" rule here because the user
        // didn't supply an hour either, so the entire field is missing.
        return [clampH(defaultH), clampM(defaultM)];
    }
    const parts = raw.split(':');
    // CAREFUL: `Number('')` is `0`, not `NaN`, so an empty component
    // would silently become midnight rather than falling back to the
    // default. Treat empty / whitespace-only components as missing.
    const hStr = (parts[0] ?? '').trim();
    const mStr = (parts[1] ?? '').trim();
    const hRaw = hStr === '' ? NaN : Number(hStr);
    // When the hour is supplied but the minute isn't, default to 0 —
    // matches the natural "08" === "08:00" reading. When the supplied
    // minute is unparseable (NaN), fall through to `defaultM`.
    const mRaw = mStr === '' ? 0 : Number(mStr);
    const h = Number.isFinite(hRaw) ? hRaw : defaultH;
    const m = Number.isFinite(mRaw) ? mRaw : defaultM;
    return [clampH(h), clampM(m)];
}

function clampH(h: number): number {
    return Math.max(0, Math.min(23, Math.floor(h)));
}

function clampM(m: number): number {
    return Math.max(0, Math.min(59, Math.floor(m)));
}

const DEFAULT_HEARTBEAT_MD = `# Heartbeat Checklist

<!-- CoClaw checks this file periodically when /open is active. -->
<!-- Write plain English instructions for what should be monitored. -->
<!-- If nothing needs attention, the agent responds HEARTBEAT_OK silently. -->

- Check if any files in the workspace have obvious issues (broken imports, syntax errors)
- If I left a TODO or FIXME in recent edits, remind me
- If any background tasks finished or failed, summarize briefly
- Do NOT send updates about things that haven't changed
- Keep proactive messages short and actionable
`;

/**
 * Heartbeat system — periodic autonomous agent turns.
 *
 * Reads HEARTBEAT.md from the workspace root, runs an LLM turn at a
 * configurable interval, and delivers findings via a callback (Telegram).
 * If nothing needs attention, the agent responds HEARTBEAT_OK and the
 * message is silently dropped.
 */
export class Heartbeat {
    private timer: ReturnType<typeof setInterval> | undefined;
    private initialTimer: ReturnType<typeof setTimeout> | undefined;
    private running = false;
    private lastHeartbeatTime = 0;
    /**
     * Re-entrancy guard. `setInterval` fires regardless of whether the
     * previous tick is still in flight; without this flag a slow model call
     * + tight `intervalMinutes` setting stacks N concurrent LLM requests.
     * The guard is checked at tick-entry and released in `finally`.
     */
    private tickInFlight = false;

    /** Callback to deliver heartbeat findings to the user (e.g. via Telegram). */
    private onFinding: ((message: string) => Promise<void>) | undefined;

    /** Optional VS Code stream for showing heartbeat activity. */
    private vscodeStream: vscode.ChatResponseStream | undefined;

    constructor(
        private readonly modelManager: ModelManager,
        private readonly promptBuilder: PromptBuilder,
        private readonly memoryEngine: MemoryEngine,
    ) {}

    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Set the callback for delivering heartbeat findings.
     */
    setFindingCallback(cb: (message: string) => Promise<void>): void {
        this.onFinding = cb;
    }

    /**
     * Set the VS Code chat stream for showing heartbeat activity inline.
     */
    setStream(stream: vscode.ChatResponseStream | undefined): void {
        this.vscodeStream = stream;
    }

    /**
     * Start the heartbeat timer.
     */
    start(): void {
        if (this.running) { return; }

        const config = vscode.workspace.getConfiguration('CoClaw.heartbeat');
        const enabled = config.get<boolean>('enabled', true);
        if (!enabled) { return; }

        const intervalMinutes = config.get<number>('intervalMinutes', 30);
        const intervalMs = intervalMinutes * 60 * 1000;

        this.running = true;

        // Run first heartbeat after a short delay (give the system time to settle).
        // Track the handle so stop() can cancel a pending first tick — otherwise
        // a quick start/stop sequence still fires a stray heartbeat 30s later.
        this.initialTimer = setTimeout(() => {
            this.initialTimer = undefined;
            if (this.running) { this.tick(); }
        }, 30_000); // 30 seconds initial delay

        this.timer = setInterval(() => {
            if (this.running) { this.tick(); }
        }, intervalMs);
    }

    /**
     * Stop the heartbeat timer.
     */
    stop(): void {
        this.running = false;
        if (this.initialTimer) {
            clearTimeout(this.initialTimer);
            this.initialTimer = undefined;
        }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * Force a heartbeat check right now.
     */
    async forceCheck(): Promise<string> {
        return this.runHeartbeat();
    }

    /**
     * Single heartbeat tick — checks active hours then runs.
     *
     * Re-entrancy guard: if a previous tick is still running (e.g. a slow
     * model call), drop this tick rather than stacking concurrent LLM
     * requests. Slow ticks would otherwise pile up indefinitely, exhaust
     * the model quota and produce out-of-order findings.
     */
    private async tick(): Promise<void> {
        if (this.tickInFlight) {
            Logger.warn('CoClaw Heartbeat', 'Tick skipped: previous heartbeat still in flight');
            return;
        }
        if (!this.isWithinActiveHours()) {
            return;
        }

        this.tickInFlight = true;
        try {
            const result = await this.runHeartbeat();
            // Log to workspace daily log
            if (result === HEARTBEAT_OK) {
                await WorkspaceMemory.appendToDailyLog('Heartbeat: OK (nothing to report)');
            } else {
                await WorkspaceMemory.appendToDailyLog(`Heartbeat finding: ${result.substring(0, 200)}`);
            }
        } catch (err) {
            Logger.error('CoClaw Heartbeat', 'Tick failed', err);
        } finally {
            this.tickInFlight = false;
        }
    }

    /**
     * Run a single heartbeat LLM turn.
     * Returns the agent's response, or HEARTBEAT_OK if nothing needs attention.
     */
    private async runHeartbeat(): Promise<string> {
        this.lastHeartbeatTime = Date.now();

        // Read HEARTBEAT.md from workspace
        const heartbeatMd = await this.readHeartbeatMd();
        if (!heartbeatMd.trim()) {
            return HEARTBEAT_OK;
        }

        // Read workspace memory context
        const memoryContext = await WorkspaceMemory.buildMemoryContext();

        // Build the heartbeat prompt
        const prompt = this.buildHeartbeatPrompt(heartbeatMd, memoryContext);

        try {
            const model = await this.modelManager.getActiveModel();

            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(prompt),
            ];

            const tokenSource = new vscode.CancellationTokenSource();
            try {
                const response = await model.sendRequest(messages, {}, tokenSource.token);

                let text = '';
                for await (const chunk of response.text) {
                    text += chunk;
                }

                const trimmed = text.trim();

                // Check if the agent says nothing needs attention
                if (this.isHeartbeatOk(trimmed)) {
                    this.vscodeStream?.markdown('💓 *Heartbeat: OK*\n\n');
                    return HEARTBEAT_OK;
                }

                // There's a finding — deliver it
                this.vscodeStream?.markdown(`\n💓 **Heartbeat Finding:**\n${trimmed}\n\n---\n\n`);

                if (this.onFinding) {
                    await this.onFinding(`💓 Heartbeat:\n\n${trimmed}`);
                }

                return trimmed;
            } finally {
                tokenSource.dispose();
            }
        } catch (err) {
            Logger.error('CoClaw Heartbeat', 'LLM error', err);
            return HEARTBEAT_OK; // Don't spam the user with errors
        }
    }

    /**
     * Check if the response indicates nothing needs attention.
     */
    private isHeartbeatOk(response: string): boolean {
        const lower = response.toLowerCase().replace(/[^a-z0-9_]/g, '');
        return lower.includes('heartbeatok') ||
               lower.includes('heartbeat_ok') ||
               lower === 'ok' ||
               lower === 'nothingtonote' ||
               lower === 'nothingtoreport' ||
               lower === 'allclear' ||
               (response.length < 30 && lower.includes('nothing'));
    }

    /**
     * Build the system prompt for a heartbeat check.
     */
    private buildHeartbeatPrompt(heartbeatMd: string, memoryContext: string): string {
        const parts: string[] = [];

        parts.push(`<heartbeat_system>
You are CoClaw running a periodic HEARTBEAT check. Your job is to review the checklist below and determine if anything needs the user's attention.

RULES:
- If NOTHING needs attention, respond with exactly: HEARTBEAT_OK
- If something IS noteworthy, respond with a brief, actionable message (2-3 sentences max)
- Do NOT repeat information the user already knows
- Do NOT make up issues — only report real findings
- Be concise — this is a notification, not a conversation
- You can ONLY access files within the current workspace folder
</heartbeat_system>`);

        parts.push(`<heartbeat_checklist>
${heartbeatMd.trim()}
</heartbeat_checklist>`);

        if (memoryContext) {
            parts.push(memoryContext);
        }

        return parts.join('\n\n');
    }

    /**
     * Check if the current time is within configured active hours.
     *
     * Honors `CoClaw.heartbeat.timezone` if it parses as a valid IANA zone;
     * otherwise falls back to the host's local time. This lets a user run a
     * cloud-hosted CoClaw on UTC and still scope heartbeats to their own
     * waking hours.
     */
    private isWithinActiveHours(): boolean {
        const config = vscode.workspace.getConfiguration('CoClaw.heartbeat');
        const startStr = config.get<string>('activeHoursStart', '08:00');
        const endStr = config.get<string>('activeHoursEnd', '22:00');
        const tz = config.get<string>('timezone', '').trim();

        const now = new Date();
        let currentHour: number;
        let currentMin: number;
        if (tz) {
            try {
                const fmt = new Intl.DateTimeFormat('en-GB', {
                    timeZone: tz,
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                });
                const parts = fmt.formatToParts(now);
                currentHour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
                currentMin = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
            } catch {
                currentHour = now.getHours();
                currentMin = now.getMinutes();
            }
        } else {
            currentHour = now.getHours();
            currentMin = now.getMinutes();
        }
        const currentMinutes = currentHour * 60 + currentMin;

        // Use `Number.isFinite` rather than `||` so a legitimate "0" (e.g.
        // `00:00` = midnight) is preserved. The old code collapsed an
        // explicit `0` hour to the default 22, silently shifting end times.
        const [startH, startM] = parseClock(startStr, 8, 0);
        const [endH, endM] = parseClock(endStr, 22, 0);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        if (startMinutes <= endMinutes) {
            // Normal range: e.g. 08:00 - 22:00
            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        } else {
            // Overnight range: e.g. 22:00 - 06:00
            return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
        }
    }

    // ── HEARTBEAT.md ─────────────────────────────────────────────

    /**
     * Read HEARTBEAT.md from the workspace root.
     */
    private async readHeartbeatMd(): Promise<string> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) { return ''; }

        const uri = vscode.Uri.joinPath(root, 'HEARTBEAT.md');
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(data).toString('utf-8');
        } catch {
            return '';
        }
    }

    /**
     * Ensure HEARTBEAT.md exists in the workspace root.
     * Creates a default template if missing.
     */
    static async ensureHeartbeatMd(): Promise<void> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) { return; }

        const uri = vscode.Uri.joinPath(root, 'HEARTBEAT.md');
        try {
            await vscode.workspace.fs.stat(uri);
            // File exists, don't overwrite
        } catch {
            // Create default
            await vscode.workspace.fs.writeFile(uri, Buffer.from(DEFAULT_HEARTBEAT_MD, 'utf-8'));
        }
    }

    /**
     * Get status info for display.
     */
    getStatus(): { running: boolean; lastCheck: number; intervalMinutes: number } {
        const config = vscode.workspace.getConfiguration('CoClaw.heartbeat');
        return {
            running: this.running,
            lastCheck: this.lastHeartbeatTime,
            intervalMinutes: config.get<number>('intervalMinutes', 30),
        };
    }
}