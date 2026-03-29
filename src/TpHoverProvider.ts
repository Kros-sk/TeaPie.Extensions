import * as vscode from 'vscode';

import { HttpHoverProvider } from './HttpHoverProvider';
import { getCurrentSection, sectionDescriptions } from './TpCompletionProvider';

export class TpHoverProvider implements vscode.HoverProvider {
    private httpHoverProvider = new HttpHoverProvider();

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined {
        const line = document.lineAt(position).text;

        // Hover on section markers
        const markerMatch = line.match(/^---\s+(TESTCASE|INIT|HTTP|TEST|END)\b/);
        if (markerMatch) {
            const keyword = markerMatch[1];
            const description = sectionDescriptions[keyword];
            if (description) {
                return new vscode.Hover(new vscode.MarkdownString(description));
            }
        }

        const section = getCurrentSection(document, position);

        switch (section) {
            case 'http':
                return this.httpHoverProvider.provideHover(document, position);
            case 'init':
            case 'test':
                // C# hover is handled by the embedded language support
                return undefined;
            default:
                return undefined;
        }
    }
}
