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

    describe('fieldMatches', () => {
        const scheduler = new CronScheduler({} as any, vscode.Uri.file('cron-test'));

        it('matches wildcard', () => {
            assert.strictEqual(scheduler.fieldMatches('*', 0), true);
            assert.strictEqual(scheduler.fieldMatches('*', 59), true);
        });

        it('matches exact integers and comma lists', () => {
            assert.strictEqual(scheduler.fieldMatches('5', 5), true);
            assert.strictEqual(scheduler.fieldMatches('5', 6), false);
            assert.strictEqual(scheduler.fieldMatches('5,7,9', 7), true);
            assert.strictEqual(scheduler.fieldMatches('5,7,9', 8), false);
        });

        it('matches inclusive ranges', () => {
            assert.strictEqual(scheduler.fieldMatches('1-5', 1), true);
            assert.strictEqual(scheduler.fieldMatches('1-5', 5), true);
            assert.strictEqual(scheduler.fieldMatches('1-5', 6), false);
        });

        it('matches step expressions', () => {
            // Every 2 from 0
            assert.strictEqual(scheduler.fieldMatches('*/2', 0), true);
            assert.strictEqual(scheduler.fieldMatches('*/2', 4), true);
            assert.strictEqual(scheduler.fieldMatches('*/2', 5), false);
        });

        it('matches step ranges (a-b/n)', () => {
            // Hours 9..17 every 4 → 9, 13, 17
            assert.strictEqual(scheduler.fieldMatches('9-17/4', 9), true);
            assert.strictEqual(scheduler.fieldMatches('9-17/4', 13), true);
            assert.strictEqual(scheduler.fieldMatches('9-17/4', 17), true);
            assert.strictEqual(scheduler.fieldMatches('9-17/4', 11), false);
            assert.strictEqual(scheduler.fieldMatches('9-17/4', 21), false);
        });
    });

    describe('day-of-week normalization', () => {
        // Use a thin subclass so we can call the private method via bracket access.
        const scheduler = new CronScheduler({} as any, vscode.Uri.file('cron-test')) as any;

        it('normalizes DOW=7 to 0 (Sunday)', () => {
            assert.strictEqual(scheduler.normalizeDow('7'), '0');
            assert.strictEqual(scheduler.normalizeDow('1-7'), '1-0');
            // numeric 17 (used in hours field) stays untouched when normalizeDow
            // is mistakenly applied; this protects against over-eager rewriting.
            assert.strictEqual(scheduler.normalizeDow('17'), '17');
        });

        it('translates SUN..SAT (case-insensitive)', () => {
            assert.strictEqual(scheduler.normalizeDow('SUN'), '0');
            assert.strictEqual(scheduler.normalizeDow('mon-fri'), '1-5');
            assert.strictEqual(scheduler.normalizeDow('Mon,Wed,Fri'), '1,3,5');
            assert.strictEqual(scheduler.normalizeDow('SAT'), '6');
        });

        it('cron expressions with DOW=7 fire on Sunday', () => {
            // Use local-time Date constructor so getHours/getMinutes match
            // regardless of the host's timezone offset. 2026-03-29 was Sunday.
            const sunday = new Date(2026, 2, 29, 7, 0, 0); // March is month 2
            assert.ok(scheduler.cronMatchesNow('0 7 * * 7', sunday),
                `expected '0 7 * * 7' to match Sunday 07:00 local time`);
            assert.ok(scheduler.cronMatchesNow('0 7 * * SUN', sunday),
                `expected '0 7 * * SUN' to match Sunday 07:00 local time`);
        });
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