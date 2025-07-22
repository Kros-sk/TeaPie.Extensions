import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { 
    STATUS_PASSED,
    STATUS_FAILED,
    ERROR_HTTP_FAILED,
    ERROR_UNKNOWN
} from './constants/httpResults';
import { 
    HttpRequestResults, 
    HttpRequestResult, 
    HttpTestResult 
} from './modules/HttpRequestTypes';
import { HttpFileParser } from './modules/HttpFileParser';
import { TeaPieExecutor } from './modules/TeaPieExecutor';
import { 
    CONTENT_PATTERNS
} from './constants/cliPatterns';

export class HttpRequestRunner {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static outputChannel: vscode.OutputChannel;
    private static lastRequestId = 0;
    private static panelColumn: vscode.ViewColumn | undefined;
    private static lastHttpUri: vscode.Uri | undefined;
    private static isRunning = false;
private static readonly disposables: vscode.Disposable[] = [];

    public static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
        TeaPieExecutor.setOutputChannel(channel);
    }

    public static dispose() {
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
        if (this.currentPanel) {
            this.currentPanel.dispose();
            this.currentPanel = undefined;
        }
    }

    /**
     * Runs HTTP requests from the specified file and displays results in a webview panel.
     * @param uri - The URI of the .http file to execute
     * @param forceColumn - Optional column to force the webview to appear in
     */
    public static async runHttpFile(uri: vscode.Uri, forceColumn?: vscode.ViewColumn): Promise<void> {
        if (this.isRunning) return; // Prevent concurrent runs
        this.isRunning = true;
        // If running from a different file, dispose the old panel to force a new split
        if (this.currentPanel && this.lastHttpUri && this.lastHttpUri.toString() !== uri.toString()) {
            this.currentPanel.dispose();
            this.currentPanel = undefined;
            this.panelColumn = undefined;
        }
        this.lastHttpUri = uri;
        // Use the same split logic as HttpPreviewProvider, but allow forcing the column (for retry)
        let targetColumn: vscode.ViewColumn;
        if (forceColumn) {
            targetColumn = forceColumn;
        } else {
            const column = vscode.window.activeTextEditor?.viewColumn;
            targetColumn = column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
            this.panelColumn = targetColumn;
        }

        if (this.currentPanel) {
            this.currentPanel.reveal(this.panelColumn || targetColumn);
        } else {
            this.currentPanel = vscode.window.createWebviewPanel(
                'httpRequestResults',
                'HTTP Request Results',
                this.panelColumn || targetColumn,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );
            this.panelColumn = this.currentPanel.viewColumn;
            
            const disposable = this.currentPanel.onDidDispose(() => {
                this.currentPanel = undefined;
                this.panelColumn = undefined;
                this.lastHttpUri = undefined;
                // Remove this disposable from our tracking array
                const index = this.disposables.indexOf(disposable);
                if (index > -1) {
                    this.disposables.splice(index, 1);
                }
            });
            this.disposables.push(disposable);
        }

        // Generate a unique request ID for this execution
        const requestId = ++this.lastRequestId;
        this.currentPanel.webview.html = this.getLoadingContent(uri).replace('<button class="retry-btn" id="retry-btn">Retry</button>', '<button class="retry-btn" id="retry-btn" disabled>Retry</button>');

        try {
            const results = await this.executeTeaPie(uri.fsPath);
            // Only update the panel if this is the latest request
            if (this.currentPanel && requestId === this.lastRequestId) {
                this.currentPanel.webview.html = this.getResultsContent(results, uri);
                this.setupRetryHandler(uri);
            }
        } catch (error) {
            const errorMessage = `Failed to execute HTTP requests: ${error}`;
            this.outputChannel?.appendLine(errorMessage);
            this.outputChannel?.appendLine(`Error details: ${error instanceof Error ? error.stack : String(error)}`);
            
            if (this.currentPanel && requestId === this.lastRequestId) {
                this.currentPanel.webview.html = this.getErrorContent(uri, errorMessage);
                this.setupRetryHandler(uri);
            }
            vscode.window.showErrorMessage(errorMessage);
        } finally {
            this.isRunning = false;
        }
    }

    private static executeTeaPie(filePath: string): Promise<HttpRequestResults> {
        return TeaPieExecutor.executeTeaPie(filePath);
    }

    private static createFailedResult(filePath: string, errorMessage: string): HttpRequestResults {
        return {
            RequestGroups: {
                RequestGroup: [{
                    Name: path.basename(filePath, path.extname(filePath)),
                    FilePath: filePath,
                    Requests: [{
                        Name: ERROR_HTTP_FAILED,
                        Status: STATUS_FAILED,
                        Duration: '0ms',
                        ErrorMessage: errorMessage
                    }],
                    Status: STATUS_FAILED,
                    Duration: '0s'
                }]
            }
        };
    }

    private static setupRetryHandler(uri: vscode.Uri) {
        if (!this.currentPanel) return;
        
        const messageDisposable = this.currentPanel.webview.onDidReceiveMessage(message => {
            if (message?.command === 'retry' && this.lastHttpUri && !this.isRunning) {
                            // Always use the stored split column for retry
                this.runHttpFile(this.lastHttpUri, this.panelColumn);
            }
        });
        
        this.disposables.push(messageDisposable);
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
        <h1>HTTP Request Results: <span class="filename">${fileName}</span></h1>
        <button class="retry-btn" id="retry-btn">Retry</button>
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

    private static escapeHtml(str: string | undefined): string {
        if (!str) return '';
        return str.replace(/[&<>'"`]/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;', '`': '&#96;'
        }[c] || c));
    }

    private static formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    private static formatHeaders(headers: { [key: string]: string }): string {
        if (!headers || Object.keys(headers).length === 0) return 'No headers';
        return Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
    }

    private static renderRequestHeader(request: HttpRequestResult): string {
        const statusText = request.Status === STATUS_PASSED ? 'Success' : 'Fail';
        const hasTitle = request.Name && !request.Name.match(CONTENT_PATTERNS.HTTP_METHOD_URL);
        if (hasTitle) {
            return `<div class="request-header">
                <h3>${this.escapeHtml(request.Name)}</h3>
                <span class="status ${request.Status.toLowerCase()}">${statusText}</span>
            </div>`;
        } else {
            return `<div class="request-header">
                <h3>${request.Request ? `${this.escapeHtml(request.Request.Method)} ${this.escapeHtml(request.Request.Url)}` : this.escapeHtml(request.Name)}</h3>
                <span class="status ${request.Status.toLowerCase()}">${statusText}</span>
            </div>`;
        }
    }

    private static renderCopyButton(targetId: string, inline = false): string {
        return `<button class="copy-btn${inline ? ' inline-copy-btn' : ''}" onclick="copyToClipboard(this, '${this.escapeHtml(targetId)}')">📋 Copy</button>`;
    }

    private static renderRequestSection(request: HttpRequestResult, idx: number): string {
        let testHtml = '';
        if (request.Tests?.length) {
            const allPassed = request.Tests.every(t => t.Passed);
            const summaryClass = allPassed ? 'test-passed-summary' : 'test-failed-summary';
            const summaryText = allPassed ? '👍 All tests passed' : '👎 Some tests failed';
            testHtml = `
                <div class="test-section">
                    <h4>Tests</h4>
                    <div class="test-summary ${summaryClass}">${summaryText}</div>
                    <ul class="test-list">
                        ${request.Tests.map(test => `
                            <li class="test-item ${test.Passed ? 'test-passed' : 'test-failed'}">
                                <span class="test-status">${test.Passed ? '✔️' : '❌'}</span>
                                <span class="test-name">${this.escapeHtml(test.Name)}</span>
                                ${test.Message ? `<span class="test-message">${this.escapeHtml(test.Message)}</span>` : ''}
                            </li>`).join('')}
                    </ul>
                </div>
            `;
        }
        if (request.Request) {
            const body = this.formatBody(request.Request.Body);
            const { Method, Url, TemplateUrl } = request.Request;
            const resolvedUrl = this.escapeHtml(Url);
            const templateUrl = this.escapeHtml(TemplateUrl || Url);
            const hasTemplate = TemplateUrl && TemplateUrl !== Url;
            
            // Request headers rendering
            const hasHeaders = request.Request.Headers && Object.keys(request.Request.Headers).length > 0;
            const headersHtml = hasHeaders ? `
                <div class="headers-container">
                    <div class="headers-toggle" onclick="toggleSection('request-headers-${idx}')">
                        <span>Request Headers</span>
                        <span class="toggle-icon">▶</span>
                    </div>
                    <div class="headers-content collapsed" id="request-headers-${idx}">
                        <pre class="headers-body">${this.formatHeaders(request.Request.Headers)}</pre>
                    </div>
                </div>` : '';
            
            return `
                <div class="section">
                    <h4>Request</h4>
                    <div class="method-url">
                        <span class="method method-${this.escapeHtml(Method.toLowerCase())}">${this.escapeHtml(Method)}</span>
                        <span class="url" id="url-${idx}" data-resolved="${resolvedUrl}" data-template="${templateUrl}">${resolvedUrl}</span>
                        ${hasTemplate && `<button class="toggle-url-btn" id="toggle-url-btn-${idx}" data-idx="${idx}">Show Variables</button>`}
                        ${this.renderCopyButton(`url-${idx}`)}
                    </div>
                    ${headersHtml}
                    ${body && `
                    <div class="body-container">
                    <div class="body-toggle" onclick="toggleSection('request-body-${idx}')">
                        <span>Request Body</span>
                        <span class="toggle-icon expanded">▼</span>
                    </div>
                    <div class="body-content" id="request-body-${idx}">
                            <div class="code-block">
                                <pre class="body json" id="request-${idx}">${body}</pre>
                                ${this.renderCopyButton(`request-${idx}`, true)}
                            </div>
                        </div>
                    </div>`}
                    ${testHtml}
                </div>`;
        } else if (request.ErrorMessage && !request.Response) {
            return `
                <div class="section">
                    <h4>Request</h4>
                    <div class="error-info">Unable to process HTTP request</div>
                    ${testHtml}
                </div>`;
        } else if (request.Name.includes('Custom CSX Tests')) {
            return testHtml;
        }
        return testHtml;
    }

    private static renderResponseSection(request: HttpRequestResult, idx: number): string {
        if (!request.Response) return '';
        const statusClass = request.Response.StatusCode >= 200 && request.Response.StatusCode < 300 ? 'success' : 'error';
        const body = this.formatBody(request.Response.Body);
        
        // Simple timing information - just show total duration
        const timingText = request.Response.Duration;
        
        // Size information
        const sizeInfo = request.Response.Size ? ` (${this.formatBytes(request.Response.Size)})` : '';
        
        // Headers rendering
        const hasHeaders = request.Response.Headers && Object.keys(request.Response.Headers).length > 0;
        const headersHtml = hasHeaders ? `
            <div class="headers-container">
                <div class="headers-toggle" onclick="toggleSection('response-headers-${idx}')">
                    <span>Response Headers</span>
                    <span class="toggle-icon">▶</span>
                </div>
                <div class="headers-content collapsed" id="response-headers-${idx}">
                    <pre class="headers-body">${this.formatHeaders(request.Response.Headers)}</pre>
                </div>
            </div>` : '';
        
        return `
            <div class="section">
                <h4>Response</h4>
                <div class="status-line">
                    <span class="status-code status-${statusClass}">${request.Response.StatusCode}</span>
                    <span class="status-text">${this.escapeHtml(request.Response.StatusText)}</span>
                    <span class="duration">${timingText}${sizeInfo}</span>
                </div>
                ${headersHtml}
                ${body && `
                <div class="body-container">
                    <div class="body-toggle" onclick="toggleSection('response-body-${idx}')">
                        <span>Response Body</span>
                        <span class="toggle-icon">▶</span>
                    </div>
                    <div class="body-content collapsed" id="response-body-${idx}">
                        <div class="code-block">
                            <pre class="body json" id="response-${idx}">${body}</pre>
                            ${this.renderCopyButton(`response-${idx}`, true)}
                        </div>
                    </div>
                </div>`}
            </div>`;
    }

    private static renderErrorSection(request: HttpRequestResult): string {
        if (!request.ErrorMessage) return '';
        return `
            <div class="section error">
                <h4>Error</h4>
                <pre class="error-message">${this.escapeHtml(request.ErrorMessage)}</pre>
            </div>`;
    }

    private static renderFallbackError(errorMessage: string): string {
        return `
            <div class="error-container">
                <div class="error-icon">⚠️</div>
                <div class="error-title">Failed to execute HTTP requests</div>
                <div class="error-message">${this.escapeHtml(errorMessage)}</div>
            </div>`;
    }

    private static getResultsContent(results: HttpRequestResults, fileUri: vscode.Uri): string {
        const fileName = path.basename(fileUri.fsPath);
        let requestsHtml = '';
        let hasRequests = false;
        
        if (results.RequestGroups?.RequestGroup) {
            const { RequestGroup } = results.RequestGroups;
            RequestGroup.forEach(group => {
                group.Requests?.forEach((request, idx) => {
                    if (request.Name.includes('Custom CSX Tests')) {
                        const allPassed = request.Tests?.every(t => t.Passed) ?? true;
                        const summaryClass = allPassed ? 'test-passed-summary' : 'test-failed-summary';
                        const summaryText = allPassed ? '👍 All tests passed' : '👎 Some tests failed';
                        const statusText = request.Status === 'Passed' ? 'Success' : 'Fail';
                        
                        requestsHtml += `
                            <div class="request-item">
                                <div class="request-header">
                                    <h3>${this.escapeHtml(request.Name)}</h3>
                                    <span class="status ${request.Status.toLowerCase()}">${statusText}</span>
                                </div>
                                <div class="request-content">
                                    <div class="test-summary ${summaryClass}">${summaryText}</div>
                                    <ul class="test-list">
                                        ${(request.Tests || []).map(test => `
                                            <li class="test-item ${test.Passed ? 'test-passed' : 'test-failed'}">
                                                <span class="test-status">${test.Passed ? '✔️' : '❌'}</span>
                                                <span class="test-name">${this.escapeHtml(test.Name)}</span>
                                ${test.Message && `<span class="test-message">${this.escapeHtml(test.Message)}</span>`}
                                            </li>
                                        `).join('')}
                                    </ul>
                                </div>
                            </div>`;
                        return;
                    }
                    
                    // Normal HTTP request processing
                    if (request.Request || request.ErrorMessage) hasRequests = true;
                    const headerHtml = this.renderRequestHeader(request);
                    const requestHtml = this.renderRequestSection(request, idx);
                    const responseHtml = this.renderResponseSection(request, idx);
                    const errorHtml = this.renderErrorSection(request);
                    
                    requestsHtml += `
                        <div class="request-item">
                            ${headerHtml}
                            <div class="request-content">
                                ${requestHtml}
                                ${responseHtml}
                                ${errorHtml}
                            </div>
                        </div>`;
                });
            });
        }

        let fallbackContent = '';
        if (!hasRequests) {
            const hasErrors = results.RequestGroups?.RequestGroup?.some(group => 
                group.Requests?.some(request => request.ErrorMessage)
            );
            if (hasErrors) {
                const errorRequest = results.RequestGroups.RequestGroup
                    .flatMap(group => group.Requests || [])
                    .find(request => request.ErrorMessage);
                fallbackContent = this.renderFallbackError(errorRequest?.ErrorMessage || ERROR_UNKNOWN);
            } else {
                fallbackContent = '<div class="no-results"><h2>No HTTP requests found</h2></div>';
            }
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
        <h1>HTTP Request Results: <span class="filename">${this.escapeHtml(fileName)}</span></h1>
        <button class="retry-btn" id="retry-btn">Retry</button>
    </div>
    ${requestsHtml || fallbackContent}
    <script>${this.getScript()}</script>
</body>
</html>`;
    }

    private static formatJsonString(jsonString: string): string {
        try {
            const obj = JSON.parse(jsonString);
            return JSON.stringify(obj, null, 2)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
                    let cls = 'number';
                    if (/^"/.test(match)) {
                        if (/:$/.test(match)) {
                            cls = 'key';
                        } else {
                            cls = 'string';
                        }
                    } else if (/true|false/.test(match)) {
                        cls = 'boolean';
                    } else if (/null/.test(match)) {
                        cls = 'null';
                    }
                    return `<span class="json-${cls}">${match}</span>`;
                });
        } catch {
            // JSON parsing failed, return original string
            return jsonString;
        }
    }

    private static formatBody(body?: string): string {
        if (!body) return '';
        // Try to pretty-print and colorize JSON
        try {
            const formatted = JSON.stringify(JSON.parse(body), null, 2);
            return this.formatJsonString(formatted);
        } catch {
            // Not valid JSON, return as-is
            return body;
        }
    }

    private static getStyles(): string {
        return `
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
            .header { margin-bottom: 30px; padding-bottom: 15px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .filename { font-style: italic; color: var(--vscode-textLink-foreground); font-family: monospace; }
            .retry-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 500; }
            .retry-btn:hover { background: var(--vscode-button-hoverBackground); }
            .loading-container { text-align: center; padding: 60px 20px; }
            .spinner { width: 40px; height: 40px; border: 4px solid var(--vscode-panel-border); border-top: 4px solid var(--vscode-button-background); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .loading-text { font-size: 16px; color: var(--vscode-descriptionForeground); }
            .error-container { padding: 30px; text-align: center; }
            .error-icon { font-size: 48px; margin-bottom: 20px; }
            .error-title { font-size: 20px; color: var(--vscode-errorForeground); margin-bottom: 15px; font-weight: bold; }
            .error-message { background: var(--vscode-textCodeBlock-background); padding: 15px; border-radius: 6px; border-left: 4px solid var(--vscode-errorForeground); font-family: monospace; text-align: left; white-space: pre-wrap; }
            .request-item { margin-bottom: 30px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
            .request-header { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-panel-border); }
            .request-header h3 { margin: 0; font-size: 16px; }
            .status { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
            .status.passed { background: var(--vscode-testing-iconPassed); color: var(--vscode-button-foreground); }
            .status.failed { background: var(--vscode-testing-iconFailed); color: var(--vscode-button-foreground); }
            .request-content { padding: 20px; }
            .section { margin-bottom: 20px; }
            .section h4 { margin: 0 0 10px 0; font-size: 14px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
            .method-url { display: flex; align-items: center; gap: 15px; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; }
            .method { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; min-width: 50px; text-align: center; color: var(--vscode-button-foreground); }
            .method-get { background: var(--vscode-terminal-ansiGreen); } .method-post { background: var(--vscode-terminal-ansiYellow); } .method-put { background: var(--vscode-terminal-ansiBlue); } .method-delete { background: var(--vscode-terminal-ansiRed); }
            .url { font-family: monospace; font-weight: 500; word-break: break-all; flex: 1; }
            .status-line { display: flex; align-items: center; gap: 15px; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; }
            .status-code { padding: 4px 8px; border-radius: 4px; font-weight: bold; min-width: 40px; text-align: center; color: var(--vscode-button-foreground); }
            .status-success { background: var(--vscode-terminal-ansiGreen); } .status-error { background: var(--vscode-terminal-ansiRed); }
            .status-text { font-weight: 500; flex: 1; }
            .duration { font-size: 12px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 3px; }
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
            .json-key { color: var(--vscode-debugTokenExpression-name) !important; font-weight: 500; }
            .json-string { color: var(--vscode-debugTokenExpression-string) !important; }
            .json-number { color: var(--vscode-debugTokenExpression-number) !important; }
            .json-boolean { color: var(--vscode-debugTokenExpression-boolean) !important; font-weight: 500; }
            .json-null { color: var(--vscode-debugTokenExpression-value) !important; font-weight: 500; font-style: italic; }
            .error-message { color: var(--vscode-errorForeground); }
            .error-info { padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; color: var(--vscode-descriptionForeground); font-style: italic; }
            .no-results { text-align: center; padding: 60px 20px; color: var(--vscode-descriptionForeground); }
            .toggle-url-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px; font-weight: 500; }
            .toggle-url-btn:hover { background: var(--vscode-button-hoverBackground); }
            .test-section { margin-top: 18px; }
            .test-section h4 { margin-bottom: 8px; }
            .test-summary { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
            .test-passed-summary { color: var(--vscode-testing-iconPassed); }
            .test-failed-summary { color: var(--vscode-testing-iconFailed); }
            .test-list { list-style: none; padding: 0; margin: 0; }
            .test-item { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px; }
            .test-passed { color: var(--vscode-testing-iconPassed); }
            .test-failed { color: var(--vscode-testing-iconFailed); font-weight: bold; }
            .test-status { font-size: 16px; margin-right: 4px; }
            .test-name { font-family: monospace; font-weight: 500; }
            .test-message { margin-left: 8px; color: var(--vscode-descriptionForeground); font-style: italic; }
            
            /* Collapsible sections */
            .headers-toggle, .body-toggle { 
                background: var(--vscode-button-secondaryBackground); 
                color: var(--vscode-button-secondaryForeground); 
                border: none; 
                border-radius: 3px; 
                padding: 4px 8px; 
                cursor: pointer; 
                font-size: 11px; 
                margin-bottom: 8px; 
                display: inline-flex; 
                align-items: center; 
                gap: 5px; 
            }
            .headers-toggle:hover, .body-toggle:hover { 
                background: var(--vscode-button-secondaryHoverBackground); 
            }
            .toggle-icon { 
                transition: transform 0.2s ease; 
                font-weight: bold; 
            }
            .toggle-icon.expanded { 
                transform: rotate(0deg); 
            }
            .headers-content, .body-content { 
                margin-top: 5px; 
            }
            .headers-content.collapsed, .body-content.collapsed { 
                display: none; 
            }
            
            /* Enhanced timing display */
            .timing-container { 
                display: flex; 
                gap: 15px; 
                align-items: center; 
                flex-wrap: wrap; 
            }
            .timing-item { 
                display: flex; 
                align-items: center; 
                gap: 5px; 
                font-size: 12px; 
            }
            .timing-label { 
                color: var(--vscode-descriptionForeground); 
                font-weight: 500; 
            }
            .timing-value { 
                color: var(--vscode-badge-foreground); 
                background: var(--vscode-badge-background); 
                padding: 2px 6px; 
                border-radius: 3px; 
                font-weight: 600; 
            }
            
            /* Size information */
            .size-info { 
                font-size: 12px; 
                color: var(--vscode-descriptionForeground); 
                margin-left: 10px; 
            }
            
            /* Headers display */
            .headers-list { 
                background: var(--vscode-textCodeBlock-background); 
                border: 1px solid var(--vscode-panel-border); 
                border-radius: 6px; 
                overflow: hidden; 
            }
            .header-item { 
                display: flex; 
                padding: 8px 12px; 
                border-bottom: 1px solid var(--vscode-panel-border); 
            }
            .header-item:last-child { 
                border-bottom: none; 
            }
            .header-name { 
                font-weight: 600; 
                color: var(--vscode-debugTokenExpression-name); 
                min-width: 150px; 
                margin-right: 15px; 
                font-family: monospace; 
            }
            .header-value { 
                font-family: monospace; 
                word-break: break-all; 
                color: var(--vscode-editor-foreground); 
            }
        `;
    }

    private static getScript(): string {
        return `
            const retryBtn = document.getElementById('retry-btn');
            retryBtn?.addEventListener('click', () => window.acquireVsCodeApi?.().postMessage({ command: 'retry' }));

            window.copyToClipboard = (btn, id) => {
                const el = document.getElementById(id);
                if (!el) return;
                const text = el.textContent || el.innerText;
                navigator.clipboard.writeText(text)
                    .then(() => setBtn(btn, '✅ Copied', 'var(--vscode-terminal-ansiGreen)'))
                    .catch(() => setBtn(btn, '❌ Failed'));
            };

            function setBtn(btn, txt, bg) {
                const orig = btn.textContent;
                btn.textContent = txt;
                if (bg) btn.style.background = bg;
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.style.background = '';
                }, 1500);
            }

            // Toggle URL logic
            document.querySelectorAll('.toggle-url-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const idx = btn.getAttribute('data-idx');
                    const urlSpan = document.getElementById('url-' + idx);
                    if (!urlSpan) return;
                    const resolved = urlSpan.getAttribute('data-resolved');
                    const template = urlSpan.getAttribute('data-template');
                    if (btn.textContent === 'Show Variables') {
                        urlSpan.textContent = template;
                        btn.textContent = 'Show Resolved';
                    } else {
                        urlSpan.textContent = resolved;
                        btn.textContent = 'Show Variables';
                    }
                });
            });

            // Toggle sections functionality
            window.toggleSection = function(sectionId) {
                const content = document.getElementById(sectionId);
                const toggleBtn = document.querySelector('[onclick*="' + sectionId + '"]');
                if (!content || !toggleBtn) return;
                
                const icon = toggleBtn.querySelector('.toggle-icon');
                if (content.classList.contains('collapsed')) {
                    content.classList.remove('collapsed');
                    if (icon) {
                        icon.classList.add('expanded');
                        icon.textContent = '▼';
                    }
                } else {
                    content.classList.add('collapsed');
                    if (icon) {
                        icon.classList.remove('expanded');
                        icon.textContent = '▶';
                    }
                }
            };
        `;
    }
}
