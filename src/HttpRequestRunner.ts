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
    private static lastRequestId = 0;

    public static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
    }

    public static async runHttpFile(uri: vscode.Uri) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        const targetColumn = column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;

        if (this.currentPanel) {
            this.currentPanel.reveal(targetColumn);
        } else {
            this.currentPanel = vscode.window.createWebviewPanel(
                'httpRequestResults',
                'HTTP Request Results',
                targetColumn,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );
            this.currentPanel.onDidDispose(() => {
                this.currentPanel = undefined;
            });
        }

        // Generate a unique request ID for this execution
        const requestId = ++this.lastRequestId;
        // Show loading state and disable retry button
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
            this.outputChannel.appendLine(errorMessage);
            if (this.currentPanel && requestId === this.lastRequestId) {
                this.currentPanel.webview.html = this.getErrorContent(uri, errorMessage);
                this.setupRetryHandler(uri);
            }
            vscode.window.showErrorMessage(errorMessage);
        }
    }

    private static mapConnectionError(errorMessage: string): string {
        if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connection refused')) {
            return 'Connection refused - please ensure the server is running and accessible';
        } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
            return 'Host not found - please check the URL in your HTTP request';
        } else if (errorMessage.includes('timeout')) {
            return 'Request timed out - server may be unresponsive';
        }
        return 'HTTP request execution failed';
    }

    private static async executeTeaPie(filePath: string): Promise<TeaPieResult> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) throw new Error('No workspace folder is open');
        const currentEnv = vscode.workspace.getConfiguration().get<string>('teapie.currentEnvironment');
        const envParam = currentEnv ? ` -e "${currentEnv}"` : '';
        const command = `teapie test "${filePath}" --no-logo --verbose${envParam}`;
        this.outputChannel.appendLine(`Executing: ${command}`);
        try {
            const { stdout } = await execAsync(command, {
                cwd: workspaceFolder.uri.fsPath,
                timeout: 60000
            });
            this.outputChannel.appendLine('==================== RAW TEAPIE OUTPUT ====================');
            this.outputChannel.appendLine(stdout);
            this.outputChannel.appendLine('==================== END TEAPIE OUTPUT ====================');
            const result = this.parseOutput(stdout, filePath);
            if (!result.TestSuites.TestSuite[0].Tests.length) {
                return this.createFailedResult(filePath, 'No HTTP requests were processed - check if the file contains valid HTTP requests or if there are connection issues');
            }
            return result;
        } catch (error: any) {
            if (error.stdout) {
                try {
                    const result = this.parseOutput(error.stdout, filePath);
                    if (!result.TestSuites.TestSuite[0].Tests.length) {
                        return this.createFailedResult(filePath, this.mapConnectionError(error.message || error.toString()));
                    }
                    return result;
                } catch {}
            }
            return this.createFailedResult(filePath, this.mapConnectionError(error.message || error.toString()));
        }
    }

    private static parseOutput(stdout: string, filePath: string): TeaPieResult {
        const fileName = path.basename(filePath, path.extname(filePath));
        const lines = stdout.split('\n');
        const requests: any[] = [];
        const pendingRequests: Map<string, any> = new Map();
        let connectionError: string | null = null;
        let requestCounter = 0;
        let isNextRequestRetry = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('DBG] Retry attempt number')) { isNextRequestRetry = true; continue; }
            if (line.includes('No connection could be made because the target machine actively refused it')) {
                const urlMatch = line.match(/\(([^)]+)\)/);
                const url = urlMatch ? urlMatch[1] : 'unknown host';
                connectionError = `Connection refused to ${url} - please ensure the server is running and accessible`;
                continue;
            }
            if (line.includes('[') && line.includes('ERR]') && line.includes('Exception was thrown during execution')) {
                for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                    const errorLine = lines[j].trim();
                    if (errorLine.includes('No connection could be made because the target machine actively refused it')) {
                        const urlMatch = errorLine.match(/\(([^)]+)\)/);
                        const url = urlMatch ? urlMatch[1] : 'unknown host';
                        connectionError = `Connection refused to ${url} - please ensure the server is running and accessible`;
                        break;
                    } else if (errorLine.includes('getaddrinfo')) {
                        connectionError = 'Host not found - please check the URL in your HTTP request';
                        break;
                    } else if (errorLine.includes('timeout') || errorLine.includes('timed out')) {
                        connectionError = 'Request timed out - server may be unresponsive';
                        break;
                    }
                }
                if (!connectionError) connectionError = 'HTTP request execution failed';
                continue;
            }
            const startMatch = line.match(/Start processing HTTP request (\w+)\s+(.+)/);
            if (startMatch) {
                const method = startMatch[1];
                const url = startMatch[2];
                if (isNextRequestRetry) {
                    let originalRequest = null;
                    for (const [, request] of Array.from(pendingRequests.entries()).reverse()) {
                        if (request.method === method && request.url === url && request.duration) {
                            originalRequest = request;
                            break;
                        }
                    }
                    if (!originalRequest) {
                        for (let j = requests.length - 1; j >= 0; j--) {
                            const req = requests[j];
                            if (req.method === method && req.url === url) {
                                originalRequest = req;
                                break;
                            }
                        }
                    }
                    if (originalRequest) {
                        requestCounter++;
                        const retryKey = `retry_${requestCounter}_${method}_${url}`;
                        pendingRequests.set(retryKey, {
                            method, url, requestHeaders: {}, responseHeaders: {}, uniqueKey: retryKey, isTemporary: false, isRetry: true, originalRequest
                        });
                    }
                    isNextRequestRetry = false;
                } else {
                    requestCounter++;
                    const requestKey = `req_${requestCounter}_${method}_${url}`;
                    let existingRequest = null;
                    if (url.includes('/auth/token') || url.includes('/token')) {
                        for (const [key, req] of pendingRequests.entries()) {
                            if (req.method === method && req.url === url && req.isTemporary) {
                                existingRequest = req;
                                pendingRequests.delete(key);
                                break;
                            }
                        }
                    }
                    if (existingRequest) {
                        existingRequest.isTemporary = false;
                        existingRequest.uniqueKey = requestKey;
                        pendingRequests.set(requestKey, existingRequest);
                    } else {
                        pendingRequests.set(requestKey, {
                            method, url, requestHeaders: {}, responseHeaders: {}, uniqueKey: requestKey, isTemporary: false, isRetry: false
                        });
                    }
                }
                continue;
            }
            if (line.includes("Following HTTP request's body")) {
                const requestBody = this.extractBody(lines, i);
                let targetRequest = null;
                let targetKey = null;
                const isAuthBody = requestBody.includes('grant_type=') || requestBody.includes('client_id=') || requestBody.includes('client_secret=');
                const isJsonBody = requestBody.trim().startsWith('{') && requestBody.trim().endsWith('}');
                if (isAuthBody) {
                    for (const [key, request] of pendingRequests.entries()) {
                        if ((key.includes('/auth/token') || key.includes('/token')) && !request.requestBody) {
                            targetRequest = request;
                            targetKey = key;
                            break;
                        }
                    }
                    if (!targetRequest) {
                        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
                            const futureStartMatch = lines[j].trim().match(/Start processing HTTP request (\w+)\s+(.+)/);
                            if (futureStartMatch) {
                                const futureUrl = futureStartMatch[2];
                                if (futureUrl.includes('/auth/token') || futureUrl.includes('/token')) {
                                    const tempKey = `temp_auth_${futureStartMatch[1]}_${futureUrl}`;
                                    pendingRequests.set(tempKey, {
                                        method: futureStartMatch[1], url: futureUrl, requestHeaders: {}, responseHeaders: {}, requestBody, isTemporary: true
                                    });
                                    targetRequest = pendingRequests.get(tempKey);
                                    targetKey = tempKey;
                                    break;
                                }
                            }
                        }
                    }
                } else if (isJsonBody) {
                    for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                        if (!key.includes('/auth/token') && !key.includes('/token') &&
                            (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') &&
                            !request.requestBody && !request.isRetry) {
                            targetRequest = request;
                            targetKey = key;
                            break;
                        }
                    }
                } else {
                    for (let j = i - 1; j >= 0; j--) {
                        const backLine = lines[j].trim();
                        const backStartMatch = backLine.match(/Start processing HTTP request (\w+)\s+(.+)/);
                        if (backStartMatch) {
                            const backKey = `${backStartMatch[1]} ${backStartMatch[2]}`;
                            const backRequest = pendingRequests.get(backKey);
                            if (backRequest && !backRequest.requestBody) {
                                targetRequest = backRequest;
                                targetKey = backKey;
                                break;
                            }
                        }
                    }
                }
                if (targetRequest && targetKey) targetRequest.requestBody = requestBody;
                continue;
            }
            const responseMatch = line.match(/HTTP Response (\d+) \(([^)]+)\) was received from '([^']+)'/);
            if (responseMatch) {
                const statusCode = parseInt(responseMatch[1]);
                const statusText = responseMatch[2];
                const responseUrl = responseMatch[3];
                let targetRequest = null;
                let targetKey = null;
                for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                    if (request.url === responseUrl && !request.responseStatus) {
                        targetRequest = request;
                        targetKey = key;
                        break;
                    }
                }
                if (targetRequest && targetKey) {
                    targetRequest.responseStatus = statusCode;
                    targetRequest.responseStatusText = statusText;
                }
                continue;
            }
            if (line.includes("Response's body")) {
                const responseBody = this.extractBody(lines, i);
                let targetRequest = null;
                let targetKey = null;
                for (let j = i - 1; j >= 0; j--) {
                    const backLine = lines[j].trim();
                    const backResponseMatch = backLine.match(/HTTP Response (\d+) \(([^)]+)\) was received from '([^']+)'/);
                    if (backResponseMatch) {
                        const responseUrl = backResponseMatch[3];
                        const responseStatus = parseInt(backResponseMatch[1]);
                        for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                            if (request.url === responseUrl && request.responseStatus === responseStatus && !request.responseBody) {
                                targetRequest = request;
                                targetKey = key;
                                break;
                            }
                        }
                        if (targetRequest) break;
                    }
                }
                if (targetRequest && targetKey) targetRequest.responseBody = responseBody;
                continue;
            }
            const endMatch = line.match(/End processing HTTP request after ([\d.]+)ms - (\d+)/);
            if (endMatch) {
                const statusCode = parseInt(endMatch[2]);
                const duration = endMatch[1] + 'ms';
                let foundRequest = null;
                let foundKey = null;
                for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                    if (request.responseStatus === statusCode && !request.duration) {
                        foundRequest = request;
                        foundKey = key;
                        break;
                    }
                }
                if (!foundRequest) {
                    for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                        if (!request.duration) {
                            foundRequest = request;
                            foundKey = key;
                            foundRequest.responseStatus = statusCode;
                            break;
                        }
                    }
                }
                if (foundRequest && foundKey) {
                    foundRequest.duration = duration;
                    if (foundRequest.isRetry && foundRequest.originalRequest) {
                        foundRequest.originalRequest.responseStatus = foundRequest.responseStatus || statusCode;
                        foundRequest.originalRequest.responseStatusText = foundRequest.responseStatusText;
                        foundRequest.originalRequest.responseBody = foundRequest.responseBody;
                        foundRequest.originalRequest.duration = duration;
                        pendingRequests.delete(foundKey);
                    } else {
                        requests.push(foundRequest);
                        pendingRequests.delete(foundKey);
                    }
                }
                continue;
            }
        }
        const tests: TeaPieTest[] = requests.map(req => ({
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
        if (connectionError && !tests.length) {
            tests.push({
                Name: 'HTTP Request Failed',
                Status: 'Failed',
                Duration: '0ms',
                ErrorMessage: connectionError
            });
        }
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
        // Remove all previous listeners by resetting the webview's onDidReceiveMessage
        HttpRequestRunner.currentPanel.webview.onDidReceiveMessage(() => {});
        // Add a new listener for this file only
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

    private static getResultsContent(results: TeaPieResult, fileUri: vscode.Uri): string {
        const fileName = path.basename(fileUri.fsPath);
        let requestsHtml = '';
        let hasRequests = false;
        
        if (results.TestSuites?.TestSuite) {
            results.TestSuites.TestSuite.forEach(suite => {
                suite.Tests?.forEach((test, idx) => {
                    // Mark as having requests if it's a real HTTP request (has Request object) or if it's an error
                    if (test.Request || test.ErrorMessage) {
                        hasRequests = true;
                    }
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
                    } else if (test.ErrorMessage && !test.Response) {
                        // For error-only tests (like connection failures), show a basic request info
                        requestHtml = `
                            <div class="section">
                                <h4>Request</h4>
                                <div class="error-info">Unable to process HTTP request</div>
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

        // Check if we have no requests vs execution failure
        let fallbackContent = '';
        if (!hasRequests) {
            // Check if this was an execution failure (has error message in test)
            const hasErrors = results.TestSuites?.TestSuite?.some(suite => 
                suite.Tests?.some(test => test.ErrorMessage)
            );
            
            if (hasErrors) {
                // Show the error information
                const errorTest = results.TestSuites.TestSuite
                    .flatMap(suite => suite.Tests || [])
                    .find(test => test.ErrorMessage);
                
                fallbackContent = `
                    <div class="error-container">
                        <div class="error-icon">⚠️</div>
                        <div class="error-title">Failed to execute HTTP requests</div>
                        <div class="error-message">${errorTest?.ErrorMessage || 'Unknown error occurred'}</div>
                    </div>`;
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
        <h1>HTTP Request Results: <span class="filename">${fileName}</span></h1>
        <button class="retry-btn" id="retry-btn">Retry</button>
    </div>
    ${requestsHtml || fallbackContent}
    <script>${this.getScript()}</script>
</body>
</html>`;
    }

    private static formatBody(body?: string): string {
        if (!body) return '';
        
        try {
            const parsed = JSON.parse(body);
            const formatted = JSON.stringify(parsed, null, 2);
            
            // Enhanced JSON syntax highlighting with more comprehensive patterns
            return formatted
                // First, handle property keys (before colons)
                .replace(/"([^"]+)"(\s*:)/g, '<span class="json-key">"$1"</span>$2')
                // Handle string values (after colons, including empty strings)
                .replace(/:\s*"([^"]*)"/g, ': <span class="json-string">"$1"</span>')
                // Handle numbers (integers and floats, including negative)
                .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, ': <span class="json-number">$1</span>')
                // Handle booleans
                .replace(/:\s*(true|false)/g, ': <span class="json-boolean">$1</span>')
                // Handle null values
                .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>')
                // Handle array values (numbers, booleans, null in arrays)
                .replace(/(\[|\s+)(-?\d+\.?\d*(?:[eE][+-]?\d+)?)(\s*[,\]])/g, '$1<span class="json-number">$2</span>$3')
                .replace(/(\[|\s+)(true|false)(\s*[,\]])/g, '$1<span class="json-boolean">$2</span>$3')
                .replace(/(\[|\s+)(null)(\s*[,\]])/g, '$1<span class="json-null">$2</span>$3')
                // Handle string values in arrays
                .replace(/(\[|\s+)"([^"]*)"(\s*[,\]])/g, '$1<span class="json-string">"$2"</span>$3');
        } catch {
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
            .json-key { color: #9CDCFE !important; font-weight: 500; }
            .json-string { color: #CE9178 !important; }
            .json-number { color: #B5CEA8 !important; }
            .json-boolean { color: #569CD6 !important; font-weight: 500; }
            .json-null { color: #569CD6 !important; font-weight: 500; }
            .error-message { color: var(--vscode-terminal-ansiRed); }
            .error-info { padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; color: var(--vscode-descriptionForeground); font-style: italic; }
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
