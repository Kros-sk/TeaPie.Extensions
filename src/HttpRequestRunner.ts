import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Status and error message constants
const STATUS_PASSED = 'Passed';
const STATUS_FAILED = 'Failed';
const ERROR_CONNECTION_REFUSED = 'Connection refused - please ensure the server is running and accessible';
const ERROR_HOST_NOT_FOUND = 'Host not found - please check the URL in your HTTP request';
const ERROR_TIMEOUT = 'Request timed out - server may be unresponsive';
const ERROR_EXECUTION_FAILED = 'HTTP request execution failed';
const ERROR_NO_REQUESTS = 'No HTTP requests were processed - check if the file contains valid HTTP requests or if there are connection issues';
const ERROR_NO_HTTP_FOUND = 'No HTTP requests were found in this file.';
const ERROR_HTTP_FAILED = 'HTTP Request Failed';
const ERROR_UNKNOWN = 'Unknown error occurred';

interface HttpRequestResults {
    RequestGroups: {
        RequestGroup: HttpRequestGroup[];
    };
}

interface HttpRequestGroup {
    Name: string;
    FilePath: string;
    Requests: HttpRequestResult[];
    Status: string;
    Duration: string;
}

interface HttpTestResult {
    Name: string;
    Passed: boolean;
    Message?: string;
}

interface InternalRequest {
    method: string;
    url: string;
    requestHeaders: { [key: string]: string };
    responseHeaders: { [key: string]: string };
    uniqueKey?: string;
    isTemporary?: boolean;
    isRetry?: boolean;
    originalRequest?: InternalRequest | null;
    title?: string | null;
    name?: string | null;
    templateUrl?: string | null;
    requestBody?: string;
    responseStatus?: number;
    responseStatusText?: string;
    responseBody?: string;
    duration?: string;
    ErrorMessage?: string;
}

interface HttpRequestResult {
    Name: string;
    Status: string;
    Duration: string;
    Request?: {
        Method: string;
        Url: string;
        TemplateUrl?: string;
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
    Tests?: HttpTestResult[];
}

export class HttpRequestRunner {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static outputChannel: vscode.OutputChannel;
    private static lastRequestId = 0;
    private static panelColumn: vscode.ViewColumn | undefined;
    private static lastHttpUri: vscode.Uri | undefined;
    private static isRunning = false;

    public static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
    }

