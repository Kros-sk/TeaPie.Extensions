import * as vscode from 'vscode';

import { HttpCompletionProvider } from './HttpCompletionProvider';

type TpSection = 'init' | 'http' | 'test' | 'none';

const sectionMarkerPattern = /^---\s+(TESTCASE|INIT|HTTP|TEST|END)\b/;

function getCurrentSection(document: vscode.TextDocument, position: vscode.Position): TpSection {
    for (let line = position.line; line >= 0; line--) {
        const text = document.lineAt(line).text.trim();
        const match = text.match(sectionMarkerPattern);
        if (match) {
            switch (match[1]) {
                case 'INIT': return 'init';
                case 'HTTP': return 'http';
                case 'TEST': return 'test';
                case 'END':
                case 'TESTCASE':
                    return 'none';
            }
        }
    }
    // No markers found — implicit single test case, treat as HTTP
    return 'http';
}

const sectionDescriptions: Record<string, string> = {
    'TESTCASE': 'Starts a named test case. Required when multiple test cases are in one file.\n\n```\n--- TESTCASE My Test Name\n```',
    'INIT': 'Pre-request C# script section (optional). Code here runs before the HTTP request.\n\n```\n--- INIT\n// C# initialization code\n```',
    'HTTP': 'HTTP request section (required). Same format as .http files.\n\n```\n--- HTTP\nGET {{host}}/api/endpoint\n```',
    'TEST': 'Post-response C# script section (optional). Code here runs after the HTTP response.\n\n```\n--- TEST\ntp.TestExpectStatus(200);\n```',
    'END': 'Ends the current test case block.\n\n```\n--- END\n```'
};

export class TpCompletionProvider implements vscode.CompletionItemProvider {
    private httpCompletionProvider = new HttpCompletionProvider();

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const linePrefix = document.lineAt(position).text.substr(0, position.character);

        // Section marker completions when typing ---
        if (linePrefix.trim().startsWith('---') || linePrefix.trim() === '-' || linePrefix.trim() === '--') {
            return this.getSectionMarkerCompletions();
        }

        const section = getCurrentSection(document, position);

        switch (section) {
            case 'http':
                return this.httpCompletionProvider.provideCompletionItems(document, position);
            case 'init':
            case 'test':
                // C# completions are handled by the embedded language support
                return [];
            case 'none':
                // Between test cases or at top level — offer section markers
                if (linePrefix.trim() === '') {
                    return this.getSectionMarkerCompletions();
                }
                return [];
        }
    }

    private getSectionMarkerCompletions(): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const markers = ['TESTCASE', 'INIT', 'HTTP', 'TEST', 'END'];

        for (const marker of markers) {
            const item = new vscode.CompletionItem(`--- ${marker}`, vscode.CompletionItemKind.Keyword);
            item.documentation = new vscode.MarkdownString(sectionDescriptions[marker]);
            item.insertText = marker === 'TESTCASE' ? `--- ${marker} ` : `--- ${marker}`;
            item.sortText = `!${markers.indexOf(marker)}`;
            items.push(item);
        }

        return items;
    }
}

export { getCurrentSection, TpSection, sectionDescriptions };
