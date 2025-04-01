import * as vscode from 'vscode';

import { DirectiveDescriptions } from './constants/directives';
import { VariablesProvider } from './VariablesProvider';

export class HttpHoverProvider implements vscode.HoverProvider {
    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined {
        const line = document.lineAt(position).text;
        const range = document.getWordRangeAtPosition(position, /(@\w+|(?:TEST|RETRY|AUTH)-[A-Z-]+|\{\{[^}]+\}\})/);
        if (!range) {
            return undefined;
        }

        const word = document.getText(range);

        // Handle directives
        if (word.startsWith('@') || word.startsWith('TEST-') || word.startsWith('RETRY-') || word.startsWith('AUTH-')) {
            const description = DirectiveDescriptions[word as keyof typeof DirectiveDescriptions];
            if (description) {
                return new vscode.Hover(new vscode.MarkdownString(description));
            }
        }

        // Handle variables
        if (word.startsWith('{{') && word.endsWith('}}')) {
            const variableName = word.slice(2, -2).trim();
            const variablesProvider = VariablesProvider.getInstance();
            const value = variablesProvider.getVariableValue(variableName);

            if (value !== undefined) {
                const markdown = new vscode.MarkdownString();
                markdown.appendCodeblock(value, 'text');
                return new vscode.Hover(markdown);
            } else {
                return new vscode.Hover(new vscode.MarkdownString('*(variable not found)*'));
            }
        }

        return undefined;
    }
} 