    public static async runHttpFile(uri: vscode.Uri, forceColumn?: vscode.ViewColumn) {
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
            const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
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
            this.currentPanel.onDidDispose(() => {
                this.currentPanel = undefined;
                this.panelColumn = undefined;
                this.lastHttpUri = undefined;
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
        } finally {
            this.isRunning = false;
        }
    }

    private static mapConnectionError(errorMessage: string): string {
        if (errorMessage?.includes('ECONNREFUSED') || errorMessage?.includes('connection refused')) {
            return ERROR_CONNECTION_REFUSED;
        } else if (errorMessage?.includes('ENOTFOUND') || errorMessage?.includes('getaddrinfo')) {
            return ERROR_HOST_NOT_FOUND;
        } else if (errorMessage?.includes('timeout')) {
            return ERROR_TIMEOUT;
        }
        return ERROR_EXECUTION_FAILED;
    }

    private static async executeTeaPie(filePath: string): Promise<HttpRequestResults> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) throw new Error('No workspace folder is open');
        const currentEnv = vscode.workspace.getConfiguration().get<string>('teapie.currentEnvironment');
        const envParam = currentEnv ? ` -e "${currentEnv}"` : '';
        const command = `teapie test "${filePath}" --no-logo --verbose${envParam}`;
        try {
            const { stdout } = await execAsync(command, {
                cwd: workspaceFolder.uri.fsPath,
                timeout: 60000
            });
            const result = await this.parseOutput(stdout, filePath);
            if (!result.RequestGroups?.RequestGroup?.[0]?.Requests?.length) {
                return this.createFailedResult(filePath, ERROR_NO_REQUESTS);
            }
            return result;
        } catch (error: any) {
            if (error.stdout) {
                try {
                    const result = await this.parseOutput(error.stdout, filePath);
                    if (!result.RequestGroups?.RequestGroup?.[0]?.Requests?.length) {
                        return this.createFailedResult(filePath, this.mapConnectionError(error.message || error.toString()));
                    }
                    return result;
                } catch {}
            }
            return this.createFailedResult(filePath, this.mapConnectionError(error.message || error.toString()));
        }
    }

    private static async parseHttpFileForNames(filePath: string): Promise<Array<{name?: string, title?: string, method: string, url: string, templateUrl?: string}>> {
        const fs = await import('fs/promises');
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const result: Array<{name?: string, title?: string, method: string, url: string, templateUrl?: string}> = [];
        let lastName: string | undefined = undefined;
        let lastTitle: string | undefined = undefined;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const nameMatch = line.match(/^#\s*@name\s+(.+)/);
            if (nameMatch) {
                lastName = nameMatch[1].trim();
                continue;
            }
            const titleMatch = line.match(/^###\s+(.+)/);
            if (titleMatch) {
                lastTitle = titleMatch[1].trim();
                continue;
            }
            const methodMatch = line.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(.+)/i);
            if (methodMatch) {
                const templateUrl = methodMatch[2].trim();
                result.push({
                    name: lastName,
                    title: lastTitle,
                    method: methodMatch[1].toUpperCase(),
                    url: templateUrl,
                    templateUrl: templateUrl
                });
                lastName = undefined;
                lastTitle = undefined;
            }
        }
        return result;
    }

    private static async parseOutput(stdout: string, filePath: string): Promise<HttpRequestResults> {
        const fileName = path.basename(filePath, path.extname(filePath));
        const lines = stdout.split('\n');
        const requests: InternalRequest[] = [];
        // Map: logicalKey (method+url) => array of test results
        const requestTests: Map<string, HttpTestResult[]> = new Map();
        // Buffer for test results found before a request is finalized
        let bufferedTests: HttpTestResult[] = [];
        const pendingRequests: Map<string, InternalRequest> = new Map();
        let connectionError: string | null = null;
        let requestCounter = 0;
        let isNextRequestRetry = false;
        let foundHttpRequest = false;
        // Parse the .http file for names/titles/method/url
        const httpFileRequests = await this.parseHttpFileForNames(filePath);
        let httpFileRequestIdx = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // --- Parse test results ---
            // Supports all TeaPie test types: built-in directives, custom directives, and C# test scripts
            // Example: [12:34:56 INF] Test Passed: 'TestName' in 1 ms
            // Example: [12:34:56 ERR] Test 'TestName' failed: after 1 ms
            const testPassedMatch = line.match(/Test Passed:\s*'(.+?)'\s+in\s+\d+\s*ms/i);
            if (testPassedMatch) {
                const testName = testPassedMatch[1];
                bufferedTests.push({ Name: testName, Passed: true, Message: '' });
                continue;
            }
            
            const testFailedMatch = line.match(/Test '(.+?)' failed:/i);
            if (testFailedMatch) {
                const testName = testFailedMatch[1];
                // Look ahead for the reason on the next line
                let message = '';
                if (i + 1 < lines.length) {
                    const nextLine = lines[i + 1].trim();
                    const reasonMatch = nextLine.match(/Reason:\s*(.+)/);
                    if (reasonMatch) {
                        message = reasonMatch[1];
                    }
                }
                bufferedTests.push({ Name: testName, Passed: false, Message: message });
                continue;
            }
            if (line.match(/Start processing HTTP request/)) foundHttpRequest = true;
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
                // If there are buffered tests and at least one request has been finalized, attach them to the last finalized request
                if (bufferedTests.length > 0 && requests.length > 0) {
                    const lastReq = requests[requests.length - 1];
                    const logicalKey = `${lastReq.method} ${lastReq.url}`;
                    if (!requestTests.has(logicalKey)) requestTests.set(logicalKey, []);
                    requestTests.get(logicalKey)!.push(...bufferedTests);
                    bufferedTests = [];
                }
                const method = startMatch[1];
                const url = startMatch[2];
                let name: string | null = null;
                let title: string | null = null;
                let templateUrl: string | null = null;
                // Only assign name/title/templateUrl for user requests (not auth/token)
                const isUserRequest = !url.includes('/auth/token') && !url.includes('/token');
                if (isUserRequest && httpFileRequestIdx < httpFileRequests.length) {
                    const reqInfo = httpFileRequests[httpFileRequestIdx];
                    name = reqInfo.name || null;
                    title = reqInfo.title || null;
                    templateUrl = reqInfo.templateUrl || null;
                    httpFileRequestIdx++;
                }
                if (isNextRequestRetry) {
                    requestCounter++;
                    const retryKey = `retry_${requestCounter}_${method}_${url}`;
                    for (const [key, req] of pendingRequests.entries()) {
                        if (req.isRetry && req.method === method) {
                            pendingRequests.delete(key);
                        }
                    }
                    pendingRequests.set(retryKey, {
                        method, url, requestHeaders: {}, responseHeaders: {}, uniqueKey: retryKey, isTemporary: false, isRetry: true, originalRequest: null, title, name, templateUrl
                    });
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
                        existingRequest.title = title;
                        existingRequest.name = name;
                        existingRequest.templateUrl = templateUrl;
                        existingRequest.url = url;
                        pendingRequests.set(requestKey, existingRequest);
                    } else {
                        pendingRequests.set(requestKey, {
                            method, url, requestHeaders: {}, responseHeaders: {}, uniqueKey: requestKey, isTemporary: false, isRetry: false, title, name, templateUrl
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
                    // Attach any buffered test results to this request
                    if (bufferedTests.length > 0) {
                        const logicalKey = `${foundRequest.method} ${foundRequest.url}`;
                        if (!requestTests.has(logicalKey)) requestTests.set(logicalKey, []);
                        requestTests.get(logicalKey)!.push(...bufferedTests);
                        bufferedTests = [];
                    }
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
        // Attach any remaining buffered tests to the last finalized request (if any)
        if (bufferedTests.length > 0 && requests.length > 0) {
            const lastReq = requests[requests.length - 1];
            const logicalKey = `${lastReq.method} ${lastReq.url}`;
            if (!requestTests.has(logicalKey)) requestTests.set(logicalKey, []);
            requestTests.get(logicalKey)!.push(...bufferedTests);
            bufferedTests = [];
        }
        // Filter out duplicate requests by name (or by method+url if no name), keeping only the last occurrence
        // Improved deduplication: for each logical request (method+url), keep only the last occurrence, preferring named/title requests
        const logicalRequestsMap = new Map<string, any>();
        const nameOrTitleRequests = new Map<string, any>();
        for (let i = 0; i < requests.length; i++) {
            const req = requests[i];
            const logicalKey = `${req.method} ${req.url}`;
            if (req.name || req.title) {
                // Always prefer named/title requests for this logicalKey
                nameOrTitleRequests.set(logicalKey, req);
            } else {
                // Only set if not already set by a named/title request
                if (!nameOrTitleRequests.has(logicalKey)) {
                    logicalRequestsMap.set(logicalKey, req);
                }
            }
        }
        // Merge: prefer named/title requests, fallback to unnamed if not present
        const uniqueRequests = Array.from(nameOrTitleRequests.values());
        for (const [logicalKey, req] of logicalRequestsMap.entries()) {
            if (!nameOrTitleRequests.has(logicalKey)) {
                uniqueRequests.push(req);
            }
        }
        const requestResults: HttpRequestResult[] = uniqueRequests.map(req => {
            const resolvedUrl = req.url;
            const templateUrl = req.templateUrl || req.url;
            const logicalKey = `${req.method} ${resolvedUrl}`;
            const tests = requestTests.get(logicalKey) || [];
            
            // If any test failed, mark request as failed
            let status = req.responseStatus >= 200 && req.responseStatus < 400 ? STATUS_PASSED : STATUS_FAILED;
            if (tests.length > 0 && tests.some(t => !t.Passed)) status = STATUS_FAILED;
            
            return {
                Name: req.name ? req.name : (req.title ? req.title : `${req.method} ${resolvedUrl}`),
                Status: status,
                Duration: req.duration || '0ms',
                Request: {
                    Method: req.method,
                    Url: resolvedUrl,
                    TemplateUrl: templateUrl !== resolvedUrl ? templateUrl : undefined,
                    Headers: req.requestHeaders,
                    Body: req.requestBody
                },
                Response: req.responseStatus ? {
                    StatusCode: req.responseStatus,
                    StatusText: req.responseStatusText || 'OK',
                    Headers: req.responseHeaders,
                    Body: req.responseBody,
                    Duration: req.duration || '0ms'
                } : undefined,
                ErrorMessage: req.ErrorMessage,
                Tests: tests
            };
        });
        if (!foundHttpRequest) {
            return {
                RequestGroups: {
                    RequestGroup: [{
                        Name: fileName,
                        FilePath: filePath,
                        Requests: [{
                            Name: 'No HTTP requests found',
                            Status: STATUS_FAILED,
                            Duration: '0ms',
                            ErrorMessage: ERROR_NO_HTTP_FOUND
                        }],
                        Status: STATUS_FAILED,
                        Duration: '0s'
                    }]
                }
            };
        }
        if (connectionError && !requestResults.length) {
            requestResults.push({
                Name: ERROR_HTTP_FAILED,
                Status: STATUS_FAILED,
                Duration: '0ms',
                ErrorMessage: connectionError
            });
        }
        return {
            RequestGroups: {
                RequestGroup: [{
                    Name: fileName,
                    FilePath: filePath,
                    Requests: requestResults,
                    Status: requestResults.every(r => r.Status === STATUS_PASSED) ? STATUS_PASSED : STATUS_FAILED,
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
        this.currentPanel.webview.onDidReceiveMessage(message => {
            if (message?.command === 'retry' && this.lastHttpUri && !this.isRunning) {
                // Always use the stored split column for retry
                this.runHttpFile(this.lastHttpUri, this.panelColumn);
            }
        });
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

    // Helper to sanitize HTML
    private static escapeHtml(str: string | undefined): string {
        if (!str) return '';
        return str.replace(/[&<>'"`]/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;', '`': '&#96;'
        }[c] || c));
    }

    // Helper to render the request header
    private static renderRequestHeader(request: HttpRequestResult): string {
        const statusText = request.Status === STATUS_PASSED ? 'Success' : 'Fail';
        const hasTitle = request.Name && !request.Name.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+http/);
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

    // Helper to render the copy button
    private static renderCopyButton(targetId: string, inline = false): string {
        return `<button class="copy-btn${inline ? ' inline-copy-btn' : ''}" onclick="copyToClipboard(this, '${this.escapeHtml(targetId)}')">📋 Copy</button>`;
    }

    // Helper to render the request section, now includes test results
    private static renderRequestSection(request: HttpRequestResult, idx: number): string {
        let testHtml = '';
        if (request.Tests && request.Tests.length > 0) {
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
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
        }
        if (request.Request) {
            const body = this.formatBody(request.Request.Body);
            const resolvedUrl = this.escapeHtml(request.Request.Url);
            const templateUrl = this.escapeHtml(request.Request.TemplateUrl || request.Request.Url);
            const hasTemplate = request.Request.TemplateUrl && request.Request.TemplateUrl !== request.Request.Url;
            return `
                <div class="section">
                    <h4>Request</h4>
                    <div class="method-url">
                        <span class="method method-${this.escapeHtml(request.Request.Method.toLowerCase())}">${this.escapeHtml(request.Request.Method)}</span>
                        <span class="url" id="url-${idx}" data-resolved="${resolvedUrl}" data-template="${templateUrl}">${resolvedUrl}</span>
                        ${hasTemplate ? `<button class="toggle-url-btn" id="toggle-url-btn-${idx}" data-idx="${idx}">Show Variables</button>` : ''}
                        ${this.renderCopyButton(`url-${idx}`)}
                    </div>
                    ${body ? `
                    <div class="body-container">
                        <div class="body-header">
                            <span>Request Body</span>
                        </div>
                        <div class="code-block">
                            <pre class="body json" id="request-${idx}">${body}</pre>
                            ${this.renderCopyButton(`request-${idx}`, true)}
                        </div>
                    </div>` : ''}
                    ${testHtml}
                </div>`;
        } else if (request.ErrorMessage && !request.Response) {
            return `
                <div class="section">
                    <h4>Request</h4>
                    <div class="error-info">Unable to process HTTP request</div>
                    ${testHtml}
                </div>`;
        }
        return testHtml;
    }

    // Helper to render the response section
    private static renderResponseSection(request: HttpRequestResult, idx: number): string {
        if (!request.Response) return '';
        const statusClass = request.Response.StatusCode >= 200 && request.Response.StatusCode < 300 ? 'success' : 'error';
        const body = this.formatBody(request.Response.Body);
        return `
            <div class="section">
                <h4>Response</h4>
                <div class="status-line">
                    <span class="status-code status-${statusClass}">${request.Response.StatusCode}</span>
                    <span class="status-text">${this.escapeHtml(request.Response.StatusText)}</span>
                    <span class="duration">${this.escapeHtml(request.Response.Duration)}</span>
                </div>
                ${body ? `
                <div class="body-container">
                    <div class="body-header">
                        <span>Response Body</span>
                    </div>
                    <div class="code-block">
                        <pre class="body json" id="response-${idx}">${body}</pre>
                        ${this.renderCopyButton(`response-${idx}`, true)}
                    </div>
                </div>` : ''}
            </div>`;
    }

    // Helper to render the error section
    private static renderErrorSection(request: HttpRequestResult): string {
        if (!request.ErrorMessage) return '';
        return `
            <div class="section error">
                <h4>Error</h4>
                <pre class="error-message">${this.escapeHtml(request.ErrorMessage)}</pre>
            </div>`;
    }

    // Helper to render the fallback error container
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
            results.RequestGroups.RequestGroup.forEach(group => {
                group.Requests?.forEach((request, idx) => {
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
            .method { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; min-width: 50px; text-align: center; color: white; }
            .method-get { background: var(--vscode-terminal-ansiGreen); } .method-post { background: var(--vscode-terminal-ansiYellow); } .method-put { background: var(--vscode-terminal-ansiBlue); } .method-delete { background: var(--vscode-terminal-ansiRed); }
            .url { font-family: monospace; font-weight: 500; word-break: break-all; flex: 1; }
            .status-line { display: flex; align-items: center; gap: 15px; padding: 10px; background: var(--vscode-textCodeBlock-background); border-radius: 6px; }
            .status-code { padding: 4px 8px; border-radius: 4px; font-weight: bold; min-width: 40px; text-align: center; color: white; }
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
        `;
    }
}
