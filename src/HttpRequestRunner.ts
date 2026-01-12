import * as path from 'path';
import * as vscode from 'vscode';
import { 
    STATUS_PASSED,
    STATUS_FAILED,
    STATUS_TESTS_FAILED,
    ERROR_HTTP_FAILED,
    ERROR_UNKNOWN
} from './constants/httpResults';
import { 
    HttpRequestResults, 
    HttpRequestResult, 
    HttpTestResult 
} from './modules/HttpRequestTypes';
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
    private static readonly disposables: vscode.Disposable[] = [];

    public static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
        TeaPieExecutor.setOutputChannel(channel);
    }

    public static dispose() {
        // Dispose all tracked disposables
        this.disposables.forEach(d => {
            try {
                d.dispose();
            } catch (error) {
                this.outputChannel?.appendLine(`Warning: Failed to dispose resource: ${error}`);
            }
        });
        this.disposables.length = 0;
        
        // Clean up panel
        if (this.currentPanel) {
            this.currentPanel.dispose();
            this.currentPanel = undefined;
        }
        
        // Reset state
        this.panelColumn = undefined;
        this.lastHttpUri = undefined;
        this.lastRequestId = 0;
        this.retryHandlerDisposable = undefined;
    }

    private static currentExecution: Promise<void> | null = null;

    /**
     * Runs HTTP requests from the specified file and displays results in a webview panel.
     * @param uri - The URI of the .http file to execute
     * @param forceColumn - Optional column to force the webview to appear in
     */
    public static async runHttpFile(uri: vscode.Uri, forceColumn?: vscode.ViewColumn): Promise<void> {
        // Prevent concurrent executions by chaining promises
        if (this.currentExecution) {
            await this.currentExecution;
        }

        this.currentExecution = this._runHttpFileInternal(uri, forceColumn);
        try {
            await this.currentExecution;
        } finally {
            this.currentExecution = null;
        }
    }

    private static async _runHttpFileInternal(uri: vscode.Uri, forceColumn?: vscode.ViewColumn): Promise<void> {
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
            // Execution completed
        }
    }

    private static executeTeaPie(filePath: string): Promise<HttpRequestResults> {
        return TeaPieExecutor.executeTeaPie(filePath);
    }

    private static retryHandlerDisposable: vscode.Disposable | undefined;

    private static setupRetryHandler(uri: vscode.Uri) {
        if (!this.currentPanel) return;
        
        // Dispose existing retry handler to prevent duplicates
        if (this.retryHandlerDisposable) {
            try {
                const index = this.disposables.indexOf(this.retryHandlerDisposable);
                if (index > -1) {
                    this.disposables.splice(index, 1);
                }
                this.retryHandlerDisposable.dispose();
            } catch (error) {
                this.outputChannel?.appendLine(`Warning: Failed to dispose retry handler: ${error}`);
            }
        }
        
        this.retryHandlerDisposable = this.currentPanel.webview.onDidReceiveMessage(message => {
            if (message?.command === 'retry' && this.lastHttpUri) {
                // Always use the stored split column for retry
                this.runHttpFile(this.lastHttpUri, this.panelColumn);
            }
        });
        
        this.disposables.push(this.retryHandlerDisposable);
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

    private static formatTestMessage(message: string): string {
        if (!message || message.trim() === '') return '';
        
        // Check if message contains newlines (stack traces)
        if (message.includes('\n')) {
            const lines = message.split('\n');
            const formatted = lines.map((line, index) => {
                const trimmedLine = line.trim();
                if (!trimmedLine) return '';
                
                const escapedLine = this.escapeHtml(trimmedLine);
                
                if (index === 0) {
                    // First line is the main error message
                    return `<div class="test-message-main">${escapedLine}</div>`;
                } else if (trimmedLine.startsWith('at ')) {
                    // Stack trace lines
                    return `<div class="test-message-stacktrace">${escapedLine}</div>`;
                } else if (trimmedLine.startsWith('---')) {
                    // Stack trace separator
                    return `<div class="test-message-stacktrace">${escapedLine}</div>`;
                } else {
                    // Other detail lines
                    return `<div class="test-message-detail">${escapedLine}</div>`;
                }
            }).filter(line => line !== '').join('');
            
            return `<div class="test-message-formatted">${formatted}</div>`;
        }
        
        // Check if message contains assertion failure pattern
        const assertionPattern = /(Expected:|Actual:|Value:)/;
        if (!assertionPattern.test(message)) {
            // Simple message - display on new line
            return `<div class="test-message-formatted"><div class="test-message-detail">${this.escapeHtml(message)}</div></div>`;
        }
        
        // Split by assertion keywords and format with indentation
        const parts: string[] = [];
        let remaining = message;
        
        // Split message by keywords while preserving them
        const keywords = ['Expected:', 'Actual:', 'Value:'];
        
        for (const keyword of keywords) {
            const index = remaining.indexOf(keyword);
            if (index !== -1) {
                if (index > 0) {
                    const before = remaining.substring(0, index).trim();
                    if (before) parts.push(before);
                }
                // Find the next keyword or end of string
                let nextIndex = remaining.length;
                for (const nextKeyword of keywords) {
                    if (nextKeyword !== keyword) {
                        const idx = remaining.indexOf(nextKeyword, index + keyword.length);
                        if (idx !== -1 && idx < nextIndex) {
                            nextIndex = idx;
                        }
                    }
                }
                parts.push(remaining.substring(index, nextIndex).trim());
                remaining = remaining.substring(nextIndex);
            }
        }
        if (remaining.trim()) {
            parts.push(remaining.trim());
        }
        
        // Build formatted HTML
        const formatted = parts.map((part, index) => {
            if (index === 0) {
                // Main message - check if it contains assertion failure pattern
                const escapedPart = this.escapeHtml(part);
                const boldPattern = /(Assert\.[\w]+\(\)\s+Failure:)/;
                const formattedPart = escapedPart.replace(boldPattern, '<strong>$1</strong>');
                return `<div class="test-message-main">${formattedPart}</div>`;
            } else {
                // Assertion details with indentation - make keywords bold
                const escapedPart = this.escapeHtml(part);
                const boldKeywords = /(Expected:|Actual:|Value:)/;
                const formattedPart = escapedPart.replace(boldKeywords, '<strong>$1</strong>');
                return `<div class="test-message-detail">${formattedPart}</div>`;
            }
        }).join('');
        
        return `<div class="test-message-formatted">${formatted}</div>`;
    }

    private static formatHeaders(headers: { [key: string]: string }): string {
        if (!headers || Object.keys(headers).length === 0) return 'No headers';
        
        try {
            const jsonString = JSON.stringify(headers, null, 2);
            return this.formatJsonString(jsonString);
        } catch {
            return Object.entries(headers)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n');
        }
    }

    private static renderRequestHeader(request: HttpRequestResult): string {
        let statusText: string;
        if (request.Status === STATUS_PASSED) {
            statusText = 'Success';
        } else if (request.Status === STATUS_TESTS_FAILED) {
            statusText = 'Failed Test(s)';
        } else {
            statusText = 'Failed Request';
        }
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
                        <pre class="body json">${this.formatHeaders(request.Request.Headers)}</pre>
                    </div>
                </div>` : '';
            
            return `
                <div class="section">
                    <h4>Request</h4>
                    <div class="method-url">
                        <span class="method method-${this.escapeHtml(Method.toLowerCase())}">${this.escapeHtml(Method)}</span>
                        <span class="url" id="url-${idx}" data-resolved="${resolvedUrl}" data-template="${templateUrl}">${resolvedUrl}</span>
                        ${hasTemplate ? `<button class="toggle-url-btn" id="toggle-url-btn-${idx}" data-idx="${idx}">Show Variables</button>` : ''}
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
                </div>`;
        } else if (request.ErrorMessage && !request.Response) {
            return `
                <div class="section">
                    <h4>Request</h4>
                    <div class="error-info">Unable to process HTTP request</div>
                </div>`;
        } else if (request.Name.includes('Custom CSX Tests')) {
            return '';
        }
        return '';
    }

    private static renderTestsSection(request: HttpRequestResult): string {
        if (!request.Tests?.length) return '';
        
        // Only show inline tests in request sections (CSX tests appear separately)
        const inlineTests = request.Tests.filter(t => t.Source === 'inline' || !t.Source);
        
        if (inlineTests.length === 0) return '';
        
        const allPassed = inlineTests.every(t => t.Passed);
        const summaryClass = allPassed ? 'test-passed-summary' : 'test-failed-summary';
        const summaryText = allPassed ? '👍 All tests passed' : '<strong>👎 Some tests failed</strong>';
        
        return `
            <div class="section">
                <div class="test-section">
                    <h4>Tests</h4>
                    <div class="test-summary ${summaryClass}">${summaryText}</div>
                    <ul class="test-list">
                        ${inlineTests.map((test, index) => {
                            // Remove existing test number from name (e.g., "[2] Test name" -> "Test name")
                            const testName = test.Name.replace(/^\[\d+\]\s*/, '');
                            return `
                            <li class="test-item ${test.Passed ? 'test-passed' : 'test-failed'}">
                                <span class="test-status">${test.Passed ? '✔️' : '❌'}</span>
                                <span class="test-name">${this.escapeHtml(testName)}</span>
                                ${(typeof test.Message === 'string' && test.Message.trim() !== '') ? this.formatTestMessage(test.Message) : ''}
                            </li>`;
                        }).join('')}
                    </ul>
                </div>
            </div>
        `;
    }

    private static renderRetrySection(request: HttpRequestResult, idx: number): string {
        if (!request.RetryInfo) {
            return '';
        }

        const { strategyName, backoffType, attempts, wasRetried, actualAttempts: totalAttempts = attempts?.length || 1 } = request.RetryInfo;
        
        const actuallyRetried = wasRetried ?? (attempts && attempts.length > 1);
        const retryCount = Math.max(0, totalAttempts - 1);
        
        const initialText = retryCount > 0 ? `1 initial + ${retryCount} retr${retryCount === 1 ? 'y' : 'ies'}` : '1 initial';

        // Check if all retry attempts succeeded
        const allRetriesSucceeded = attempts?.every(a => a.success) ?? true;

        // Determine border color for retry details
        const borderColorClass = allRetriesSucceeded ? 'retry-details-success' : 'retry-details-failed';
        
        const retryDetailsHtml = `
            <div class="retry-details ${borderColorClass}">
                ${strategyName ? `<div class="retry-detail"><strong>Strategy:</strong> ${this.escapeHtml(strategyName)}</div>` : ''}
                <div class="retry-detail"><strong>Total Attempts:</strong> ${totalAttempts} (${initialText})</div>
                ${typeof request.RetryInfo.maxAttempts !== 'undefined' ? `<div class="retry-detail"><strong>Max Attempts:</strong> ${this.escapeHtml(request.RetryInfo.maxAttempts.toString())}</div>` : ''}
                ${backoffType ? `<div class="retry-detail"><strong>Backoff Type:</strong> ${this.escapeHtml(backoffType)}</div>` : ''}
                ${this.renderRetryAttempts(request.RetryInfo)}
            </div>`;

        return `
            <div class="section">
                <h4>Retry Information</h4>
                <div class="retry-container">
                    <div class="retry-toggle" onclick="toggleSection('retry-info-${idx}')">
                        <span>Details</span>
                        <span class="toggle-icon expanded">▼</span>
                    </div>
                    <div class="retry-content" id="retry-info-${idx}">
                        ${retryDetailsHtml}
                    </div>
                </div>
            </div>`;
    }

    private static renderRetryAttempts(retryInfo: import('./modules/HttpRequestTypes').RetryInfo): string {
        if (!retryInfo.attempts || retryInfo.attempts.length === 0) {
            return '';
        }

        const attemptsHtml = retryInfo.attempts.map((attempt, index) => {
            const statusIcon = attempt.success ? '✅' : '❌';
            const statusClass = attempt.success ? 'success' : 'failed';
            
            // Create styled status block for retry attempts
            let statusBlock = '';
            if (attempt.statusCode) {
                const statusCodeClass = attempt.statusCode >= 200 && attempt.statusCode < 300 ? 'success' : 'failed';
                statusBlock = `<span class="status-badge ${statusCodeClass}">${attempt.statusCode}</span>`;
                if (attempt.statusText) {
                    statusBlock += ` ${this.escapeHtml(attempt.statusText)}`;
                }
            } else {
                const errorText = attempt.errorMessage || 'Failed';
                statusBlock = `<span class="status-badge failed">${this.escapeHtml(errorText)}</span>`;
            }
            
            // Format timestamp and calculate interval
            let timeDisplay = '';
            if (attempt.timestamp) {
                try {
                    const date = new Date(attempt.timestamp);
                    const day = date.getDate().toString().padStart(2, '0');
                    const month = (date.getMonth() + 1).toString().padStart(2, '0');
                    const year = date.getFullYear();
                    const dateStr = `${day}.${month}.${year}`;
                    const timeStr = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const ms = date.getMilliseconds().toString().padStart(3, '0');
                    timeDisplay = `${dateStr} ${timeStr}.${ms}`;
                    
                    // Calculate interval from previous attempt
                    if (index > 0 && retryInfo.attempts && retryInfo.attempts[index - 1]?.timestamp) {
                        const prevDate = new Date(retryInfo.attempts[index - 1].timestamp!);
                        const intervalMs = date.getTime() - prevDate.getTime();
                        const intervalSec = (intervalMs / 1000).toFixed(1);
                        timeDisplay += ` <span class="attempt-interval">(+${intervalSec}s)</span>`;
                    }
                } catch {
                    timeDisplay = attempt.timestamp;
                }
            }
            
            return `
                <div class="retry-attempt ${statusClass}">
                    <span class="attempt-status">${statusBlock}</span>
                    ${timeDisplay ? `<span class="attempt-time">${timeDisplay}</span>` : ''}
                </div>`;
        }).join('');

        return `
            <div class="retry-attempts">
                ${attemptsHtml}
            </div>`;
    }

    private static renderResponseSection(request: HttpRequestResult, idx: number): string {
        if (!request.Response) return '';
        const statusClass = request.Response.StatusCode >= 200 && request.Response.StatusCode < 300 ? 'success' : 'error';
        const body = this.formatBody(request.Response.Body);
        
        // Simple timing information - just show total duration
        const timingText = request.Response.Duration;
        
        // Headers rendering
        const hasHeaders = request.Response.Headers && Object.keys(request.Response.Headers).length > 0;
        const headersHtml = hasHeaders ? `
            <div class="headers-container">
                <div class="headers-toggle" onclick="toggleSection('response-headers-${idx}')">
                    <span>Response Headers</span>
                    <span class="toggle-icon">▶</span>
                </div>
                <div class="headers-content collapsed" id="response-headers-${idx}">
                    <pre class="body json">${this.formatHeaders(request.Response.Headers)}</pre>
                </div>
            </div>` : '';
        
        // Make response body visible by default if it exists
        const bodyCollapseClass = body ? '' : 'collapsed';
        const toggleIcon = body ? '▼' : '▶';
        
        return `
            <div class="section">
                <h4>Response</h4>
                <div class="status-line">
                    <span class="status-code status-${statusClass}">${request.Response.StatusCode}</span>
                    <span class="status-text">${this.escapeHtml(request.Response.StatusText)}</span>
                    <span class="duration">${timingText}</span>
                </div>
                ${headersHtml}
                ${body && `
                <div class="body-container">
                    <div class="body-toggle" onclick="toggleSection('response-body-${idx}')">
                        <span>Response Body</span>
                        <span class="toggle-icon">${toggleIcon}</span>
                    </div>
                    <div class="body-content ${bodyCollapseClass}" id="response-body-${idx}">
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
        let renderedRequests = 0;
        
        if (results.RequestGroups?.RequestGroup) {
            const { RequestGroup } = results.RequestGroups;
            RequestGroup.forEach(group => {
                group.Requests?.forEach((request, idx) => {
                    if (request.Name.includes('Custom CSX Tests')) {
                        const allPassed = request.Tests?.every(t => t.Passed) ?? true;
                        const summaryClass = allPassed ? 'test-passed-summary' : 'test-failed-summary';
                        const summaryText = allPassed ? '👍 All tests passed' : '<strong>👎 Some tests failed</strong>';
                        const statusText = request.Status === 'Passed' ? 'Success' : 'Fail';
                        
                        requestsHtml += `
                            <div class="request-item">
                                <div class="request-header">
                                    <h3>Other Tests</h3>
                                    <span class="status ${request.Status.toLowerCase()}">${statusText}</span>
                                </div>
                                <div class="request-content">
                                    <div class="test-summary ${summaryClass}">${summaryText}</div>
                                    <ul class="test-list">
                                        ${(request.Tests || []).map(test => `
                                            <li class="test-item ${test.Passed ? 'test-passed' : 'test-failed'}">
                                                <span class="test-status">${test.Passed ? '✔️' : '❌'}</span>
                                                <span class="test-name">${this.escapeHtml(test.Name)}</span>
                                                ${(typeof test.Message === 'string' && test.Message.trim() !== '') ? this.formatTestMessage(test.Message) : ''}
                                            </li>
                                        `).join('')}
                                    </ul>
                                </div>
                            </div>`;
                        renderedRequests++;
                        return;
                    }
                    // Normal HTTP request processing
                    if (request.Request || request.ErrorMessage || (request.Tests && request.Tests.length > 0)) renderedRequests++;
                    const headerHtml = this.renderRequestHeader(request);
                    const requestHtml = this.renderRequestSection(request, idx);
                    const retryHtml = this.renderRetrySection(request, idx);
                    const responseHtml = this.renderResponseSection(request, idx);
                    const testsHtml = this.renderTestsSection(request);
                    const errorHtml = this.renderErrorSection(request);
                    
                    requestsHtml += `
                        <div class="request-item">
                            ${headerHtml}
                            <div class="request-content">
                                ${requestHtml}
                                ${retryHtml}
                                ${responseHtml}
                                ${testsHtml}
                                ${errorHtml}
                            </div>
                        </div>`;
                });
            });
        }

        let fallbackContent = '';
        if (renderedRequests === 0) {
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
            body { 
                font-family: var(--vscode-font-family); 
                margin: 0; 
                padding: var(--vscode-editor-font-size); 
                color: var(--vscode-foreground); 
                background: var(--vscode-editor-background); 
                font-size: var(--vscode-editor-font-size);
                line-height: var(--vscode-editor-line-height);
            }
            .header { 
                margin-bottom: 2em; 
                padding-bottom: 1em; 
                border-bottom: 1px solid var(--vscode-panel-border); 
                display: flex; 
                justify-content: space-between; 
                align-items: center; 
            }
            .header h1 { 
                margin: 0; 
                font-size: 1.5em; 
                font-weight: var(--vscode-font-weight);
            }
            .filename { 
                font-style: italic; 
                color: var(--vscode-textLink-foreground); 
                font-family: var(--vscode-editor-font-family); 
                font-weight: bold;
            }
            .retry-btn { 
                background: var(--vscode-button-background); 
                color: var(--vscode-button-foreground); 
                border: none; 
                border-radius: 0.25em; 
                padding: 0.5em 1em; 
                cursor: pointer; 
                font-size: 1em; 
                font-weight: 500; 
                font-family: var(--vscode-font-family);
            }
            .retry-btn:hover { 
                background: var(--vscode-button-hoverBackground); 
            }
            .loading-container { 
                text-align: center; 
                padding: 3em 1em; 
            }
            .spinner { 
                width: 2.5em; 
                height: 2.5em; 
                border: 0.25em solid var(--vscode-panel-border); 
                border-top: 0.25em solid var(--vscode-button-background); 
                border-radius: 50%; 
                animation: spin 1s linear infinite; 
                margin: 0 auto 1em; 
            }
            @keyframes spin { 
                0% { transform: rotate(0deg); } 
                100% { transform: rotate(360deg); } 
            }
            .loading-text { 
                font-size: 1em; 
                color: var(--vscode-descriptionForeground); 
            }
            .error-container { 
                padding: 2em; 
                text-align: center; 
            }
            .error-icon { 
                font-size: 3em; 
                margin-bottom: 1em; 
            }
            .error-title { 
                font-size: 1.25em; 
                color: var(--vscode-errorForeground); 
                margin-bottom: 1em; 
                font-weight: bold; 
            }
            .error-message { 
                background: var(--vscode-textCodeBlock-background); 
                padding: 1em; 
                border-radius: 0.375em; 
                border-left: 0.25em solid var(--vscode-errorForeground); 
                font-family: var(--vscode-editor-font-family); 
                text-align: left; 
                white-space: pre-wrap; 
            }
            .request-item { 
                margin-bottom: 2em; 
                border: 1px solid var(--vscode-panel-border); 
                border-radius: 0.5em; 
                overflow: hidden; 
            }
            .request-header { 
                display: flex; 
                justify-content: space-between; 
                align-items: center; 
                padding: 1em 1.25em; 
                background: var(--vscode-editor-inactiveSelectionBackground); 
                border-bottom: 1px solid var(--vscode-panel-border); 
            }
            .request-header h3 { 
                margin: 0; 
                font-size: 1em; 
                font-weight: bold;
            }
            .status { 
                padding: 0.25em 0.5em; 
                border-radius: 0.25em; 
                font-size: 1em; 
                font-weight: bold; 
                text-transform: uppercase; 
            }
            .status.passed { 
                background: var(--vscode-testing-iconPassed); 
                color: var(--vscode-button-foreground); 
            }
            .status.testsfailed { 
                background: var(--vscode-terminal-ansiYellow); 
                color: var(--vscode-button-foreground); 
            }
            .status.failed { 
                background: var(--vscode-testing-iconFailed); 
                color: var(--vscode-button-foreground); 
            }
            .status-badge { 
                padding: 0.25em 0.5em; 
                border-radius: 0.25em; 
                font-size: 0.8em; 
                font-weight: bold; 
                text-transform: uppercase; 
                display: inline-block;
            }
            .status-badge.success { 
                background: var(--vscode-testing-iconPassed); 
                color: var(--vscode-button-foreground); 
            }
            .status-badge.failed { 
                background: var(--vscode-testing-iconFailed); 
                color: var(--vscode-button-foreground); 
            }
            .request-content { 
                padding: 1.25em; 
            }
            .section { 
                margin-bottom: 1.25em; 
            }
            .section h4 { 
                margin: 0 0 0.625em 0; 
                font-size: 1em; 
                font-weight: 600; 
                color: var(--vscode-descriptionForeground); 
                text-transform: uppercase; 
            }
            .method-url { 
                display: flex; 
                align-items: center; 
                gap: 1em; 
                padding: 0.625em; 
                background: var(--vscode-textCodeBlock-background); 
                border-radius: 0.375em; 
            }
            .method { 
                padding: 0.25em 0.5em; 
                border-radius: 0.25em; 
                font-size: 1em; 
                font-weight: bold; 
                text-transform: uppercase; 
                min-width: 3em; 
                text-align: center; 
                color: var(--vscode-button-foreground); 
            }
            .method-get { background: var(--vscode-terminal-ansiGreen); } 
            .method-post { background: var(--vscode-terminal-ansiYellow); } 
            .method-put { background: var(--vscode-terminal-ansiBlue); } 
            .method-delete { background: var(--vscode-terminal-ansiRed); }
            .url { 
                font-family: var(--vscode-editor-font-family); 
                font-weight: 500; 
                word-break: break-all; 
                flex: 1; 
            }
            .status-line { 
                display: flex; 
                align-items: center; 
                gap: 1em; 
                padding: 0.625em; 
                background: var(--vscode-textCodeBlock-background); 
                border-radius: 0.375em; 
            }
            .status-code { 
                padding: 0.25em 0.5em; 
                border-radius: 0.25em; 
                font-weight: bold; 
                min-width: 2.5em; 
                text-align: center; 
                color: var(--vscode-button-foreground); 
            }
            .status-success { background: var(--vscode-terminal-ansiGreen); } 
            .status-error { background: var(--vscode-terminal-ansiRed); }
            .status-text { 
                font-weight: 500; 
                flex: 1; 
            }
            .duration { 
                font-size: 1em; 
                color: var(--vscode-descriptionForeground); 
            }
            .body-container { 
                margin-top: 0.625em; 
            }
            .code-block { 
                position: relative; 
            }
            .copy-btn { 
                background: var(--vscode-button-secondaryBackground); 
                color: var(--vscode-button-secondaryForeground); 
                border: none; 
                border-radius: 0.1875em; 
                padding: 0.25em 0.5em; 
                cursor: pointer; 
                font-size: 1em; 
                font-family: var(--vscode-font-family);
            }
            .copy-btn:hover { 
                background: var(--vscode-button-secondaryHoverBackground); 
            }
            .inline-copy-btn { 
                position: absolute; 
                top: 0.5em; 
                right: 0.5em; 
                background: var(--vscode-button-secondaryBackground); 
                color: var(--vscode-button-secondaryForeground); 
            }
            .inline-copy-btn:hover { 
                background: var(--vscode-button-secondaryHoverBackground); 
            }
            pre.body { 
                background: var(--vscode-textCodeBlock-background); 
                padding: 1em; 
                border-radius: 0.375em; 
                overflow-x: auto; 
                font-family: var(--vscode-editor-font-family); 
                font-size: 1em; 
                margin: 0; 
                white-space: pre-wrap; 
                border: 1px solid var(--vscode-panel-border); 
            }
            pre.body.json { 
                color: var(--vscode-editor-foreground); 
            }
            .json-key { 
                color: var(--vscode-debugTokenExpression-name) !important; 
                font-weight: 500; 
            }
            .json-string { 
                color: var(--vscode-debugTokenExpression-string) !important; 
            }
            .json-number { 
                color: var(--vscode-debugTokenExpression-number) !important; 
            }
            .json-boolean { 
                color: var(--vscode-debugTokenExpression-boolean) !important; 
                font-weight: 500; 
            }
            .json-null { 
                color: var(--vscode-debugTokenExpression-value) !important; 
                font-weight: 500; 
                font-style: italic; 
            }
            .error-message { 
                color: var(--vscode-errorForeground); 
            }
            .error-info { 
                padding: 0.625em; 
                background: var(--vscode-textCodeBlock-background); 
                border-radius: 0.375em; 
                color: var(--vscode-descriptionForeground); 
                font-style: italic; 
            }
            .no-results { 
                text-align: center; 
                padding: 3.75em 1.25em; 
                color: var(--vscode-descriptionForeground); 
            }
            .toggle-url-btn { 
                background: var(--vscode-button-background); 
                color: var(--vscode-button-foreground); 
                border: none; 
                border-radius: 0.25em; 
                padding: 0.25em 0.5em; 
                cursor: pointer; 
                font-size: 1em; 
                font-weight: 500; 
                font-family: var(--vscode-font-family);
            }
            .toggle-url-btn:hover { 
                background: var(--vscode-button-hoverBackground); 
            }
            .test-section { 
                margin-top: 1.125em; 
            }
            .test-section h4 { 
                margin-bottom: 0.5em; 
            }
            .test-summary { 
                font-size: 1em; 
                font-weight: 600; 
                margin-bottom: 0.375em; 
            }
            .test-passed-summary { 
                color: var(--vscode-testing-iconPassed); 
            }
            .test-failed-summary { 
                color: var(--vscode-testing-iconFailed); 
            }
            .test-list { 
                list-style: none; 
                padding: 0; 
                margin: 0; 
            }
            .test-item { 
                display: flex; 
                align-items: flex-start; 
                gap: 0.625em; 
                padding: 0.375em 0; 
                font-size: 1em; 
                flex-wrap: wrap;
            }
            .test-passed { 
                color: var(--vscode-testing-iconPassed); 
            }
            .test-failed { 
                color: var(--vscode-testing-iconFailed); 
                font-weight: bold; 
            }
            .test-status { 
                font-size: 1em; 
                margin-right: 0.25em; 
            }
            .test-name { 
                font-family: var(--vscode-editor-font-family); 
                font-weight: 500; 
            }
            .test-message { 
                margin-left: 0.5em; 
                color: var(--vscode-descriptionForeground); 
                font-style: italic; 
            }
            .test-message-formatted {
                flex-basis: 100%;
                margin-left: 2em;
                margin-top: 0.25em;
                color: var(--vscode-descriptionForeground);
                font-family: var(--vscode-editor-font-family);
            }
            .test-message-main {
                margin-bottom: 0.25em;
                color: var(--vscode-descriptionForeground);
                font-family: var(--vscode-editor-font-family);
            }
            .test-message-main strong {
                font-weight: bold;
                color: var(--vscode-descriptionForeground);
            }
            .test-message-detail {
                margin-left: 1em;
                font-family: var(--vscode-editor-font-family);
                font-size: 1em;
                padding: 0.125em 0;
                color: var(--vscode-descriptionForeground);
            }
            .test-message-detail strong {
                font-weight: bold;
                color: var(--vscode-descriptionForeground);
            }
            .test-message-stacktrace {
                margin-left: 1.5em;
                font-family: var(--vscode-editor-font-family);
                font-size: 0.9em;
                padding: 0.125em 0;
                color: var(--vscode-descriptionForeground);
                opacity: 0.8;
            }
            
            /* Collapsible sections */
            .headers-container {
                margin-top: 0.75em;
            }
            .headers-toggle, .body-toggle { 
                background: var(--vscode-button-secondaryBackground); 
                color: var(--vscode-button-secondaryForeground); 
                border: none; 
                border-radius: 0.1875em; 
                padding: 0.25em 0.5em; 
                cursor: pointer; 
                font-size: 1em; 
                margin-bottom: 0.5em; 
                display: inline-flex; 
                align-items: center; 
                gap: 0.3125em; 
                font-family: var(--vscode-font-family);
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
                margin-top: 0.3125em; 
            }
            .headers-content.collapsed, .body-content.collapsed { 
                display: none; 
            }
            
            /* Retry section styles */
            .retry-container { 
                margin-top: 0.625em; 
            }
            .retry-toggle { 
                background: var(--vscode-button-secondaryBackground); 
                color: var(--vscode-button-secondaryForeground); 
                border: none; 
                border-radius: 0.1875em; 
                padding: 0.25em 0.5em; 
                cursor: pointer; 
                font-size: 1em; 
                margin-bottom: 0.5em; 
                display: inline-flex; 
                align-items: center; 
                gap: 0.3125em; 
                font-family: var(--vscode-font-family);
            }
            .retry-toggle:hover { 
                background: var(--vscode-button-secondaryHoverBackground); 
            }
            .retry-content { 
                margin-top: 0.3125em; 
            }
            .retry-content.collapsed { 
                display: none; 
            }
            .retry-status { 
                display: flex; 
                align-items: center; 
                gap: 0.5em; 
                padding: 0.5em 0.75em; 
                border-radius: 0.25em; 
                margin-bottom: 0.5em; 
                font-size: 1em; 
                font-weight: 500; 
            }
            .retry-status.retried-success { 
                background: var(--vscode-terminal-ansiGreen); 
                color: var(--vscode-button-foreground); 
            }
            .retry-status.retried-failed { 
                background: var(--vscode-terminal-ansiRed); 
                color: var(--vscode-button-foreground); 
            }
            .retry-status.single { 
                background: var(--vscode-terminal-ansiGreen); 
                color: var(--vscode-button-foreground); 
            }
            .retry-icon { 
                font-size: 1em; 
            }
            .retry-details { 
                background: var(--vscode-textCodeBlock-background); 
                padding: 0.625em; 
                border-radius: 0.25em; 
            }
            .retry-details-success { 
                border-left: 0.1875em solid var(--vscode-terminal-ansiGreen); 
            }
            .retry-details-failed { 
                border-left: 0.1875em solid var(--vscode-terminal-ansiRed); 
            }
            .retry-detail { 
                margin-bottom: 0.25em; 
                font-size: 1em; 
            }
            .retry-detail:last-child { 
                margin-bottom: 0; 
            }
            
            /* Retry attempts styles */
            .retry-attempts {
                margin-top: 0.625em;
                padding: 0.5em;
                background: var(--vscode-editor-background);
                border-radius: 0.25em;
                border: 1px solid var(--vscode-panel-border);
            }
            .retry-attempts-header {
                margin-bottom: 0.5em;
                font-size: 1em;
                color: var(--vscode-foreground);
            }
            .retry-attempt {
                display: flex;
                align-items: center;
                gap: 0.5em;
                padding: 0.25em 0.5em;
                margin: 0.125em 0;
                border-radius: 0.1875em;
                font-size: 1em;
                font-family: var(--vscode-editor-font-family);
            }
            .retry-attempt.success {
                background: var(--vscode-textCodeBlock-background);
                border-left: 0.1875em solid var(--vscode-terminal-ansiGreen);
            }
            .retry-attempt.failed {
                background: var(--vscode-textCodeBlock-background);
                border-left: 0.1875em solid var(--vscode-terminal-ansiRed);
            }
            .attempt-icon {
                font-size: 1em;
                min-width: 1em;
            }
            .attempt-number {
                font-weight: bold;
                min-width: 4.375em;
                color: var(--vscode-foreground);
            }
            .attempt-status {
                color: var(--vscode-foreground);
            }
            .attempt-time {
                font-size: 1em;
                color: var(--vscode-descriptionForeground);
                font-family: var(--vscode-editor-font-family);
                margin-left: auto;
            }
            .attempt-interval {
                font-size: 0.9em;
                color: var(--vscode-descriptionForeground);
                opacity: 0.7;
                font-style: italic;
                display: inline-block;
                min-width: 4em;
            }
        `;
    }

    private static getScript(): string {
        return `
            const retryBtn = document.getElementById('retry-btn');
            retryBtn?.addEventListener('click', () => window.acquireVsCodeApi?.().postMessage({ command: 'retry' }));

            const buttonTimeouts = new Map();
            const buttonOriginalText = new Map();

            window.copyToClipboard = (btn, id) => {
                const el = document.getElementById(id);
                if (!el) return;
                const text = el.textContent || el.innerText;
                
                // Ensure window has focus before attempting clipboard access
                window.focus();
                btn.focus();
                
                // Try modern clipboard API first
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text)
                        .then(() => setBtn(btn, '✅ Copied', 'var(--vscode-terminal-ansiGreen)'))
                        .catch(() => {
                            // Fallback to older method if clipboard API fails
                            if (fallbackCopy(text)) {
                                setBtn(btn, '✅ Copied', 'var(--vscode-terminal-ansiGreen)');
                            } else {
                                setBtn(btn, '❌ Failed');
                            }
                        });
                } else {
                    // Use fallback for older browsers
                    if (fallbackCopy(text)) {
                        setBtn(btn, '✅ Copied', 'var(--vscode-terminal-ansiGreen)');
                    } else {
                        setBtn(btn, '❌ Failed');
                    }
                }
            };

            function fallbackCopy(text) {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    const successful = document.execCommand('copy');
                    document.body.removeChild(textarea);
                    return successful;
                } catch (err) {
                    document.body.removeChild(textarea);
                    return false;
                }
            }

            function setBtn(btn, txt, bg) {
                // Store original text if not already stored
                if (!buttonOriginalText.has(btn)) {
                    buttonOriginalText.set(btn, btn.textContent);
                }
                const orig = buttonOriginalText.get(btn);
                
                // Clear any existing timeout
                if (buttonTimeouts.has(btn)) {
                    clearTimeout(buttonTimeouts.get(btn));
                }
                
                btn.textContent = txt;
                if (bg) {
                    btn.style.background = bg;
                    btn.style.color = 'white';
                }
                
                const timeoutId = setTimeout(() => {
                    btn.textContent = orig;
                    btn.style.background = '';
                    btn.style.color = '';
                    buttonTimeouts.delete(btn);
                    buttonOriginalText.delete(btn);
                }, 1500);
                
                buttonTimeouts.set(btn, timeoutId);
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
