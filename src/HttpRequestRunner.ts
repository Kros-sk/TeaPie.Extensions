import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface TeaPieResult {
    TestSuites: {
        TestSuite: TeaPieTestSuite[];
    };
}

interface TeaPieTestSuite {
    Name: string;
    FilePath: string;
    Tests: TeaPieTest[];
    Status: string;
    Duration: string;
}

interface TeaPieTest {
    Name: string;
    Status: string;
    Duration: string;
    Request?: {
        Method: string;
        Url: string;
        Headers: { [key: string]: string };
        Body?: string;
    };
    Response?: {
        StatusCode: number;
        StatusText: string;
        Headers: { [key: string]: string };
        Body?: string;
        Duration: string;
    };
    ErrorMessage?: string;
}

export class HttpRequestRunner {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static outputChannel: vscode.OutputChannel;

    public static setOutputChannel(channel: vscode.OutputChannel) {
        HttpRequestRunner.outputChannel = channel;
    }

    public static async runHttpFile(uri: vscode.Uri) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        const targetColumn = column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;

        // Create or show the panel
        if (HttpRequestRunner.currentPanel) {
            HttpRequestRunner.currentPanel.reveal(targetColumn);
        } else {
            HttpRequestRunner.currentPanel = vscode.window.createWebviewPanel(
                'httpRequestResults',
                'HTTP Request Results',
                targetColumn,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            HttpRequestRunner.currentPanel.onDidDispose(() => {
                HttpRequestRunner.currentPanel = undefined;
            });
        }

        // Show loading state
        HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getLoadingContent(uri);

        try {
            const results = await HttpRequestRunner.executeTeaPie(uri.fsPath);
            if (HttpRequestRunner.currentPanel) {
                HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getResultsContent(results, uri);
                HttpRequestRunner.setupRetryHandler(uri);
            }
        } catch (error) {
            const errorMessage = `Failed to execute HTTP requests: ${error}`;
            HttpRequestRunner.outputChannel.appendLine(errorMessage);
            
            if (HttpRequestRunner.currentPanel) {
                HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getErrorContent(uri, errorMessage);
            }
            
            vscode.window.showErrorMessage(errorMessage);
        }
    }

