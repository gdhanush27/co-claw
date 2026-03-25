/**
 * Cron job definition — persisted to disk.
 */
export interface CronJobDefinition {
    /** Stable unique identifier. */
    id: string;
    /** Human-readable name. */
    name: string;
    /** Cron expression (5-field: min hour dom mon dow) or null for one-shot. */
    cron: string | null;
    /** For one-shot jobs: ISO timestamp when the job should fire. */
    fireAt: string | null;
    /** The prompt to send to the LLM when the job fires. */
    prompt: string;
    /** Whether the job is currently enabled. */
    enabled: boolean;
    /** Auto-delete after successful execution (for one-shot jobs). */
    autoDelete: boolean;
    /** Creation timestamp. */
    createdAt: string;
    /** Last execution timestamp (ISO), or null if never run. */
    lastRunAt: string | null;
    /** Number of times this job has executed. */
    runCount: number;
}

/**
 * Result of a cron job execution.
 */
export interface CronJobResult {
    jobId: string;
    jobName: string;
    prompt: string;
    response: string;
    executedAt: string;
    durationMs: number;
}