import * as assert from 'assert';
import * as vscode from 'vscode';
import { ToolRunner } from '../lm/ToolRunner';

/**
 * Verify trimContextIfNeeded never removes an odd number of messages —
 * tool-call rounds always come as assistant+result pairs and a stray
 * removal corrupts the transcript for the next model call.
 */
describe('ToolRunner.trimContextIfNeeded', () => {
    function bigText(chars: number, role: 'user' | 'assistant' = 'user'): vscode.LanguageModelChatMessage {
        const part = new vscode.LanguageModelTextPart('x'.repeat(chars));
        return role === 'user'
            ? vscode.LanguageModelChatMessage.User([part])
            : vscode.LanguageModelChatMessage.Assistant([part]);
    }

    function buildPairs(baseMessageCount: number, pairCount: number): vscode.LanguageModelChatMessage[] {
        const messages: vscode.LanguageModelChatMessage[] = [];
        for (let i = 0; i < baseMessageCount; i++) {
            messages.push(bigText(200, 'user'));
        }
        for (let i = 0; i < pairCount; i++) {
            messages.push(bigText(4000, 'assistant'));
            messages.push(bigText(4000, 'user'));
        }
        return messages;
    }

    it('removes whole pairs in twos and emits a single summary message', () => {
        const baseCount = 2;
        const messages = buildPairs(baseCount, 10);
        // Total ~80k chars → ~20k tokens. Budget = 0.75 * 4000 = 3000 → trim.
        // toolMessages=20, keepLast=6, removable=14 (even) → toRemove=14, 7 rounds.
        (new ToolRunner() as any).trimContextIfNeeded(messages, baseCount, 4000);

        // base(2) + summary(1) + kept(6) = 9
        assert.strictEqual(messages.length, baseCount + 1 + 6);
        const inserted = messages[baseCount];
        const part = inserted.content[0] as vscode.LanguageModelTextPart;
        assert.match(part.value, /^\[7 earlier tool rounds omitted/);
    });

    it('rounds an odd removable count DOWN to the previous full pair', () => {
        // Construct a synthetic, odd tool region (in real code this only
        // happens after a previous transcript desync; the regression we are
        // protecting against is making the situation worse by removing 1
        // more half-pair).
        const baseCount = 1;
        const messages: vscode.LanguageModelChatMessage[] = [bigText(200, 'user')];
        // 9 tool messages = odd
        for (let i = 0; i < 9; i++) {
            messages.push(bigText(4000, i % 2 === 0 ? 'assistant' : 'user'));
        }

        (new ToolRunner() as any).trimContextIfNeeded(messages, baseCount, 4000);

        // toolMessages=9, keepLast=6, removable=3 → must round DOWN to 2 (= 1 pair).
        // Final length = base(1) + summary(1) + kept(7) = 9
        assert.strictEqual(messages.length, baseCount + 1 + 7);
        const inserted = messages[baseCount];
        const part = inserted.content[0] as vscode.LanguageModelTextPart;
        assert.match(part.value, /^\[1 earlier tool rounds omitted/);
    });

    it('is a no-op when removable is less than 2 (1 leftover half-pair)', () => {
        // 7 tool messages, keep last 6 → removable = 1 → cannot round to a full pair.
        // Better to do nothing than to leave the message stream malformed.
        const baseCount = 1;
        const messages: vscode.LanguageModelChatMessage[] = [bigText(200, 'user')];
        for (let i = 0; i < 7; i++) {
            messages.push(bigText(4000, i % 2 === 0 ? 'assistant' : 'user'));
        }
        const before = messages.length;
        (new ToolRunner() as any).trimContextIfNeeded(messages, baseCount, 4000);
        assert.strictEqual(messages.length, before);
    });

    it('is a no-op when total chars are within budget', () => {
        const messages = buildPairs(1, 1);
        const before = messages.length;
        (new ToolRunner() as any).trimContextIfNeeded(messages, 1, 100_000);
        assert.strictEqual(messages.length, before);
    });
});