    private static async executeTeaPie(filePath: string): Promise<TeaPieResult> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder is open');
        }

        const currentEnv = vscode.workspace.getConfiguration().get<string>('teapie.currentEnvironment');
        const envParam = currentEnv ? ` -e "${currentEnv}"` : '';
        const command = `teapie test "${filePath}" --no-logo --verbose${envParam}`;
        
        HttpRequestRunner.outputChannel.appendLine(`Executing: ${command}`);

        try {
            const { stdout } = await execAsync(command, {
                cwd: workspaceFolder.uri.fsPath,
                timeout: 60000
            });

            return HttpRequestRunner.parseOutput(stdout, filePath);
        } catch (error: any) {
            // Try to parse error output if available
            if (error.stdout) {
                try {
                    return HttpRequestRunner.parseOutput(error.stdout, filePath);
                } catch {
                    // Fall through to create failed result
                }
            }
            
            return HttpRequestRunner.createFailedResult(filePath, error.message || error.toString());
        }
    }

    private static parseOutput(stdout: string, filePath: string): TeaPieResult {
        const fileName = path.basename(filePath, path.extname(filePath));
        const lines = stdout.split('\n');
        const requests: any[] = [];
        let currentRequest: any = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Look for request start
            const startMatch = line.match(/Start processing HTTP request (\w+)\s+(.+)/);
            if (startMatch) {
                currentRequest = {
                    method: startMatch[1],
                    url: startMatch[2],
                    requestHeaders: {},
                    responseHeaders: {}
                };
                continue;
            }

            // Look for request body
            if (currentRequest && line.includes("Following HTTP request's body")) {
                currentRequest.requestBody = this.extractBody(lines, i);
                continue;
            }

            // Look for response
            const responseMatch = line.match(/HTTP Response (\d+) \(([^)]+)\) was received/);
            if (currentRequest && responseMatch) {
                currentRequest.responseStatus = parseInt(responseMatch[1]);
                currentRequest.responseStatusText = responseMatch[2];
                continue;
            }

            // Look for response body
            if (currentRequest && line.includes("Response's body")) {
                currentRequest.responseBody = this.extractBody(lines, i);
                continue;
            }

            // Look for request end
            const endMatch = line.match(/End processing HTTP request after ([\d.]+)ms - (\d+)/);
            if (endMatch) {
                if (currentRequest) {
                    currentRequest.duration = endMatch[1] + 'ms';
                    currentRequest.responseStatus = parseInt(endMatch[2]);
                    requests.push(currentRequest);
                    currentRequest = null;
                }
                continue;
            }
        }

        // Convert to test format
        const tests = requests.map(req => ({
            Name: `${req.method} ${req.url}`,
            Status: req.responseStatus >= 200 && req.responseStatus < 400 ? 'Passed' : 'Failed',
            Duration: req.duration || '0ms',
            Request: {
                Method: req.method,
                Url: req.url,
                Headers: req.requestHeaders,
                Body: req.requestBody
            },
            Response: req.responseStatus ? {
                StatusCode: req.responseStatus,
                StatusText: req.responseStatusText || 'OK',
                Headers: req.responseHeaders,
                Body: req.responseBody,
                Duration: req.duration || '0ms'
            } : undefined
        }));

        return {
            TestSuites: {
                TestSuite: [{
                    Name: fileName,
                    FilePath: filePath,
                    Tests: tests,
                    Status: tests.every(t => t.Status === 'Passed') ? 'Passed' : 'Failed',
                    Duration: '0s'
                }]
            }
        };
    }

    private static extractBody(lines: string[], startIndex: number): string {
        const bodyLines: string[] = [];
        let i = startIndex + 1;
        
        while (i < lines.length) {
            const line = lines[i];
            if (line.trim().match(/^\[[\d:]+\s+\w+\]/) || 
                line.includes('INF] Sending HTTP request') || 
                line.includes('INF] End processing')) {
                break;
            }
            bodyLines.push(line);
            i++;
        }
        
        return bodyLines.join('\n').trim();
    }

    private static createFailedResult(filePath: string, errorMessage: string): TeaPieResult {
        return {
            TestSuites: {
                TestSuite: [{
                    Name: path.basename(filePath, path.extname(filePath)),
                    FilePath: filePath,
                    Tests: [{
                        Name: 'HTTP Request Failed',
                        Status: 'Failed',
                        Duration: '0ms',
                        ErrorMessage: errorMessage
                    }],
                    Status: 'Failed',
                    Duration: '0s'
                }]
            }
        };
    }

    private static setupRetryHandler(uri: vscode.Uri) {
        if (!HttpRequestRunner.currentPanel) return;
        
        HttpRequestRunner.currentPanel.webview.onDidReceiveMessage(
            (message) => {
                if (message?.command === 'retry') {
                    HttpRequestRunner.runHttpFile(uri);
                }
            }
        );
    }

    private static getLoadingContent(fileUri: vscode.Uri): string {
        const fileName = path.basename(fileUri.fsPath);
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>HTTP Request Results</title>
    <style>${this.getStyles()}</style>
</head>
<body>
    <div class="header">
        <h1>HTTP Request Results: <span class="filename">${fileName}</span></h1>
    </div>
    <div class="loading-container">
        <div class="spinner"></div>
        <div class="loading-text">Executing HTTP requests...</div>
    </div>
</body>
</html>`;
    }

    private static getErrorContent(fileUri: vscode.Uri, errorMessage: string): string {
        const fileName = path.basename(fileUri.fsPath);
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>HTTP Request Results</title>
    <style>${this.getStyles()}</style>
</head>
<body>
    <div class="header">
        <h1>HTTP Request Results: <span class="filename">${fileName}</span>
            <button class="retry-btn" id="retry-btn">⟳ Retry</button>
        </h1>
    </div>
    <div class="error-container">
        <div class="error-icon">⚠️</div>
        <div class="error-title">Failed to execute HTTP requests</div>
        <div class="error-message">${errorMessage}</div>
    </div>
    <script>${this.getScript()}</script>
</body>
</html>`;
    }

    private static getResultsContent(results: TeaPieResult, fileUri: vscode.Uri): string {
        const fileName = path.basename(fileUri.fsPath);
        let requestsHtml = '';
        
        if (results.TestSuites?.TestSuite) {
            results.TestSuites.TestSuite.forEach(suite => {
                suite.Tests?.forEach((test, idx) => {
                    const statusText = test.Status === 'Passed' ? 'Success' : 'Fail';
                    
                    let requestHtml = '';
                    if (test.Request) {
                        const body = this.formatBody(test.Request.Body);
                        requestHtml = `
                            <div class="section">
                                <h4>Request</h4>
                                <div class="method-url">
                                    <span class="method method-${test.Request.Method.toLowerCase()}">${test.Request.Method}</span>
                                    <span class="url" id="url-${idx}">${test.Request.Url}</span>
                                    <button class="copy-btn" onclick="copyToClipboard(this, 'url-${idx}')">📋 Copy </button>
                                </div>
                                ${body ? `
                                <div class="body-container">
                                    <div class="body-header">
                                        <span>Request Body</span>
                                    </div>
                                    <div class="code-block">
                                        <pre class="body json" id="request-${idx}">${body}</pre>
                                        <button class="copy-btn inline-copy-btn" onclick="copyToClipboard(this, 'request-${idx}')">📋 Copy </button>
                                    </div>
                                </div>` : ''}
                            </div>`;
                    }
                    
                    let responseHtml = '';
                    if (test.Response) {
                        const statusClass = test.Response.StatusCode >= 200 && test.Response.StatusCode < 300 ? 'success' : 'error';
                        const body = this.formatBody(test.Response.Body);
                        responseHtml = `
                            <div class="section">
                                <h4>Response</h4>
                                <div class="status-line">
                                    <span class="status-code status-${statusClass}">${test.Response.StatusCode}</span>
                                    <span class="status-text">${test.Response.StatusText}</span>
                                    <span class="duration">${test.Response.Duration}</span>
                                </div>
                                ${body ? `
                                <div class="body-container">
                                    <div class="body-header">
                                        <span>Response Body</span>
                                    </div>
                                    <div class="code-block">
                                        <pre class="body json" id="response-${idx}">${body}</pre>
                                        <button class="copy-btn inline-copy-btn" onclick="copyToClipboard(this, 'response-${idx}')">📋 Copy</button>
                                    </div>
                                </div>` : ''}
                            </div>`;
                    }
                    
                    let errorHtml = '';
                    if (test.ErrorMessage) {
                        errorHtml = `
                            <div class="section error">
                                <h4>Error</h4>
                                <pre class="error-message">${test.ErrorMessage}</pre>
                            </div>`;
                    }
                    
                    requestsHtml += `
                        <div class="request-item">
                            <div class="request-header">
                                <h3>${test.Name}</h3>
                                <span class="status ${test.Status.toLowerCase()}">${statusText}</span>
                            </div>
                            <div class="request-content">
                                ${requestHtml}
                                ${responseHtml}
                                ${errorHtml}
                            </div>
                        </div>`;
                });
            });
        }

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>HTTP Request Results</title>
    <style>${this.getStyles()}</style>
</head>
<body>
    <div class="header">
        <h1>HTTP Request Results: <span class="filename">${fileName}</span>
            <button class="retry-btn" id="retry-btn">⟳ Retry</button>
        </h1>
    </div>
    ${requestsHtml || '<div class="no-results"><h2>No HTTP requests found</h2></div>'}
    <script>${this.getScript()}</script>
</body>
</html>`;
    }

    private static formatBody(body?: string): string {
        if (!body) return '';
        
        try {
            const parsed = JSON.parse(body);
            const formatted = JSON.stringify(parsed, null, 2);
            // Add basic JSON syntax highlighting
            return formatted
                .replace(/"([^"]+)":/g, '<span class="json-key">"$1":</span>')
                .replace(/:\s*"([^"]*)"/g, ': <span class="json-string">"$1"</span>')
                .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
                .replace(/:\s*(true|false)/g, ': <span class="json-boolean">$1</span>')
                .replace(/:\s*null/g, ': <span class="json-null">null</span>');
        } catch {
            return body;
        }
    }

    private static getStyles(): string {
        return `
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
            .header { margin-bottom: 30px; padding-bottom: 15px; border-bottom: 1px solid var(--vscode-panel-border); }
            .header h1 { margin: 0; font-size: 24px; }
            .filename { font-style: italic; color: var(--vscode-textLink-foreground); font-family: monospace; }
            .retry-btn { margin-left: 15px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 12px; cursor: pointer; }
            .retry-btn:hover { background: var(--vscode-button-hoverBackground); }
            .loading-container { text-align: center; padding: 60px 20px; }
            .spinner { width: 40px; height: 40px; border: 4px solid var(--vscode-panel-border); border-top: 4px solid var(--vscode-button-background); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .loading-text { font-size: 16px; color: var(--vscode-descriptionForeground); }
            .error-container { padding: 30px; text-align: center; }
            .error-icon { font-size: 48px; margin-bottom: 20px; }
            .error-title { font-size: 20px; color: var(--vscode-terminal-ansiRed); margin-bottom: 15px; font-weight: bold; }
            .error-message { background: var(--vscode-textCodeBlock-background); padding: 15px; border-radius: 6px; border-left: 4px solid var(--vscode-terminal-ansiRed); font-family: monospace; text-align: left; white-space: pre-wrap; }
            .request-item { margin-bottom: 30px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
            .request-header { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-panel-border); }
            .request-header h3 { margin: 0; font-size: 16px; }
            .status { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
            .status.passed { background: var(--vscode-terminal-ansiGreen); color: white; }
            .status.failed { background: var(--vscode-terminal-ansiRed); color: white; }
            .request-content { padding: 20px; }
            .section { margin-bottom: 20px; }
            .section h4 { margin: 0 0 10px 0; font-size: 14px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
            .method-url { display: flex; align-items: center; gap: 15px; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; }
            .method { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; min-width: 50px; text-align: center; color: white; }
            .method-get { background: #4CAF50; } .method-post { background: #FF9800; } .method-put { background: #2196F3; } .method-delete { background: #F44336; }
            .url { font-family: monospace; font-weight: 500; word-break: break-all; flex: 1; }
            .status-line { display: flex; align-items: center; gap: 15px; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; }
            .status-code { padding: 4px 8px; border-radius: 4px; font-weight: bold; min-width: 40px; text-align: center; color: white; }
            .status-success { background: #4CAF50; } .status-error { background: #F44336; }
            .status-text { font-weight: 500; flex: 1; }
            .duration { font-size: 12px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 3px; }
            .body-container { margin-top: 10px; }
            .body-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
            .body-header span { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
            .code-block { position: relative; }
            .copy-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
            .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
            .inline-copy-btn { position: absolute; top: 8px; right: 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
            .inline-copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
            pre.body { background: var(--vscode-textCodeBlock-background); padding: 15px; border-radius: 6px; overflow-x: auto; font-family: monospace; font-size: 13px; margin: 0; white-space: pre-wrap; border: 1px solid var(--vscode-panel-border); }
            pre.body.json { color: var(--vscode-editor-foreground); }
            .json .json-key { color: var(--vscode-symbolIcon-keywordForeground); }
            .json .json-string { color: var(--vscode-symbolIcon-stringForeground); }
            .json .json-number { color: var(--vscode-symbolIcon-numberForeground); }
            .json .json-boolean { color: var(--vscode-symbolIcon-booleanForeground); }
            .json .json-null { color: var(--vscode-symbolIcon-nullForeground); }
            .error-message { color: var(--vscode-terminal-ansiRed); }
            .no-results { text-align: center; padding: 60px 20px; color: var(--vscode-descriptionForeground); }
        `;
    }

    private static getScript(): string {
        return `
            const retryBtn = document.getElementById('retry-btn');
            if (retryBtn && window.acquireVsCodeApi) {
                retryBtn.addEventListener('click', () => {
                    const vscode = window.acquireVsCodeApi();
                    vscode.postMessage({ command: 'retry' });
                });
            }

            function copyToClipboard(button, elementId) {
                const element = document.getElementById(elementId);
                if (element) {
                    const text = element.textContent || element.innerText;
                    navigator.clipboard.writeText(text).then(() => {
                        const originalText = button.textContent;
                        button.textContent = '✓ Copied';
                        button.style.background = 'var(--vscode-terminal-ansiGreen)';
                        setTimeout(() => {
                            button.textContent = originalText;
                            button.style.background = 'var(--vscode-button-secondaryBackground)';
                        }, 1500);
                    }).catch(() => {
                        button.textContent = '❌ Failed';
                        setTimeout(() => {
                            button.textContent = '📋 Copy';
                        }, 1500);
                    });
                }
            }
        `;
    }
}
