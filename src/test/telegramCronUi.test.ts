import * as assert from 'assert';
import { CronJobDefinition } from '../cron/CronJob';
import { buildCronClearConfirmPanel, buildCronControlPanel } from '../telegram/TelegramCronUi';

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
    return {
        id: 'cron_test_1',
        name: 'Drink water',
        cron: '0 */2 * * *',
        fireAt: null,
        prompt: 'Remind me to drink water',
        enabled: true,
        autoDelete: false,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        runCount: 0,
        ...overrides,
    };
}

describe('TelegramCronUi', () => {
    it('builds a control panel with action buttons per job', () => {
        const panel = buildCronControlPanel([
            makeJob(),
            makeJob({ id: 'cron_test_2', name: 'Standup', enabled: false, cron: null, fireAt: '2026-03-26T08:00:00.000Z' }),
        ]);

        assert.ok(panel.text.includes('⏰ Cron Control Panel'));
        assert.ok(panel.text.includes('Drink water'));
        assert.ok(panel.text.includes('id: cron_test_1'));
        assert.ok(panel.text.includes('Standup'));
        assert.strictEqual(panel.buttons[0][0].callback_data, 'cron_ui:pause:cron_test_1');
        assert.strictEqual(panel.buttons[1][0].callback_data, 'cron_ui:resume:cron_test_2');
        assert.strictEqual(panel.buttons[0][1].callback_data, 'cron_ui:delete:cron_test_1');
    });

    it('builds a clear confirmation panel', () => {
        const panel = buildCronClearConfirmPanel(3);
        assert.ok(panel.text.includes('remove 3 scheduled jobs'));
        assert.strictEqual(panel.buttons[0][0].callback_data, 'cron_ui:clear_all');
        assert.strictEqual(panel.buttons[0][1].callback_data, 'cron_ui:refresh');
    });
});