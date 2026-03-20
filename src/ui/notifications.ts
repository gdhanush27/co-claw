import * as vscode from 'vscode';

export function showInfo(message: string): void {
    vscode.window.showInformationMessage(`CoClaw: ${message}`);
}

export function showError(message: string): void {
    vscode.window.showErrorMessage(`CoClaw: ${message}`);
}

export function showWarning(message: string): void {
    vscode.window.showWarningMessage(`CoClaw: ${message}`);
}
