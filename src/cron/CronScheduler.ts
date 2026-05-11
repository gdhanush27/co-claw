import * as vscode from 'vscode';
import { CronJobDefinition, CronJobResult } from './CronJob';
import { ModelManager } from '../lm/ModelManager';
import { WorkspaceMemory } from '../memory/WorkspaceMemory';
import { Logger } from '../util/Logger';

/**
 * Cron scheduler for CoClaw /open mode.
 *
 * Supports:
 * - Recurring jobs via 5-field cron expressions (min hour dom mon dow)
 * - One-shot jobs via relative time ("in 20m") or absolute time
 * - Persistence to VS Code global storage (survives restarts)
 * - Isolated sessions per job (fresh LLM call, no history bleed)
 * - Delivery via callback (Telegram)
 */
export class CronScheduler {
    private jobs: CronJobDefinition[] = [];
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private checkInterval: ReturnType<typeof setInterval> | undefined;
    private activeExecutions: Set<string> = new Set();
    private lastTriggeredMinute: Map<string, string> = new Map();
    private running = false;

    /** Callback to deliver job results (e.g. send to Telegram). */
    private onResult: ((result: CronJobResult) => Promise<void>) | undefined;

    /** Optional VS Code stream for status messages. */
    private vscodeStream: vscode.ChatResponseStream | undefined;

    constructor(
        private readonly modelManager: ModelManager,
        private readonly storageUri: vscode.Uri,
    ) {}

    // ── Lifecycle ─────────────────────────────────────────────────

    async start(): Promise<void> {
        if (this.running) { return; }
        this.running = true;

        // Load persisted jobs
        await this.loadJobs();

        // Schedule all enabled jobs
        for (const job of this.jobs) {
            if (job.enabled) {
                this.scheduleJob(job);
            }
        }

        // Check recurring cron jobs every 30 seconds
        this.checkInterval = setInterval(() => {
            if (this.running) { this.checkCronJobs(); }
        }, 30_000);
    }

