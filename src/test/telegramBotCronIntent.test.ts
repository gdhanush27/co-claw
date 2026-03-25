import * as assert from 'assert';
import { extractNaturalLanguageCronDeletionTarget } from '../telegram/TelegramBot';

describe('TelegramBot cron intent', () => {
    it('extracts reminder names from natural-language delete requests', () => {
        assert.strictEqual(
            extractNaturalLanguageCronDeletionTarget('Delete the drink water remainder'),
            'drink water',
        );
        assert.strictEqual(
            extractNaturalLanguageCronDeletionTarget('remove my standup reminder'),
            'standup',
        );
    });

    it('ignores non-cron delete requests', () => {
        assert.strictEqual(extractNaturalLanguageCronDeletionTarget('Delete the file app.ts'), undefined);
        assert.strictEqual(extractNaturalLanguageCronDeletionTarget('remove the branch'), undefined);
    });
});