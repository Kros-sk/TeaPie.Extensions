import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Variables, VariablesProvider } from './VariablesProvider';

export class VariablesEditorProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static currentFile: vscode.Uri | undefined;
    private static fileWatcher: vscode.FileSystemWatcher | undefined;

    public static async show(uri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // Store the current file URI
        VariablesEditorProvider.currentFile = uri;

        // If we already have a panel, show it
        if (VariablesEditorProvider.currentPanel) {
            VariablesEditorProvider.currentPanel.reveal(column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
            VariablesEditorProvider.currentPanel.webview.html = await VariablesEditorProvider.getWebviewContent(uri);
            return;
        }

        // Otherwise, create a new panel
        VariablesEditorProvider.currentPanel = vscode.window.createWebviewPanel(
            'variablesEditor',
            'TeaPie Variables Editor',
            column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        VariablesEditorProvider.currentPanel.webview.html = await VariablesEditorProvider.getWebviewContent(uri);

        // Handle messages from the webview
        VariablesEditorProvider.currentPanel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'saveVariables':
                        await VariablesEditorProvider.saveVariables(message.variables);
                        return;
                }
            },
            undefined,
            []
        );

        // Setup file watcher if not already set up
        if (!VariablesEditorProvider.fileWatcher) {
            VariablesEditorProvider.fileWatcher = vscode.workspace.createFileSystemWatcher('**/.teapie/cache/variables/variables.json');
            
            // Watch for file changes
            VariablesEditorProvider.fileWatcher.onDidChange(async (changedUri) => {
                if (VariablesEditorProvider.currentPanel && 
                    VariablesEditorProvider.currentFile && 
                    changedUri.fsPath === VariablesEditorProvider.currentFile.fsPath) {
                    VariablesEditorProvider.currentPanel.webview.html = await VariablesEditorProvider.getWebviewContent(changedUri);
                }
            });
        }

        // Reset when the panel is disposed
        VariablesEditorProvider.currentPanel.onDidDispose(
            () => {
                VariablesEditorProvider.currentPanel = undefined;
                // Dispose file watcher when panel is closed
                if (VariablesEditorProvider.fileWatcher) {
                    VariablesEditorProvider.fileWatcher.dispose();
                    VariablesEditorProvider.fileWatcher = undefined;
                }
                VariablesEditorProvider.currentFile = undefined;
            },
            null,
            []
        );
    }

    private static async saveVariables(variables: Variables): Promise<void> {
        if (!VariablesEditorProvider.currentFile) {
            return;
        }

        try {
            const content = JSON.stringify(variables, null, 2);
            await fs.promises.writeFile(VariablesEditorProvider.currentFile.fsPath, content, 'utf8');
            vscode.window.showInformationMessage('Variables saved successfully');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save variables: ${error}`);
        }
    }

    private static async getWebviewContent(uri: vscode.Uri): Promise<string> {
        const content = await fs.promises.readFile(uri.fsPath, 'utf8');
        const variables = JSON.parse(content);

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                        line-height: 1.6;
                        padding: 20px;
                        max-width: 1200px;
                        margin: 0 auto;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                    }
                    .section {
                        margin-bottom: 20px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                        overflow: hidden;
                    }
                    .section-header {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 10px;
                        font-weight: bold;
                        cursor: pointer;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .section-content {
                        padding: 10px;
                    }
                    .variable-row {
                        display: flex;
                        gap: 10px;
                        margin-bottom: 10px;
                        align-items: center;
                    }
                    .variable-name {
                        flex: 1;
                    }
                    .variable-value {
                        flex: 2;
                    }
                    input, textarea {
                        width: 100%;
                        padding: 8px;
                        border: 1px solid var(--vscode-input-border);
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border-radius: 4px;
                    }
                    textarea {
                        min-height: 100px;
                        resize: vertical;
                    }
                    button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .toolbar {
                        position: sticky;
                        top: 0;
                        background-color: var(--vscode-editor-background);
                        padding: 10px 0;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        z-index: 1000;
                        margin-bottom: 20px;
                        display: flex;
                        gap: 10px;
                    }
                    .add-variable-btn {
                        background-color: var(--vscode-gitDecoration-addedResourceForeground);
                    }
                    .delete-btn {
                        background-color: var(--vscode-errorForeground);
                        padding: 4px 8px;
                    }
                    .section-title {
                        color: var(--vscode-descriptionForeground);
                        font-size: 0.9em;
                        text-transform: uppercase;
                        letter-spacing: 0.1em;
                        margin: 1em 0 0.5em;
                        border-bottom: 1px solid var(--vscode-widget-border);
                        padding-bottom: 0.3em;
                    }
                </style>
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function toggleSection(sectionId) {
                        const content = document.getElementById(sectionId + '-content');
                        const header = document.getElementById(sectionId + '-header');
                        const isCollapsed = content.style.display === 'none';
                        content.style.display = isCollapsed ? 'block' : 'none';
                        header.querySelector('.toggle-icon').textContent = isCollapsed ? '▼' : '▶';
                    }

                    function addVariable(sectionId) {
                        const container = document.getElementById(sectionId + '-variables');
                        const row = document.createElement('div');
                        row.className = 'variable-row';
                        row.innerHTML = \`
                            <input type="text" class="variable-name" placeholder="Variable name">
                            <input type="text" class="variable-value" placeholder="Variable value">
                            <button class="delete-btn" onclick="deleteVariable(this)">×</button>
                        \`;
                        container.appendChild(row);
                        updateVariables();
                    }

                    function deleteVariable(button) {
                        button.parentElement.remove();
                        updateVariables();
                    }

                    function updateVariables() {
                        const variables = {
                            GlobalVariables: {},
                            EnvironmentVariables: {},
                            CollectionVariables: {},
                            TestCaseVariables: {}
                        };

                        ['global', 'environment', 'collection', 'testcase'].forEach(section => {
                            const container = document.getElementById(section + '-variables');
                            container.querySelectorAll('.variable-row').forEach(row => {
                                const name = row.querySelector('.variable-name').value;
                                const value = row.querySelector('.variable-value').value;
                                if (name && value) {
                                    variables[section.charAt(0).toUpperCase() + section.slice(1) + 'Variables'][name] = value;
                                }
                            });
                        });

                        vscode.postMessage({
                            command: 'saveVariables',
                            variables: variables
                        });
                    }

                    // Add event listeners to all inputs
                    document.addEventListener('input', function(e) {
                        if (e.target.matches('input, textarea')) {
                            updateVariables();
                        }
                    });
                </script>
            </head>
            <body>
                <div class="toolbar">
                    <button onclick="addVariable('global')">Add Global Variable</button>
                    <button onclick="addVariable('environment')">Add Environment Variable</button>
                    <button onclick="addVariable('collection')">Add Collection Variable</button>
                    <button onclick="addVariable('testcase')">Add Test Case Variable</button>
                </div>

                <div class="section">
                    <div class="section-header" id="global-header" onclick="toggleSection('global')">
                        <span>Global Variables</span>
                        <span class="toggle-icon">▼</span>
                    </div>
                    <div class="section-content" id="global-content">
                        <div id="global-variables">
                            ${Object.entries(variables.GlobalVariables || {}).map(([name, value]) => `
                                <div class="variable-row">
                                    <input type="text" class="variable-name" value="${name}" placeholder="Variable name">
                                    <input type="text" class="variable-value" value="${value}" placeholder="Variable value">
                                    <button class="delete-btn" onclick="deleteVariable(this)">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header" id="environment-header" onclick="toggleSection('environment')">
                        <span>Environment Variables</span>
                        <span class="toggle-icon">▼</span>
                    </div>
                    <div class="section-content" id="environment-content">
                        <div id="environment-variables">
                            ${Object.entries(variables.EnvironmentVariables || {}).map(([name, value]) => `
                                <div class="variable-row">
                                    <input type="text" class="variable-name" value="${name}" placeholder="Variable name">
                                    <input type="text" class="variable-value" value="${value}" placeholder="Variable value">
                                    <button class="delete-btn" onclick="deleteVariable(this)">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header" id="collection-header" onclick="toggleSection('collection')">
                        <span>Collection Variables</span>
                        <span class="toggle-icon">▼</span>
                    </div>
                    <div class="section-content" id="collection-content">
                        <div id="collection-variables">
                            ${Object.entries(variables.CollectionVariables || {}).map(([name, value]) => `
                                <div class="variable-row">
                                    <input type="text" class="variable-name" value="${name}" placeholder="Variable name">
                                    <input type="text" class="variable-value" value="${value}" placeholder="Variable value">
                                    <button class="delete-btn" onclick="deleteVariable(this)">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header" id="testcase-header" onclick="toggleSection('testcase')">
                        <span>Test Case Variables</span>
                        <span class="toggle-icon">▼</span>
                    </div>
                    <div class="section-content" id="testcase-content">
                        <div id="testcase-variables">
                            ${Object.entries(variables.TestCaseVariables || {}).map(([name, value]) => `
                                <div class="variable-row">
                                    <input type="text" class="variable-name" value="${name}" placeholder="Variable name">
                                    <input type="text" class="variable-value" value="${value}" placeholder="Variable value">
                                    <button class="delete-btn" onclick="deleteVariable(this)">×</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `;
    }
} 