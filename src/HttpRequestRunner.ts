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

            HttpRequestRunner.outputChannel.appendLine(`==================== RAW TEAPIE OUTPUT ====================`);
            HttpRequestRunner.outputChannel.appendLine(stdout);
            HttpRequestRunner.outputChannel.appendLine(`==================== END TEAPIE OUTPUT ====================`);
            const result = HttpRequestRunner.parseOutput(stdout, filePath);
            HttpRequestRunner.outputChannel.appendLine(`Parsed ${result.TestSuites.TestSuite[0].Tests.length} tests`);
            
            // If no tests were parsed, it might mean the requests failed before being processed
            if (result.TestSuites.TestSuite[0].Tests.length === 0) {
                return HttpRequestRunner.createFailedResult(filePath, 'No HTTP requests were processed - check if the file contains valid HTTP requests or if there are connection issues');
            }
            
            return result;
        } catch (error: any) {
            // Try to parse error output if available
            if (error.stdout) {
                try {
                    const result = HttpRequestRunner.parseOutput(error.stdout, filePath);
                    // If parsing succeeded but no tests found, it means the requests failed before being processed
                    if (result.TestSuites.TestSuite[0].Tests.length === 0) {
                        // Improve error message for common connection issues
                        let errorMessage = error.message || error.toString();
                        if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connection refused')) {
                            errorMessage = 'Connection refused - please ensure the server is running and accessible';
                        } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
                            errorMessage = 'Host not found - please check the URL in your HTTP request';
                        } else if (errorMessage.includes('timeout')) {
                            errorMessage = 'Request timed out - server may be unresponsive';
                        } else {
                            errorMessage = 'HTTP request execution failed';
                        }
                        return HttpRequestRunner.createFailedResult(filePath, errorMessage);
                    }
                    return result;
                } catch {
                    // Fall through to create failed result
                }
            }
            
            // Improve error message for common connection issues
            let errorMessage = error.message || error.toString();
            if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connection refused')) {
                errorMessage = 'Connection refused - please ensure the server is running and accessible';
            } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
                errorMessage = 'Host not found - please check the URL in your HTTP request';
            } else if (errorMessage.includes('timeout')) {
                errorMessage = 'Request timed out - server may be unresponsive';
            }
            
            return HttpRequestRunner.createFailedResult(filePath, errorMessage);
        }
    }

    private static parseOutput(stdout: string, filePath: string): TeaPieResult {
        const fileName = path.basename(filePath, path.extname(filePath));
        const lines = stdout.split('\n');
        const requests: any[] = [];
        const pendingRequests: Map<string, any> = new Map(); // Track multiple concurrent requests
        let connectionError: string | null = null;
        let requestCounter = 0; // Global counter for unique request identification
        let isNextRequestRetry = false; // Flag to detect retry attempts

        HttpRequestRunner.outputChannel.appendLine(`==================== PARSING DEBUG ====================`);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Check for retry attempt markers
            if (line.includes('DBG] Retry attempt number')) {
                isNextRequestRetry = true;
                HttpRequestRunner.outputChannel.appendLine(`Detected retry attempt marker: ${line}`);
                continue;
            }
            
            // Look for connection errors with specific details
            if (line.includes('No connection could be made because the target machine actively refused it')) {
                const urlMatch = line.match(/\(([^)]+)\)/);
                const url = urlMatch ? urlMatch[1] : 'unknown host';
                connectionError = `Connection refused to ${url} - please ensure the server is running and accessible`;
                continue;
            }
            
            // Look for other detailed error messages from TeaPie
            if (line.includes('[') && line.includes('ERR]') && line.includes('Exception was thrown during execution')) {
                // Check the next few lines for error details
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
                if (!connectionError) {
                    connectionError = 'HTTP request execution failed';
                }
                continue;
            }
            
            // Look for request start
            const startMatch = line.match(/Start processing HTTP request (\w+)\s+(.+)/);
            if (startMatch) {
                const method = startMatch[1];
                const url = startMatch[2];
                
                if (isNextRequestRetry) {
                    // This is a retry attempt - find the original request for this URL and method
                    HttpRequestRunner.outputChannel.appendLine(`Processing retry attempt for ${method} ${url}`);
                    let originalRequest = null;
                    let originalKey = null;
                    
                    // Look for the most recent completed request with the same method and URL
                    for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                        if (request.method === method && request.url === url && request.duration) {
                            originalRequest = request;
                            originalKey = key;
                            break;
                        }
                    }
                    
                    // If no completed request found, look in the completed requests array
                    if (!originalRequest) {
                        for (let j = requests.length - 1; j >= 0; j--) {
                            const req = requests[j];
                            if (req.method === method && req.url === url) {
                                originalRequest = req;
                                HttpRequestRunner.outputChannel.appendLine(`Found original request in completed requests for retry: ${method} ${url}`);
                                break;
                            }
                        }
                    }
                    
                    if (originalRequest) {
                        // Create a new pending entry for this retry that references the original
                        requestCounter++;
                        const retryKey = `retry_${requestCounter}_${method}_${url}`;
                        const retryRequest = {
                            method: method,
                            url: url,
                            requestHeaders: {},
                            responseHeaders: {},
                            uniqueKey: retryKey,
                            isTemporary: false,
                            isRetry: true,
                            originalRequest: originalRequest // Reference to original
                        };
                        pendingRequests.set(retryKey, retryRequest);
                        HttpRequestRunner.outputChannel.appendLine(`Created retry request: ${retryKey} (referencing original)`);
                    } else {
                        HttpRequestRunner.outputChannel.appendLine(`Could not find original request for retry: ${method} ${url}`);
                    }
                    
                    isNextRequestRetry = false; // Reset flag
                } else {
                    // This is a new original request
                    requestCounter++;
                    const requestKey = `req_${requestCounter}_${method}_${url}`;
                    
                    // Check if we already have a temporary entry for this request (from look-ahead logic)
                    // This can happen when auth body was found before the auth request start
                    let existingRequest = null;
                    if (url.includes('/auth/token') || url.includes('/token')) {
                        // Look for any temporary auth request entries
                        for (const [key, req] of pendingRequests.entries()) {
                            if (req.method === method && req.url === url && req.isTemporary) {
                                existingRequest = req;
                                // Remove the temporary entry
                                pendingRequests.delete(key);
                                break;
                            }
                        }
                    }
                    
                    if (existingRequest) {
                        existingRequest.isTemporary = false;
                        existingRequest.uniqueKey = requestKey;
                        pendingRequests.set(requestKey, existingRequest);
                        HttpRequestRunner.outputChannel.appendLine(`Found request start for already tracked auth request: ${requestKey}`);
                    } else {
                        const newRequest = {
                            method: method,
                            url: url,
                            requestHeaders: {},
                            responseHeaders: {},
                            uniqueKey: requestKey,
                            isTemporary: false,
                            isRetry: false
                        };
                        pendingRequests.set(requestKey, newRequest);
                        HttpRequestRunner.outputChannel.appendLine(`Found request start: ${requestKey}`);
                    }
                }
                continue;
            }

            // Look for request body
            if (line.includes("Following HTTP request's body")) {
                const requestBody = this.extractBody(lines, i);
                HttpRequestRunner.outputChannel.appendLine(`Extracted body: ${requestBody.substring(0, 100)}...`);
                HttpRequestRunner.outputChannel.appendLine(`Current pending requests: ${Array.from(pendingRequests.keys()).join(', ')}`);
                
                // Try to match body to the correct request based on content
                let targetRequest = null;
                let targetKey = null;
                
                // Check if this looks like auth credentials
                const isAuthBody = requestBody.includes('grant_type=') || 
                                  requestBody.includes('client_id=') || 
                                  requestBody.includes('client_secret=');
                
                // Check if this looks like JSON data
                const isJsonBody = requestBody.trim().startsWith('{') && requestBody.trim().endsWith('}');
                
                HttpRequestRunner.outputChannel.appendLine(`Body analysis: isAuthBody=${isAuthBody}, isJsonBody=${isJsonBody}`);
                
                if (isAuthBody) {
                    // For auth bodies, we need to handle the case where the auth request hasn't been logged yet
                    // Look for auth/token request first
                    HttpRequestRunner.outputChannel.appendLine(`Looking for auth/token request...`);
                    for (const [key, request] of pendingRequests.entries()) {
                        HttpRequestRunner.outputChannel.appendLine(`Checking ${key}: includes token? ${key.includes('/auth/token') || key.includes('/token')}, has body? ${!!request.requestBody}`);
                        if ((key.includes('/auth/token') || key.includes('/token')) && !request.requestBody) {
                            targetRequest = request;
                            targetKey = key;
                            break;
                        }
                    }
                    
                    // If no auth request found yet, wait and assign later when we find it
                    if (!targetRequest) {
                        HttpRequestRunner.outputChannel.appendLine(`No auth request found yet, will look for it in subsequent lines...`);
                        // Look ahead in the next few lines to see if we find an auth request start
                        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
                            const futureStartMatch = lines[j].trim().match(/Start processing HTTP request (\w+)\s+(.+)/);
                            if (futureStartMatch) {
                                const futureUrl = futureStartMatch[2];
                                if (futureUrl.includes('/auth/token') || futureUrl.includes('/token')) {
                                    // We'll find this auth request soon, store the body temporarily
                                    HttpRequestRunner.outputChannel.appendLine(`Found future auth request: ${futureStartMatch[1]} ${futureUrl}, storing auth body temporarily`);
                                    // Create a temporary entry for the future auth request
                                    const tempKey = `temp_auth_${futureStartMatch[1]}_${futureUrl}`;
                                    const tempAuthRequest = {
                                        method: futureStartMatch[1],
                                        url: futureUrl,
                                        requestHeaders: {},
                                        responseHeaders: {},
                                        requestBody: requestBody,
                                        isTemporary: true
                                    };
                                    pendingRequests.set(tempKey, tempAuthRequest);
                                    targetRequest = tempAuthRequest;
                                    targetKey = tempKey;
                                    break;
                                }
                            }
                        }
                    }
                } else if (isJsonBody) {
                    // Find non-auth request
                    HttpRequestRunner.outputChannel.appendLine(`Looking for non-auth POST request...`);
                    for (const [key, request] of pendingRequests.entries()) {
                        HttpRequestRunner.outputChannel.appendLine(`Checking ${key}: not token? ${!key.includes('/auth/token') && !key.includes('/token')}, is POST? ${request.method === 'POST'}, has body? ${!!request.requestBody}`);
                        if (!key.includes('/auth/token') && !key.includes('/token') && 
                            request.method === 'POST' && !request.requestBody) {
                            targetRequest = request;
                            targetKey = key;
                            break;
                        }
                    }
                }
                
                // Fallback: look backwards to find the most recent request start
                if (!targetRequest) {
                    HttpRequestRunner.outputChannel.appendLine(`No content-based match found, using fallback...`);
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
                
                if (targetRequest && targetKey) {
                    targetRequest.requestBody = requestBody;
                    HttpRequestRunner.outputChannel.appendLine(`Found request body for ${targetKey} (${isAuthBody ? 'auth' : isJsonBody ? 'json' : 'other'})`);
                } else {
                    HttpRequestRunner.outputChannel.appendLine(`Could not match request body to any pending request`);
                }
                continue;
            }

            // Look for response
            const responseMatch = line.match(/HTTP Response (\d+) \(([^)]+)\) was received from '([^']+)'/);
            if (responseMatch) {
                const statusCode = parseInt(responseMatch[1]);
                const statusText = responseMatch[2];
                const responseUrl = responseMatch[3];
                
                // Find the most recent request for this URL that doesn't have a response yet
                let targetRequest = null;
                let targetKey = null;
                
                // Go through requests in reverse order to find the most recent matching request
                const requestEntries = Array.from(pendingRequests.entries()).reverse();
                for (const [key, request] of requestEntries) {
                    if (request.url === responseUrl && !request.responseStatus) {
                        targetRequest = request;
                        targetKey = key;
                        break;
                    }
                }
                
                if (targetRequest && targetKey) {
                    targetRequest.responseStatus = statusCode;
                    targetRequest.responseStatusText = statusText;
                    HttpRequestRunner.outputChannel.appendLine(`Found response: ${statusCode} ${statusText} for ${targetKey} (URL: ${responseUrl})`);
                } else {
                    HttpRequestRunner.outputChannel.appendLine(`Could not match response to any pending request: ${statusCode} ${statusText} for ${responseUrl}`);
                }
                continue;
            }

            // Look for response body
            if (line.includes("Response's body")) {
                const responseBody = this.extractBody(lines, i);
                HttpRequestRunner.outputChannel.appendLine(`Extracted response body: ${responseBody.substring(0, 100)}...`);
                
                // Look backwards to find the most recent response to associate this body with
                let targetRequest = null;
                let targetKey = null;
                for (let j = i - 1; j >= 0; j--) {
                    const backLine = lines[j].trim();
                    const backResponseMatch = backLine.match(/HTTP Response (\d+) \(([^)]+)\) was received from '([^']+)'/);
                    if (backResponseMatch) {
                        const responseUrl = backResponseMatch[3];
                        const responseStatus = parseInt(backResponseMatch[1]);
                        
                        // Find the most recent request that matches this response URL and status and doesn't have a body yet
                        const requestEntries = Array.from(pendingRequests.entries()).reverse();
                        for (const [key, request] of requestEntries) {
                            if (request.url === responseUrl && 
                                request.responseStatus === responseStatus && 
                                !request.responseBody) {
                                targetRequest = request;
                                targetKey = key;
                                break;
                            }
                        }
                        if (targetRequest) {
                            break;
                        }
                    }
                }
                
                if (targetRequest && targetKey) {
                    targetRequest.responseBody = responseBody;
                    HttpRequestRunner.outputChannel.appendLine(`Found response body for ${targetKey}`);
                } else {
                    HttpRequestRunner.outputChannel.appendLine(`Could not match response body to any pending request`);
                }
                continue;
            }

            // Look for request end
            const endMatch = line.match(/End processing HTTP request after ([\d.]+)ms - (\d+)/);
            if (endMatch) {
                const statusCode = parseInt(endMatch[2]);
                const duration = endMatch[1] + 'ms';
                
                // Find the most recent request that matches this status code and has a response but no duration yet
                let foundRequest = null;
                let foundKey = null;
                
                // Go through requests in reverse order to find the most recent matching request
                const requestEntries = Array.from(pendingRequests.entries()).reverse();
                for (const [key, request] of requestEntries) {
                    if (request.responseStatus === statusCode && !request.duration) {
                        foundRequest = request;
                        foundKey = key;
                        break;
                    }
                }
                
                // If no exact match by status code, find any request without duration (fallback)
                if (!foundRequest) {
                    for (const [key, request] of requestEntries) {
                        if (!request.duration) {
                            foundRequest = request;
                            foundKey = key;
                            foundRequest.responseStatus = statusCode; // Set status if not set
                            break;
                        }
                    }
                }
                
                if (foundRequest && foundKey) {
                    foundRequest.duration = duration;
                    HttpRequestRunner.outputChannel.appendLine(`Request completed: ${foundKey} - ${statusCode} in ${duration}`);
                    
                    if (foundRequest.isRetry && foundRequest.originalRequest) {
                        // This is a retry - update the original request instead of creating a new entry
                        HttpRequestRunner.outputChannel.appendLine(`Updating original request with retry results: ${foundKey}`);
                        foundRequest.originalRequest.responseStatus = foundRequest.responseStatus || statusCode;
                        foundRequest.originalRequest.responseStatusText = foundRequest.responseStatusText;
                        foundRequest.originalRequest.responseBody = foundRequest.responseBody;
                        foundRequest.originalRequest.duration = duration;
                        
                        // Don't add the retry to requests array, just remove it from pending
                        pendingRequests.delete(foundKey);
                    } else {
                        // This is an original request - add it to the results
                        requests.push(foundRequest);
                        pendingRequests.delete(foundKey);
                    }
                } else {
                    HttpRequestRunner.outputChannel.appendLine(`Found end marker but couldn't match to pending request: ${line}`);
                }
                continue;
            }
        }

        HttpRequestRunner.outputChannel.appendLine(`Total requests parsed: ${requests.length}`);
        HttpRequestRunner.outputChannel.appendLine(`==================== END PARSING DEBUG ====================`);

        // Convert to test format
        const tests = requests.map((req, index) => {
            // Extract request number from unique key for better display
            const requestNumMatch = req.uniqueKey?.match(/^req_(\d+)_/);
            const requestNum = requestNumMatch ? requestNumMatch[1] : (index + 1);
            
            return {
                Name: `[${requestNum}] ${req.method} ${req.url}`,
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
            };
        });

        // If we found a connection error but no successful requests, create an error test
        if (connectionError && tests.length === 0) {
            tests.push({
                Name: 'HTTP Request Failed',
                Status: 'Failed',
                Duration: '0ms',
                ErrorMessage: connectionError
            } as any);
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
            .json .json-key { color: var(--vscode-symbolIcon-keywordForeground); }
            .json .json-string { color: var(--vscode-symbolIcon-stringForeground); }
            .json .json-number { color: var(--vscode-symbolIcon-numberForeground); }
            .json .json-boolean { color: var(--vscode-symbolIcon-booleanForeground); }
            .json .json-null { color: var(--vscode-symbolIcon-nullForeground); }
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
