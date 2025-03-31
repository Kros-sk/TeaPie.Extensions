import * as vscode from 'vscode';

import { DirectiveDescriptions } from './constants/directives';

export class HttpHoverProvider implements vscode.HoverProvider {
    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined {
        const range = document.getWordRangeAtPosition(position, /(@\w+|(?:TEST|RETRY|AUTH)-[A-Z-]+)/);
        if (!range) {
            return undefined;
        }

        const directive = document.getText(range);
        const description = DirectiveDescriptions[directive as keyof typeof DirectiveDescriptions];
        
        if (description) {
            return new vscode.Hover(new vscode.MarkdownString(description));
        }

        return undefined;
    }
} 