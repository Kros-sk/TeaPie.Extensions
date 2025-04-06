import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Environment {
    [key: string]: {
        [key: string]: string | boolean | number;
    };
}

export class EnvironmentEditorProvider {
    private static readonly viewType = 'teapie.environmentEditor';
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static currentEnvironment: Environment | undefined;
    private static watcher: vscode.FileSystemWatcher | undefined;
    private static statusBarItem: vscode.StatusBarItem;
    private static context: vscode.ExtensionContext;

    static initialize(context: vscode.ExtensionContext) {
        this.context = context;
        this.setupStatusBar();
        this.setupFileWatcher();
        this.loadCurrentEnvironment();
    }

    private static setupStatusBar() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'teapie-extensions.selectEnvironment';
        this.updateStatusBar();
        this.statusBarItem.show();
        this.context.subscriptions.push(this.statusBarItem);
    }

    private static setupFileWatcher() {
        if (this.watcher) {
            this.watcher.dispose();
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        this.watcher = vscode.workspace.createFileSystemWatcher('**/.teapie/env.json');
        
        this.watcher.onDidChange(() => {
            this.loadCurrentEnvironment();
            if (this.currentPanel) {
                this.currentPanel.webview.html = this.getWebviewContent(this.currentPanel.webview);
            }
        });

        this.context.subscriptions.push(this.watcher);
    }

    private static async loadCurrentEnvironment() {
        const envFile = await this.getEnvironmentFile();
        if (!envFile) {
            return;
        }

        try {
            const content = await fs.promises.readFile(envFile, 'utf8');
            this.currentEnvironment = JSON.parse(content);
            const currentEnv = this.context.workspaceState.get<string>('teapie.currentEnvironment') || 'local';
            this.updateStatusBar(currentEnv);
        } catch (error) {
            this.currentEnvironment = { $shared: {}, local: {} };
        }
    }

    private static updateStatusBar(environment: string = 'local') {
        this.statusBarItem.text = `$(symbol-enum) ENV: ${environment}`;
        this.statusBarItem.tooltip = 'Click to change environment';
    }

    static async selectEnvironment() {
        if (!this.currentEnvironment) {
            await this.loadCurrentEnvironment();
        }

        const environments = Object.keys(this.currentEnvironment || {}).filter(env => env !== '$shared');
        const selected = await vscode.window.showQuickPick(environments, {
            placeHolder: 'Select environment',
        });

        if (selected) {
            await this.context.workspaceState.update('teapie.currentEnvironment', selected);
            this.updateStatusBar(selected);
        }
    }

    private static async getEnvironmentFile(): Promise<string | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return undefined;
        }

        const envFilePath = path.join(workspaceFolders[0].uri.fsPath, '.teapie', 'env.json');
        
        try {
            await fs.promises.access(envFilePath);
            return envFilePath;
        } catch {
            const dirPath = path.dirname(envFilePath);
            try {
                await fs.promises.mkdir(dirPath, { recursive: true });
                await fs.promises.writeFile(envFilePath, JSON.stringify({
                    $shared: {},
                    local: {}
                }, null, 4));
                return envFilePath;
            } catch (error) {
                vscode.window.showErrorMessage('Failed to create environment file');
                return undefined;
            }
        }
    }

    static async show() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder is open');
            return;
        }

        const envFile = await this.getEnvironmentFile();
        if (!envFile) {
            return;
        }

        if (this.currentPanel) {
            this.currentPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.currentPanel = vscode.window.createWebviewPanel(
            this.viewType,
            'TeaPie Environment Editor',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.currentPanel.webview.html = this.getWebviewContent(this.currentPanel.webview);

        this.currentPanel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'updateEnvironments':
                    await this.saveEnvironments(message.environments);
                    break;
            }
        });

        this.currentPanel.onDidDispose(() => {
            this.currentPanel = undefined;
        });
    }

    private static async saveEnvironments(environments: Environment) {
        const envFile = await this.getEnvironmentFile();
        if (!envFile) {
            return;
        }

        try {
            await fs.promises.writeFile(envFile, JSON.stringify(environments, null, 4));
            this.currentEnvironment = environments;
            vscode.window.showInformationMessage('Environments saved successfully');
        } catch (error) {
            vscode.window.showErrorMessage('Failed to save environments');
        }
    }

    private static getWebviewContent(webview: vscode.Webview): string {
        const environments = this.currentEnvironment || { $shared: {}, local: {} };

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>TeaPie Environment Editor</title>
            <style>
                body {
                    padding: 20px;
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-editor-foreground);
                }
                .environment-section {
                    margin-bottom: 20px;
                    border: 1px solid var(--vscode-panel-border);
                    padding: 15px;
                    border-radius: 5px;
                }
                .environment-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 10px;
                }
                .environment-name {
                    font-size: 1.2em;
                    font-weight: bold;
                    color: var(--vscode-editor-foreground);
                }
                .variable-row {
                    display: flex;
                    margin-bottom: 8px;
                    gap: 10px;
                }
                input {
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 4px 8px;
                    border-radius: 2px;
                }
                input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 12px;
                    border-radius: 2px;
                    cursor: pointer;
                }
                button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .delete-btn {
                    background: var(--vscode-errorForeground);
                }
                .save-container {
                    position: fixed;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    padding: 15px;
                    background: var(--vscode-editor-background);
                    border-top: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: center;
                }
                .save-btn {
                    background: var(--vscode-button-background);
                    font-size: 1.1em;
                    padding: 8px 24px;
                }
                #content {
                    margin-bottom: 70px;
                }
            </style>
        </head>
        <body>
            <div id="content">
                <div id="environments"></div>
                <button onclick="addEnvironment()" style="margin-top: 20px;">Add Environment</button>
            </div>
            <div class="save-container">
                <button class="save-btn" onclick="saveEnvironments()">Save Environments</button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let environments = ${JSON.stringify(environments)};

                function updateUI() {
                    const container = document.getElementById('environments');
                    container.innerHTML = '';

                    Object.entries(environments).forEach(([envName, variables]) => {
                        const section = document.createElement('div');
                        section.className = 'environment-section';

                        const header = document.createElement('div');
                        header.className = 'environment-header';

                        const nameContainer = document.createElement('div');
                        if (envName === '$shared') {
                            nameContainer.innerHTML = '<span class="environment-name">Shared Variables</span>';
                        } else {
                            nameContainer.innerHTML = \`
                                <input type="text" value="\${envName}" 
                                    onchange="renameEnvironment('\${envName}', this.value)"
                                    style="font-size: 1.2em; font-weight: bold;">
                                <button class="delete-btn" onclick="deleteEnvironment('\${envName}')"
                                    style="margin-left: 10px;"
                                    \${envName === '$shared' ? 'disabled' : ''}>Delete</button>
                            \`;
                        }
                        header.appendChild(nameContainer);

                        const addVarBtn = document.createElement('button');
                        addVarBtn.textContent = 'Add Variable';
                        addVarBtn.onclick = () => addVariable(envName);
                        header.appendChild(addVarBtn);

                        section.appendChild(header);

                        Object.entries(variables).forEach(([varName, varValue]) => {
                            const row = document.createElement('div');
                            row.className = 'variable-row';
                            row.innerHTML = \`
                                <input type="text" value="\${varName}" 
                                    onchange="updateVariableName('\${envName}', '\${varName}', this.value)"
                                    style="width: 200px;">
                                <input type="text" value="\${varValue}" 
                                    onchange="updateVariableValue('\${envName}', '\${varName}', this.value)"
                                    style="flex-grow: 1;">
                                <button class="delete-btn" 
                                    onclick="deleteVariable('\${envName}', '\${varName}')">Delete</button>
                            \`;
                            section.appendChild(row);
                        });

                        container.appendChild(section);
                    });
                }

                function addEnvironment() {
                    const name = 'new-environment';
                    let uniqueName = name;
                    let counter = 1;
                    while (environments[uniqueName]) {
                        uniqueName = \`\${name}-\${counter}\`;
                        counter++;
                    }
                    environments[uniqueName] = {};
                    updateUI();
                }

                function deleteEnvironment(name) {
                    if (name === '$shared') return;
                    delete environments[name];
                    updateUI();
                }

                function renameEnvironment(oldName, newName) {
                    if (oldName === '$shared' || newName === '$shared') return;
                    if (oldName === newName) return;
                    if (environments[newName]) {
                        vscode.postMessage({
                            command: 'showError',
                            text: 'Environment with this name already exists'
                        });
                        updateUI();
                        return;
                    }
                    environments[newName] = environments[oldName];
                    delete environments[oldName];
                    updateUI();
                }

                function addVariable(envName) {
                    const vars = environments[envName];
                    const name = 'new-variable';
                    let uniqueName = name;
                    let counter = 1;
                    while (vars[uniqueName]) {
                        uniqueName = \`\${name}-\${counter}\`;
                        counter++;
                    }
                    vars[uniqueName] = '';
                    updateUI();
                }

                function deleteVariable(envName, varName) {
                    delete environments[envName][varName];
                    updateUI();
                }

                function updateVariableName(envName, oldName, newName) {
                    if (oldName === newName) return;
                    const vars = environments[envName];
                    if (vars[newName]) {
                        vscode.postMessage({
                            command: 'showError',
                            text: 'Variable with this name already exists'
                        });
                        updateUI();
                        return;
                    }
                    vars[newName] = vars[oldName];
                    delete vars[oldName];
                    updateUI();
                }

                function updateVariableValue(envName, varName, value) {
                    environments[envName][varName] = value;
                }

                function saveEnvironments() {
                    vscode.postMessage({
                        command: 'updateEnvironments',
                        environments: environments
                    });
                }

                updateUI();
            </script>
        </body>
        </html>`;
    }
} 