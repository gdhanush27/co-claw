import * as vscode from 'vscode';

export function createFollowUpProvider(): vscode.ChatFollowupProvider {
    return {
        provideFollowups(
            result: vscode.ChatResult,
            _context: vscode.ChatContext,
            _token: vscode.CancellationToken,
        ): vscode.ChatFollowup[] {
            return [
                {
                    prompt: 'What do you remember about me?',
                    label: 'Check memory',
                    command: 'memory',
                },
                {
                    prompt: 'Save important facts from this conversation',
                    label: 'Distill to long-term',
                    command: 'distill',
                },
            ];
        },
    };
}
