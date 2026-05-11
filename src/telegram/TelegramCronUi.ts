import { CronJobDefinition } from '../cron/CronJob';

export interface TelegramInlineButton {
    text: string;
    callback_data: string;
}

export type TelegramInlineKeyboard = TelegramInlineButton[][];

const MAX_VISIBLE_JOBS = 8;
const BUTTON_NAME_LIMIT = 18;

export function buildCronControlPanel(jobs: CronJobDefinition[]): { text: string; buttons: TelegramInlineKeyboard } {
    const visibleJobs = jobs.slice(0, MAX_VISIBLE_JOBS);
    const activeCount = jobs.filter((job) => job.enabled).length;

    const lines: string[] = [
        '⏰ **Cron Control Panel**',
        '',
        `**Jobs:** ${jobs.length}`,
        `**Active:** ${activeCount}`,
    ];

    if (visibleJobs.length === 0) {
        lines.push(
            '',
            '_No cron jobs scheduled._',
            '',
            'Use `/cron add <schedule> <name> | <prompt>` to create one.',
        );
    } else {
        lines.push('', '_Tap a button below to pause, resume, or delete a job._', '');

        visibleJobs.forEach((job, index) => {
            const status = job.enabled ? '✅' : '⏸️';
            const schedule = formatSchedule(job);
            lines.push(`${index + 1}. ${status} **${job.name}**`);
            lines.push(`   ${schedule}`);
            lines.push(`   id: \`${job.id}\``);
        });

        if (jobs.length > MAX_VISIBLE_JOBS) {
            lines.push(
                '',
                `_Showing first ${MAX_VISIBLE_JOBS} jobs. Use a specific job id in chat for the rest._`,
            );
        }
    }

    return {
        text: lines.join('\n'),
        buttons: buildCronControlButtons(visibleJobs, jobs.length > 0),
    };
}

export function buildCronClearConfirmPanel(jobCount: number): { text: string; buttons: TelegramInlineKeyboard } {
    const noun = jobCount === 1 ? 'job' : 'jobs';
    return {
        text: `⚠️ **Clear all cron jobs?**\n\nThis will remove ${jobCount} scheduled ${noun}.`,
        buttons: [
            [
                { text: '🗑️ Yes, clear all', callback_data: 'cron_ui:clear_all' },
                { text: '↩ Back', callback_data: 'cron_ui:refresh' },
            ],
        ],
    };
}

function buildCronControlButtons(jobs: CronJobDefinition[], hasJobs: boolean): TelegramInlineKeyboard {
    const buttons: TelegramInlineKeyboard = [];

    for (const job of jobs) {
        const actionLabel = job.enabled ? '⏸ Pause' : '▶ Resume';
        const action = job.enabled ? 'pause' : 'resume';
        buttons.push([
            {
                text: `${actionLabel} ${truncateButtonLabel(job.name)}`,
                callback_data: `cron_ui:${action}:${job.id}`,
            },
            {
                text: '🗑 Delete',
                callback_data: `cron_ui:delete:${job.id}`,
            },
        ]);
    }

    const footer: TelegramInlineButton[] = [
        { text: '🔄 Refresh', callback_data: 'cron_ui:refresh' },
        { text: '✖ Close', callback_data: 'cron_ui:close' },
    ];

    if (hasJobs) {
        footer.splice(1, 0, { text: '🧹 Clear All', callback_data: 'cron_ui:confirm_clear' });
    }

    buttons.push(footer);
    return buttons;
}

function truncateButtonLabel(name: string): string {
    if (name.length <= BUTTON_NAME_LIMIT) {
        return name;
    }

    return `${name.substring(0, BUTTON_NAME_LIMIT - 1)}…`;
}

function formatSchedule(job: CronJobDefinition): string {
    if (job.cron) {
        return `schedule: \`${job.cron}\``;
    }

    if (job.fireAt) {
        return `runs at: \`${new Date(job.fireAt).toLocaleString()}\``;
    }

    return 'schedule: _unknown_';
}