import * as assert from 'assert';
import * as vscode from 'vscode';
import { CronScheduler } from '../cron/CronScheduler';

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

describe('CronScheduler', () => {
    it('returns all exact name matches before partial matches', async () => {
        const scheduler = new CronScheduler({} as any, vscode.Uri.file('cron-test'));

        await scheduler.addJob('Morning briefing', '20m', 'first');
        await scheduler.addJob('Morning briefing', '30m', 'second');
        await scheduler.addJob('Morning', '40m', 'third');

        const exactMatches = scheduler.findJobsByName('Morning briefing');
        assert.strictEqual(exactMatches.length, 2);
        assert.ok(exactMatches.every(job => job.name === 'Morning briefing'));

        const partialMatches = scheduler.findJobsByName('Morning');
        assert.strictEqual(partialMatches.length, 1);
        assert.strictEqual(partialMatches[0].name, 'Morning');
    });

    it('does not deliver a deleted job that was already in flight', async () => {
        const responseGate = deferred<void>();
        const deliveries: string[] = [];

        const scheduler = new CronScheduler({
            getActiveModel: async () => ({
                sendRequest: async () => ({
                    text: (async function* () {
                        await responseGate.promise;
                        yield 'delayed reminder';
                    })(),
                }),
            }),
        } as any, vscode.Uri.file('cron-test'));

        scheduler.setResultCallback(async (result) => {
            deliveries.push(result.response);
        });

        const job = await scheduler.addJob('Reminder', '20m', 'Ping me');
        const execution = (scheduler as any).executeJob(job);

        await scheduler.deleteJob(job.id);
        responseGate.resolve();
        await execution;

        assert.deepStrictEqual(deliveries, []);
        assert.strictEqual(scheduler.getJobs().length, 0);
    });

    it('does not schedule the same recurring job twice in one minute while in flight', () => {
        const scheduler = new CronScheduler({} as any, vscode.Uri.file('cron-test'));
        const recurringJob = {
            id: 'job-1',
            name: 'Recurring',
            cron: '* * * * *',
            fireAt: null,
            prompt: 'Check status',
            enabled: true,
            autoDelete: false,
            createdAt: new Date().toISOString(),
            lastRunAt: null,
            runCount: 0,
        };

        (scheduler as any).jobs = [recurringJob];
        (scheduler as any).running = true;

        const originalDate = Date;
        const fixedNow = new originalDate('2026-03-25T10:15:00Z');
        const executions: string[] = [];

        class MockDate extends originalDate {
            constructor(value?: string | number | Date) {
                super(value ?? fixedNow.getTime());
            }

            static now(): number {
                return fixedNow.getTime();
            }
        }

        (global as any).Date = MockDate;
        (scheduler as any).executeJob = (job: { id: string }) => {
            executions.push(job.id);
            (scheduler as any).activeExecutions.add(job.id);
        };

        try {
            (scheduler as any).checkCronJobs();
            (scheduler as any).checkCronJobs();
        } finally {
            (global as any).Date = originalDate;
        }

        assert.deepStrictEqual(executions, ['job-1']);
    });
});