    stop(): void {
        this.running = false;
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = undefined;
        }
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers = new Map();
    }

    setResultCallback(cb: (result: CronJobResult) => Promise<void>): void {
        this.onResult = cb;
    }

    setStream(stream: vscode.ChatResponseStream | undefined): void {
        this.vscodeStream = stream;
    }

    // ── Job CRUD ──────────────────────────────────────────────────

    /**
     * Add a new cron job.
     * @param name Human-readable name
     * @param schedule Cron expression ("0 7 * * *") or relative time ("20m", "1h", "2h30m")
     * @param prompt The LLM prompt to execute
     * @returns The created job
     */
    async addJob(name: string, schedule: string, prompt: string): Promise<CronJobDefinition> {
        const id = this.generateId();
        const isRelative = this.isRelativeTime(schedule);
        const isCron = !isRelative;

        const job: CronJobDefinition = {
            id,
            name,
            cron: isCron ? schedule : null,
            fireAt: isRelative ? this.resolveRelativeTime(schedule).toISOString() : null,
            prompt,
            enabled: true,
            autoDelete: isRelative, // One-shot jobs auto-delete by default
            createdAt: new Date().toISOString(),
            lastRunAt: null,
            runCount: 0,
        };

        this.jobs.push(job);
        await this.saveJobs();

        if (this.running) {
            this.scheduleJob(job);
        }

        return job;
    }

    async deleteJob(jobId: string): Promise<boolean> {
        const idx = this.jobs.findIndex(j => j.id === jobId);
        if (idx === -1) { return false; }

        // Clear timer
        const timer = this.timers.get(jobId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(jobId);
        }

        this.lastTriggeredMinute.delete(jobId);

        this.jobs.splice(idx, 1);
        await this.saveJobs();
        return true;
    }

    async toggleJob(jobId: string, enabled: boolean): Promise<boolean> {
        const job = this.jobs.find(j => j.id === jobId);
        if (!job) { return false; }

        job.enabled = enabled;
        await this.saveJobs();

        if (enabled && this.running) {
            this.lastTriggeredMinute.delete(jobId);
            this.scheduleJob(job);
        } else {
            const timer = this.timers.get(jobId);
            if (timer) {
                clearTimeout(timer);
                this.timers.delete(jobId);
            }
            this.lastTriggeredMinute.delete(jobId);
        }

        return true;
    }

    getJobs(): CronJobDefinition[] {
        return [...this.jobs];
    }

    getJob(jobId: string): CronJobDefinition | undefined {
        return this.jobs.find(j => j.id === jobId);
    }

    async clearAllJobs(): Promise<number> {
        const count = this.jobs.length;

        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.jobs = [];
        this.timers.clear();
        this.activeExecutions.clear();
        this.lastTriggeredMinute.clear();
        await this.saveJobs();

        return count;
    }

    /**
     * Find a job by name (case-insensitive partial match).
     */
    findJobByName(name: string): CronJobDefinition | undefined {
        const lower = name.toLowerCase();
        return this.jobs.find(j => j.name.toLowerCase() === lower)
            ?? this.jobs.find(j => j.name.toLowerCase().includes(lower));
    }

    /**
     * Find all jobs matching a name. Exact case-insensitive matches win over partial matches.
     */
    findJobsByName(name: string): CronJobDefinition[] {
        const lower = name.toLowerCase();
        const exactMatches = this.jobs.filter(j => j.name.toLowerCase() === lower);
        if (exactMatches.length > 0) {
            return exactMatches;
        }

        return this.jobs.filter(j => j.name.toLowerCase().includes(lower));
    }

    // ── Scheduling ────────────────────────────────────────────────

    private scheduleJob(job: CronJobDefinition): void {
        if (!job.enabled) { return; }

        // One-shot job (fireAt)
        if (job.fireAt) {
            const fireTime = new Date(job.fireAt).getTime();
            const delay = fireTime - Date.now();
            if (delay <= 0) {
                // Already past — fire immediately
                this.executeJob(job);
                return;
            }
            // Cap at max setTimeout value (~24.8 days)
            const safeDelay = Math.min(delay, 2_147_483_647);
            const timer = setTimeout(() => {
                this.timers.delete(job.id);
                this.executeJob(job);
            }, safeDelay);
            this.timers.set(job.id, timer);
            return;
        }

        // Recurring cron jobs are handled by checkCronJobs()
        // No individual timer needed — the interval checker handles them
    }

    /**
     * Check all recurring cron jobs and fire any that match the current minute.
     */
    private checkCronJobs(): void {
        const now = new Date();
        const minuteKey = this.getMinuteKey(now);
        for (const job of this.jobs) {
            if (!job.enabled || !job.cron || this.activeExecutions.has(job.id)) { continue; }

            if (this.cronMatchesNow(job.cron, now)) {
                if (this.lastTriggeredMinute.get(job.id) === minuteKey) {
                    continue;
                }

                // Don't fire if already fired this minute
                if (job.lastRunAt) {
                    const lastRun = new Date(job.lastRunAt);
                    if (lastRun.getFullYear() === now.getFullYear() &&
                        lastRun.getMonth() === now.getMonth() &&
                        lastRun.getDate() === now.getDate() &&
                        lastRun.getHours() === now.getHours() &&
                        lastRun.getMinutes() === now.getMinutes()) {
                        continue; // Already fired this minute
                    }
                }

                this.lastTriggeredMinute.set(job.id, minuteKey);
                this.executeJob(job);
            }
        }
    }

    // ── Execution ─────────────────────────────────────────────────

    private async executeJob(job: CronJobDefinition): Promise<void> {
        if (this.activeExecutions.has(job.id) || !this.isJobActive(job.id)) {
            return;
        }

        this.activeExecutions.add(job.id);
        const startTime = Date.now();

        try {
            const model = await this.modelManager.getActiveModel();

            const systemPrompt = `<cron_job>
You are CoClaw running a scheduled cron job. Execute the task below and respond with a brief result summary.
Job: "${job.name}"
Keep your response SHORT and actionable — this is delivered as a notification.
You can ONLY access files within the current workspace folder.
</cron_job>`;

            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                vscode.LanguageModelChatMessage.User(job.prompt),
            ];

            const tokenSource = new vscode.CancellationTokenSource();
            let responseText = '';
            try {
                const response = await model.sendRequest(messages, {}, tokenSource.token);
                for await (const chunk of response.text) {
                    responseText += chunk;
                }
            } finally {
                tokenSource.dispose();
            }

            const trackedJob = this.getTrackedJob(job.id);
            if (!trackedJob?.enabled) {
                return;
            }

            const durationMs = Date.now() - startTime;
            const result: CronJobResult = {
                jobId: job.id,
                jobName: trackedJob.name,
                prompt: trackedJob.prompt,
                response: responseText.trim(),
                executedAt: new Date().toISOString(),
                durationMs,
            };

            // Update job state
            trackedJob.lastRunAt = result.executedAt;
            trackedJob.runCount++;
            await this.saveJobs();

            // Deliver result
            if (this.onResult) {
                await this.onResult(result);
            }

            // Show in VS Code
            this.vscodeStream?.markdown(
                `\n⏰ **Cron: ${trackedJob.name}**\n${responseText.trim()}\n\n---\n\n`
            );

            // Log to daily log
            await WorkspaceMemory.appendToDailyLog(
                `⏰ Cron "${trackedJob.name}": ${responseText.trim().substring(0, 150)}`
            ).catch(() => {});

            // Auto-delete one-shot jobs
            if (trackedJob.autoDelete && trackedJob.fireAt) {
                await this.deleteJob(trackedJob.id);
            }

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            Logger.error('CoClaw Cron', `Job "${job.name}" failed`, err);

            // Still deliver an error notification
            if (this.onResult && this.isJobActive(job.id)) {
                await this.onResult({
                    jobId: job.id,
                    jobName: job.name,
                    prompt: job.prompt,
                    response: `❌ Job failed: ${msg}`,
                    executedAt: new Date().toISOString(),
                    durationMs: Date.now() - startTime,
                });
            }
        } finally {
            this.activeExecutions.delete(job.id);
        }
    }

    // ── Cron Expression Parser ────────────────────────────────────

    /**
     * Check if a 5-field cron expression matches the given time.
     * Fields: minute hour day-of-month month day-of-week
     * Supports: *, specific values, comma-separated, ranges (a-b), step ranges (a-b/n),
     *           steps (star/n), named day-of-week (SUN..SAT), and DOW=7 as Sunday.
     */
    private cronMatchesNow(cronExpr: string, now: Date): boolean {
        const fields = cronExpr.trim().split(/\s+/);
        if (fields.length < 5) { return false; }

        const [minF, hourF, domF, monF, dowF] = fields;

        return this.fieldMatches(minF, now.getMinutes()) &&
               this.fieldMatches(hourF, now.getHours()) &&
               this.fieldMatches(domF, now.getDate()) &&
               this.fieldMatches(monF, now.getMonth() + 1) && // cron months are 1-12
               this.fieldMatches(this.normalizeDow(dowF), now.getDay()); // 0=Sunday
    }

    private static readonly DOW_NAMES: Record<string, number> = {
        SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
    };

    /**
     * Normalize a day-of-week field. Accepts named tokens (SUN..SAT in any
     * case) and DOW=7 which the standard treats as Sunday in addition to 0.
     * Returns a numeric form fieldMatches() can consume against now.getDay().
     */
    private normalizeDow(field: string): string {
        const replaced = field.replace(/[A-Za-z]{3}/g, m => {
            const n = CronScheduler.DOW_NAMES[m.toUpperCase()];
            return n === undefined ? m : String(n);
        });
        // Map standalone 7s (with delimiters as boundaries) to 0 for Sunday.
        return replaced.replace(/(^|[^0-9])7(?![0-9])/g, '$10');
    }

    fieldMatches(field: string, value: number): boolean {
        if (field === '*') { return true; }

        // Handle comma-separated values, ranges, and step ranges
        const parts = field.split(',');
        for (const part of parts) {
            // Step expressions: <range>/<step>, where <range> is "*", "a", or "a-b"
            const stepIdx = part.indexOf('/');
            if (stepIdx !== -1) {
                const rangeStr = part.substring(0, stepIdx);
                const step = parseInt(part.substring(stepIdx + 1), 10);
                if (isNaN(step) || step <= 0) { continue; }
                let start: number;
                let end: number;
                if (rangeStr === '*' || rangeStr === '') {
                    start = 0;
                    end = Number.POSITIVE_INFINITY;
                } else if (rangeStr.includes('-')) {
                    const [s, e] = rangeStr.split('-').map(x => parseInt(x, 10));
                    if (isNaN(s) || isNaN(e)) { continue; }
                    start = s;
                    end = e;
                } else {
                    const s = parseInt(rangeStr, 10);
                    if (isNaN(s)) { continue; }
                    start = s;
                    end = Number.POSITIVE_INFINITY;
                }
                if (value >= start && value <= end && (value - start) % step === 0) {
                    return true;
                }
                continue;
            }

            if (part.includes('-')) {
                const [startStr, endStr] = part.split('-');
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);
                if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) {
                    return true;
                }
            } else {
                const num = parseInt(part, 10);
                if (!isNaN(num) && num === value) {
                    return true;
                }
            }
        }

        return false;
    }

    // ── Relative Time Parser ──────────────────────────────────────

    /**
     * Check if a schedule string is a relative time (e.g. "20m", "1h", "2h30m").
     */
    private isRelativeTime(schedule: string): boolean {
        return /^\d+[mhd]/.test(schedule.trim()) || schedule.trim().startsWith('in ');
    }

    /**
     * Parse a relative time string and return the target Date.
     * Supports: "20m", "1h", "2h30m", "1d", "in 20m"
     */
    private resolveRelativeTime(schedule: string): Date {
        let str = schedule.trim().toLowerCase();
        if (str.startsWith('in ')) { str = str.substring(3).trim(); }

        let totalMs = 0;
        const dayMatch = str.match(/(\d+)\s*d/);
        const hourMatch = str.match(/(\d+)\s*h/);
        const minMatch = str.match(/(\d+)\s*m/);

        if (dayMatch) { totalMs += parseInt(dayMatch[1], 10) * 86_400_000; }
        if (hourMatch) { totalMs += parseInt(hourMatch[1], 10) * 3_600_000; }
        if (minMatch) { totalMs += parseInt(minMatch[1], 10) * 60_000; }

        // If only a plain number, assume minutes
        if (totalMs === 0) {
            const plain = parseInt(str, 10);
            if (!isNaN(plain)) { totalMs = plain * 60_000; }
        }

        if (totalMs === 0) { totalMs = 60_000; } // fallback: 1 minute

        return new Date(Date.now() + totalMs);
    }

    // ── Persistence ───────────────────────────────────────────────

    private get storageFile(): vscode.Uri {
        return vscode.Uri.joinPath(this.storageUri, 'cron', 'jobs.json');
    }

    private async loadJobs(): Promise<void> {
        try {
            const data = await vscode.workspace.fs.readFile(this.storageFile);
            const parsed = JSON.parse(Buffer.from(data).toString('utf-8'));
            if (Array.isArray(parsed)) {
                this.jobs = parsed;
            }
        } catch {
            this.jobs = [];
        }
    }

    private async saveJobs(): Promise<void> {
        // Ensure directory exists
        const dir = vscode.Uri.joinPath(this.storageUri, 'cron');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch { /* exists */ }

        await vscode.workspace.fs.writeFile(
            this.storageFile,
            Buffer.from(JSON.stringify(this.jobs, null, 2), 'utf-8'),
        );
    }

    // ── Utility ───────────────────────────────────────────────────

    private generateId(): string {
        return `cron_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    }

    private getTrackedJob(jobId: string): CronJobDefinition | undefined {
        return this.jobs.find(job => job.id === jobId);
    }

    private isJobActive(jobId: string): boolean {
        return this.jobs.some(job => job.id === jobId && job.enabled);
    }

    private getMinuteKey(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hour}:${minute}`;
    }

    /**
     * Format a job for display.
     */
    static formatJob(job: CronJobDefinition): string {
        const schedule = job.cron ?? (job.fireAt ? `at ${new Date(job.fireAt).toLocaleString()}` : 'unknown');
        const status = job.enabled ? '✅' : '⏸️';
        const runs = job.runCount > 0 ? ` (ran ${job.runCount}×)` : '';
        return `${status} **${job.name}** — \`${schedule}\`${runs}\n   id: ${job.id}\n   → ${job.prompt.substring(0, 80)}`;
    }
}