import * as assert from 'assert';
import { formatTelegramHtml, splitTelegramHtml } from '../telegram/TelegramFormatting';

describe('TelegramFormatting', () => {
    describe('formatTelegramHtml()', () => {
        it('formats bold, italic, inline code, and lists', () => {
            const input = [
                '# Release Notes',
                '',
                '*CoClaw Telegram Commands*',
                '- use `npm test`',
                '1. **Ship it**',
            ].join('\n');

            const result = formatTelegramHtml(input);

            assert.ok(result.includes('<b>Release Notes</b>'));
            assert.ok(result.includes('<i>CoClaw Telegram Commands</i>'));
            assert.ok(result.includes('• use <code>npm test</code>'));
            assert.ok(result.includes('1. <b>Ship it</b>'));
        });

        it('escapes html and preserves links', () => {
            const input = 'Open <config> and visit [docs](https://example.com/docs?a=1&b=2)';
            const result = formatTelegramHtml(input);

            assert.ok(result.includes('Open &lt;config&gt;'));
            assert.ok(result.includes('<a href="https://example.com/docs?a=1&amp;b=2">docs</a>'));
        });

        it('renders fenced code blocks as preformatted text', () => {
            const input = '```ts\nconst value = 1 < 2;\n```';
            const result = formatTelegramHtml(input);

            assert.strictEqual(result, '<pre>const value = 1 &lt; 2;</pre>');
        });
    });

    describe('splitTelegramHtml()', () => {
        it('splits long formatted messages without leaving dangling tags', () => {
            const repeated = Array.from({ length: 18 }, (_, index) => `**item ${index}**`).join(' ');
            const html = formatTelegramHtml(repeated);
            const chunks = splitTelegramHtml(html, 120);

            assert.ok(chunks.length > 1);
            for (const chunk of chunks) {
                assert.ok(chunk.length <= 120);
                assert.strictEqual((chunk.match(/<b>/g) ?? []).length, (chunk.match(/<\/b>/g) ?? []).length);
            }
        });

        it('keeps code blocks readable across splits', () => {
            const code = '```\n' + 'line\n'.repeat(80) + '```';
            const html = formatTelegramHtml(code);
            const chunks = splitTelegramHtml(html, 140);

            assert.ok(chunks.length > 1);
            for (const chunk of chunks) {
                assert.strictEqual((chunk.match(/<pre>/g) ?? []).length, (chunk.match(/<\/pre>/g) ?? []).length);
            }
        });
    });
});