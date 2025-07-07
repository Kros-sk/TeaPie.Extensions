import * as fs from 'fs';
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
    private static currentFile: vscode.Uri | undefined;
    private static outputChannel: vscode.OutputChannel;

    public static setOutputChannel(channel: vscode.OutputChannel) {
        HttpRequestRunner.outputChannel = channel;
    }

    public static async runHttpFile(uri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // Store the current file URI
        HttpRequestRunner.currentFile = uri;

        // Create or show the panel immediately with loading state
        if (HttpRequestRunner.currentPanel) {
            HttpRequestRunner.currentPanel.reveal(column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
        } else {
            HttpRequestRunner.currentPanel = vscode.window.createWebviewPanel(
                'httpRequestResults',
                'HTTP Request Results',
                column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            // Reset when the panel is disposed
            HttpRequestRunner.currentPanel.onDidDispose(
                () => {
                    HttpRequestRunner.currentPanel = undefined;
                    HttpRequestRunner.currentFile = undefined;
                },
                null,
                []
            );
        }

        // Show loading state immediately
        HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getLoadingWebviewContent(uri);

        try {
            // Run TeaPie and get results
            const results = await HttpRequestRunner.executeTeaPie(uri.fsPath);
            
            // Update the panel with actual results
            if (HttpRequestRunner.currentPanel) {
                HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getWebviewContent(results, uri);
            }

        } catch (error) {
            const errorMessage = `Failed to execute HTTP requests: ${error}`;
            HttpRequestRunner.outputChannel.appendLine(errorMessage);
            
            // Update the panel with error state
            if (HttpRequestRunner.currentPanel) {
                HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getErrorWebviewContent(uri, errorMessage);
            }
            
            vscode.window.showErrorMessage(errorMessage);
        }

        if (HttpRequestRunner.currentPanel) {
            // Listen for retry messages from the webview
            HttpRequestRunner.currentPanel.webview.onDidReceiveMessage(
                (message) => {
                    if (message && message.command === 'retry') {
                        // Re-run the HTTP file
                        HttpRequestRunner.runHttpFile(uri);
                    }
                },
                undefined,
                []
            );
        }
    }

    private static async executeTeaPie(filePath: string): Promise<TeaPieResult> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder is open');
        }

        // Get current environment if set
        const currentEnv = vscode.workspace.getConfiguration().get<string>('teapie.currentEnvironment');
        const envParam = currentEnv ? ` -e "${currentEnv}"` : '';

        // Use verbose flag to get detailed HTTP request/response information
        const command = `teapie test "${filePath}" --no-logo --verbose${envParam}`;
        
        HttpRequestRunner.outputChannel.appendLine(`Executing TeaPie command: ${command}`);
        HttpRequestRunner.outputChannel.appendLine(`Working directory: ${workspaceFolder.uri.fsPath}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: workspaceFolder.uri.fsPath,
                timeout: 60000 // 60 seconds timeout
            });

            HttpRequestRunner.outputChannel.appendLine(`TeaPie stdout: ${stdout}`);
            if (stderr) {
                HttpRequestRunner.outputChannel.appendLine(`TeaPie stderr: ${stderr}`);
            }

            // Parse verbose output to extract HTTP request/response information
            return HttpRequestRunner.parseVerboseOutput(stdout, filePath);

        } catch (error: any) {
            HttpRequestRunner.outputChannel.appendLine(`TeaPie execution error: ${error}`);
            
            // Don't throw the error - instead create a failed result
            const errorOutput = error.stdout || error.message || error.toString();
            HttpRequestRunner.outputChannel.appendLine(`Error output: ${errorOutput}`);
            
            // Try to parse the error output if it contains useful information
            if (error.stdout) {
                try {
                    return HttpRequestRunner.parseVerboseOutput(error.stdout, filePath);
                } catch (parseError) {
                    HttpRequestRunner.outputChannel.appendLine(`Failed to parse error stdout: ${parseError}`);
                }
            }
            
            // Create a basic failed result
            return {
                TestSuites: {
                    TestSuite: [{
                        Name: path.basename(filePath, path.extname(filePath)),
                        FilePath: filePath,
                        Tests: [{
                            Name: 'HTTP Request Failed',
                            Status: 'Failed',
                            Duration: '0ms',
                            ErrorMessage: error.message || error.toString()
                        }],
                        Status: 'Failed',
                        Duration: '0s'
                    }]
                }
            };
        }
    }

    private static getWebviewContent(results: TeaPieResult, fileUri: vscode.Uri): string {
        const fileName = path.basename(fileUri.fsPath);
        
        let requestsHtml = '';
        
        if (results.TestSuites && results.TestSuites.TestSuite) {
            results.TestSuites.TestSuite.forEach(suite => {
                if (suite.Tests) {
                    suite.Tests.forEach((request, reqIdx) => {
                        let requestHtml = '';
                        if (request.Request) {
                            const headersHtml = Object.entries(request.Request.Headers || {})
                                .map(([key, value], i) => `<div class="header-item">`
                                    + `<span><strong>${key}:</strong> <span id="req-header-${reqIdx}-${i}">${value}</span></span>`
                                    + `<button class="copy-btn" data-copy-target="req-header-${reqIdx}-${i}">Copy</button>`
                                    + `</div>`)
                                .join('');

                            // Format request body if it's JSON
                            let formattedRequestBody = request.Request.Body;
                            let bodyIsJson = false;
                            if (formattedRequestBody) {
                                try {
                                    const parsed = JSON.parse(formattedRequestBody);
                                    formattedRequestBody = JSON.stringify(parsed, null, 2);
                                    bodyIsJson = true;
                                } catch (e) {
                                    // Not JSON, keep as is
                                }
                            }

                            requestHtml = `
                                <div class="collapsible request-section open">
                                    <button class="collapsible-header" type="button">
                                        <span class="arrow">▶</span> Request
                                    </button>
                                    <div class="collapsible-content">
                                        <div class="method-url">
                                            <span class="method method-${request.Request.Method.toLowerCase()}">${request.Request.Method}</span>
                                            <span class="url" id="req-url-${reqIdx}">${request.Request.Url}</span>
                                            <button class="copy-btn" data-copy-target="req-url-${reqIdx}">Copy</button>
                                        </div>
                                        ${headersHtml ? `<div class="headers"><h4>Headers:</h4>${headersHtml}</div>` : ''}
                                        ${formattedRequestBody ? `<div class="body"><h4>Body:</h4><pre id="req-body-${reqIdx}" data-json="${bodyIsJson ? 'true' : ''}"><code>${formattedRequestBody}</code><button class="pre-copy-btn" data-copy-target="req-body-${reqIdx}">Copy</button></pre></div>` : ''}
                                    </div>
                                </div>
                            `;
                        }
                        
                        let responseHtml = '';
                        if (request.Response) {
                            const statusClass = request.Response.StatusCode >= 200 && request.Response.StatusCode < 300 ? 'success' : 
                                               request.Response.StatusCode >= 400 ? 'error' : 'warning';
                            const responseHeadersHtml = Object.entries(request.Response.Headers || {})
                                .map(([key, value], i) => `<div class="header-item">`
                                    + `<span><strong>${key}:</strong> <span id="res-header-${reqIdx}-${i}">${value}</span></span>`
                                    + `<button class="copy-btn" data-copy-target="res-header-${reqIdx}-${i}">Copy</button>`
                                    + `</div>`)
                                .join('');
                            let formattedResponseBody = request.Response.Body;
                            let bodyIsJson = false;
                            if (formattedResponseBody) {
                                try {
                                    const parsed = JSON.parse(formattedResponseBody);
                                    formattedResponseBody = JSON.stringify(parsed, null, 2);
                                    bodyIsJson = true;
                                } catch (e) {
                                    // Not JSON, keep as is
                                }
                            }
                            responseHtml = `
                                <div class="collapsible response-section open">
                                    <button class="collapsible-header" type="button">
                                        <span class="arrow">▶</span> Response
                                    </button>
                                    <div class="collapsible-content">
                                        <div class="status-line">
                                            <span class="status-code status-${statusClass}">${request.Response.StatusCode}</span>
                                            <span class="status-text">${request.Response.StatusText}</span>
                                            <span class="duration">${request.Response.Duration}</span>
                                        </div>
                                        ${responseHeadersHtml ? `<div class="headers"><h4>Headers:</h4>${responseHeadersHtml}</div>` : ''}
                                        ${formattedResponseBody ? `<div class="body"><h4>Body:</h4><pre id="res-body-${reqIdx}" data-json="${bodyIsJson ? 'true' : ''}"><code>${formattedResponseBody}</code><button class="pre-copy-btn" data-copy-target="res-body-${reqIdx}">Copy</button></pre></div>` : ''}
                                    </div>
                                </div>
                            `;
                        }
                        
                        let errorHtml = '';
                        if (request.ErrorMessage) {
                            errorHtml = `
                                <div class="collapsible error-section open">
                                    <button class="collapsible-header" type="button">
                                        <span class="arrow">▶</span> Error
                                    </button>
                                    <div class="collapsible-content">
                                        <pre class="error-message" id="err-msg-${reqIdx}">${request.ErrorMessage}</pre>
                                        <button class="copy-btn" data-copy-target="err-msg-${reqIdx}">Copy</button>
                                    </div>
                                </div>
                            `;
                        }
                        
                        requestsHtml += `
                            <div class="http-request-item">
                                <div class="request-header">
                                    <h2>${request.Name}</h2>
                                    <div class="request-status ${request.Status?.toLowerCase()}">
                                        <span class="status-icon">${request.Status === 'Passed' ? '✅' : request.Status === 'Failed' ? '❌' : '⚙️'}</span>
                                        ${request.Status === 'Passed' ? 'Success' : request.Status === 'Failed' ? 'Failed' : request.Status}
                                    </div>
                                </div>
                                <div class="request-response-container">
                                    ${requestHtml}
                                    ${responseHtml}
                                    ${errorHtml}
                                </div>
                            </div>
                        `;
                    });
                }
            });
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTTP Request Results</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            line-height: 1.6;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        .header {
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header h1 {
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 24px;
        }
        .filename {
            font-style: italic;
            color: var(--vscode-textLink-foreground, #3794ff);
            font-family: 'Fira Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 22px;
        }
        .retry-btn {
            margin-left: 18px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 2px 12px;
            font-size: 14px;
            font-family: inherit;
            font-weight: 500;
            cursor: pointer;
            vertical-align: middle;
            transition: background 0.2s;
        }
        .retry-btn:hover, .retry-btn:focus {
            background: var(--vscode-button-hoverBackground);
            outline: none;
        }
        .http-request-item {
            margin-bottom: 40px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            overflow: hidden;
            background-color: var(--vscode-editor-background);
        }
        .request-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            z-index: 2;
        }
        .request-header h2 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .status-icon {
            font-size: 16px;
            margin-right: 4px;
        }
        .request-status {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .request-status.passed, .request-status.completed {
            background-color: var(--vscode-terminal-ansiGreen);
            color: white;
        }
        .request-status.failed {
            background-color: var(--vscode-terminal-ansiRed);
            color: white;
        }
        .request-response-container {
            padding: 0;
        }
        .collapsible {
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .collapsible-header {
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: 600;
            color: var(--vscode-foreground);
            background: none;
            border: none;
            width: 100%;
            padding: 12px 0 0 24px; /* top, right, bottom, left */
            margin-bottom: 8px;
        }
        .collapsible-content {
            display: none;
            padding: 16px 24px 20px 24px; /* top, right, bottom, left */
        }
        .collapsible.open .collapsible-content {
            display: block;
        }
        .collapsible.open .arrow {
            transform: rotate(90deg);
        }
        .arrow {
            transition: transform 0.2s;
            font-size: 12px;
        }
        .copy-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            padding: 2px 6px;
            font-size: 11px;
            margin-left: 8px;
            cursor: pointer;
        }
        .copy-btn:active {
            background: var(--vscode-button-hoverBackground);
        }
        .method-url {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-bottom: 15px;
            padding: 10px;
            background-color: var(--vscode-textCodeBlock-background);
            border-radius: 6px;
        }
        .method {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            min-width: 50px;
            text-align: center;
        }
        .method-get { background-color: #4CAF50; color: white; }
        .method-post { background-color: #FF9800; color: white; }
        .method-put { background-color: #2196F3; color: white; }
        .method-delete { background-color: #F44336; color: white; }
        .method-patch { background-color: #9C27B0; color: white; }
        .method-head { background-color: #607D8B; color: white; }
        .method-options { background-color: #795548; color: white; }
        .url {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 14px;
            font-weight: 500;
            word-break: break-all;
            flex: 1;
        }
        .status-line {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-bottom: 15px;
            padding: 10px;
            background-color: var(--vscode-textCodeBlock-background);
            border-radius: 6px;
        }
        .status-code {
            padding: 4px 8px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 13px;
            min-width: 40px;
            text-align: center;
        }
        .status-success { background-color: #4CAF50; color: white; }
        .status-warning { background-color: #FF9800; color: white; }
        .status-error { background-color: #F44336; color: white; }
        .status-text {
            font-weight: 500;
            flex: 1;
        }
        .duration {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            padding: 2px 6px;
            border-radius: 3px;
        }
        .headers {
            margin: 15px 0;
        }
        .headers h4 {
            margin: 0 0 8px 0;
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .header-item {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 12px;
            margin-bottom: 4px;
            padding: 4px 8px;
            background-color: var(--vscode-textCodeBlock-background);
            border-radius: 3px;
            word-break: break-all;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .body {
            margin: 15px 0 0 0;
        }
        .body h4 {
            margin: 0 0 8px 0;
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 15px;
            border-radius: 6px;
            overflow-x: auto;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            margin: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
            border: 1px solid var(--vscode-panel-border);
            position: relative; /* for absolute positioning of copy btn */
        }
        pre code {
            background: transparent !important;
            padding: 0;
            border: none;
            color: inherit;
            font-size: inherit;
            font-family: inherit;
            display: block;
        }
        .pre-copy-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            padding: 2px 6px;
            font-size: 11px;
            cursor: pointer;
            z-index: 2;
        }
        .pre-copy-btn:active {
            background: var(--vscode-button-hoverBackground);
        }
        .json-key { color: #d19a66; }
        .json-string { color: #98c379; }
        .json-number { color: #61afef; }
        .json-boolean { color: #e06c75; }
        .json-null { color: #c678dd; }
        .error-message {
            color: var(--vscode-terminal-ansiRed);
        }
        .no-results {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .no-results h2 {
            margin: 0 0 10px 0;
            color: var(--vscode-foreground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>HTTP Request Results: <span class="filename">${fileName}</span>
            <button class="retry-btn" id="retry-btn" title="Retry" type="button">⟳ Retry</button>
        </h1>
    </div>
    ${requestsHtml || '<div class="no-results"><h2>No HTTP requests found</h2><p>Make sure your .http file contains valid HTTP requests</p></div>'}
    <script>
    // Collapsible logic
    document.querySelectorAll('.collapsible-header').forEach(header => {
        header.addEventListener('click', function() {
            const parent = header.parentElement;
            parent.classList.toggle('open');
        });
    });
    // Retry button logic
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn && window.acquireVsCodeApi) {
        retryBtn.addEventListener('click', function(e) {
            const vscode = window.acquireVsCodeApi();
            vscode.postMessage({ command: 'retry' });
            e.stopPropagation();
        });
    }
    // Copy to clipboard logic
    document.querySelectorAll('.copy-btn, .pre-copy-btn').forEach(btn => {
        btn.addEventListener('click', function(e) {
            const target = btn.getAttribute('data-copy-target');
            if (target) {
                const el = document.getElementById(target);
                if (el) {
                    let textToCopy = '';
                    // If it's a pre with code, only copy the code's text
                    if (el.tagName === 'PRE') {
                        const code = el.querySelector('code');
                        textToCopy = code ? code.innerText : el.innerText;
                    } else {
                        textToCopy = el.innerText;
                    }
                    navigator.clipboard.writeText(textToCopy);
                    btn.innerText = 'Copied!';
                    setTimeout(() => btn.innerText = 'Copy', 1000);
                }
            }
            e.stopPropagation();
        });
    });
    // Syntax highlight JSON
    function syntaxHighlight(json) {
        if (!json) return '';
        json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'json-key';
                } else {
                    cls = 'json-string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'json-boolean';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return '<span class="' + cls + '">' + match + '</span>';
        });
    }
    document.querySelectorAll('pre[data-json]').forEach(pre => {
        const code = pre.querySelector('code');
        if (code) {
            try {
                const json = JSON.parse(code.innerText);
                code.innerHTML = syntaxHighlight(JSON.stringify(json, null, 2));
            } catch {}
        }
    });
    </script>
</body>
</html>`;
    }

    private static getLoadingWebviewContent(fileUri: vscode.Uri): string {
        const fileName = path.basename(fileUri.fsPath);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTTP Request Results</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            line-height: 1.6;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        
        .header {
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .header h1 {
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 24px;
        }
        .filename {
            font-style: italic;
            color: var(--vscode-textLink-foreground, #3794ff);
            font-family: 'Fira Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 22px;
        }
        .loading-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 60px 20px;
            text-align: center;
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid var(--vscode-panel-border);
            border-top: 4px solid var(--vscode-button-background);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .loading-text {
            font-size: 16px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 10px;
        }
        
        .loading-subtext {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>HTTP Request Results: <span class="filename">${fileName}</span></h1>
    </div>
    
    <div class="loading-container">
        <div class="spinner"></div>
        <div class="loading-text">Executing HTTP requests...</div>
        <div class="loading-subtext">TeaPie is processing your .http file</div>
    </div>
</body>
</html>`;
    }

    private static getErrorWebviewContent(fileUri: vscode.Uri, errorMessage: string): string {
        const fileName = path.basename(fileUri.fsPath);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTTP Request Results</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            line-height: 1.6;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        
        .header {
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .header h1 {
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 24px;
        }
        .filename {
            font-style: italic;
            color: var(--vscode-textLink-foreground, #3794ff);
            font-family: 'Fira Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 22px;
        }
        .error-container {
            padding: 30px;
            text-align: center;
        }
        
        .error-icon {
            font-size: 48px;
            color: var(--vscode-terminal-ansiRed);
            margin-bottom: 20px;
        }
        
        .error-title {
            font-size: 20px;
            color: var(--vscode-terminal-ansiRed);
            margin-bottom: 15px;
            font-weight: bold;
        }
        
        .error-message {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 15px;
            border-radius: 6px;
            border-left: 4px solid var(--vscode-terminal-ansiRed);
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            text-align: left;
            white-space: pre-wrap;
            word-wrap: break-word;
            margin: 20px 0;
        }
        
        .error-suggestions {
            margin-top: 30px;
            padding: 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 6px;
            text-align: left;
        }
        
        .error-suggestions h3 {
            margin: 0 0 15px 0;
            font-size: 16px;
            color: var(--vscode-foreground);
        }
        
        .error-suggestions ul {
            margin: 0;
            padding-left: 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .error-suggestions li {
            margin-bottom: 8px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>HTTP Request Results: <span class="filename">${fileName}</span>
            <button class="retry-btn" onclick="window.location.reload()" title="Retry" type="button">⟳ Retry</button>
        </h1>
    </div>
    
    <div class="error-container">
        <div class="error-icon">⚠️</div>
        <div class="error-title">Failed to execute HTTP requests</div>
        
        <div class="error-message">${errorMessage}</div>
        
        <div class="error-suggestions">
            <h3>Possible solutions:</h3>
            <ul>
                <li>Check if TeaPie is properly installed and accessible</li>
                <li>Verify that the .http file syntax is correct</li>
                <li>Make sure the current environment is properly configured</li>
                <li>Check the output channel for more detailed error information</li>
                <li>Try running the file again</li>
            </ul>
        </div>
    </div>
</body>
</html>`;
    }

    private static parseVerboseOutput(stdout: string, filePath: string): TeaPieResult {
        const result: TeaPieResult = {
            TestSuites: {
                TestSuite: []
            }
        };

        try {
            const fileName = path.basename(filePath, path.extname(filePath));
            const lines = stdout.split('\n');
            
            HttpRequestRunner.outputChannel.appendLine(`Parsing verbose output with ${lines.length} lines`);
            
            // Debug: Log first 50 lines to see the structure
            HttpRequestRunner.outputChannel.appendLine('=== VERBOSE OUTPUT SAMPLE ===');
            lines.slice(0, 50).forEach((line, index) => {
                if (line.includes('HTTP request') || line.includes('response') || line.includes('body')) {
                    HttpRequestRunner.outputChannel.appendLine(`[${index}]: ${line.trim()}`);
                }
            });
            HttpRequestRunner.outputChannel.appendLine('=== END SAMPLE ===');
            
            const testSuite: TeaPieTestSuite = {
                Name: fileName,
                FilePath: filePath,
                Tests: [],
                Status: 'Unknown',
                Duration: '0s'
            };

            const httpRequests: Array<{
                method: string;
                url: string;
                requestBody?: string;
                responseStatus?: number;
                responseStatusText?: string;
                responseBody?: string;
                duration?: string;
                requestHeaders?: {[key: string]: string};
                responseHeaders?: {[key: string]: string};
            }> = [];

            let currentRequest: any = null;
            const startedRequests: string[] = []; // Track all started requests for debugging

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Look for: "Start processing HTTP request POST http://localhost:3001/cars"
                const startRequestMatch = line.match(/Start processing HTTP request (\w+)\s+(.+)/);
                if (startRequestMatch) {
                    const requestDesc = `${startRequestMatch[1]} ${startRequestMatch[2]}`;
                    startedRequests.push(requestDesc);
                    
                    currentRequest = {
                        method: startRequestMatch[1],
                        url: startRequestMatch[2],
                        requestHeaders: {},
                        responseHeaders: {}
                    };
                    HttpRequestRunner.outputChannel.appendLine(`🚀 Found request: ${currentRequest.method} ${currentRequest.url}`);
                    continue;
                }

                // Look for request body: "Following HTTP request's body (application/json):"
                if (currentRequest && line.includes("Following HTTP request's body")) {
                    const contentTypeMatch = line.match(/\(([^)]+)\)/);
                    if (contentTypeMatch) {
                        currentRequest.requestHeaders['Content-Type'] = contentTypeMatch[1];
                    }
                    
                    // Read all lines until we hit another log entry or empty line
                    const bodyLines: string[] = [];
                    let j = i + 1;
                    while (j < lines.length) {
                        const bodyLine = lines[j];
                        // Stop if we hit another log entry (starts with [timestamp])
                        if (bodyLine.trim().match(/^\[[\d:]+\s+\w+\]/)) {
                            break;
                        }
                        // Stop if we hit "INF] Sending HTTP request"
                        if (bodyLine.includes('INF] Sending HTTP request')) {
                            break;
                        }
                        bodyLines.push(bodyLine);
                        j++;
                    }
                    
                    if (bodyLines.length > 0) {
                        // Join all body lines and clean up
                        currentRequest.requestBody = bodyLines.join('\n').trim();
                        HttpRequestRunner.outputChannel.appendLine(`Found request body (${bodyLines.length} lines): ${currentRequest.requestBody.substring(0, 100)}...`);
                    }
                    
                    // Move index forward to skip processed lines
                    i = j - 1;
                    continue;
                }

                // Look for: "Received HTTP response headers after 128.6225ms - 201"
                const responseHeadersMatch = line.match(/Received HTTP response headers after ([\d.]+)ms - (\d+)/);
                if (currentRequest && responseHeadersMatch) {
                    currentRequest.duration = responseHeadersMatch[1] + 'ms';
                    currentRequest.responseStatus = parseInt(responseHeadersMatch[2]);
                    HttpRequestRunner.outputChannel.appendLine(`Found response: ${currentRequest.responseStatus} in ${currentRequest.duration}`);
                    continue;
                }

                // Look for: "HTTP Response 201 (Created) was received from 'http://localhost:3001/cars'"
                const responseStatusMatch = line.match(/HTTP Response (\d+) \(([^)]+)\) was received/);
                if (currentRequest && responseStatusMatch) {
                    currentRequest.responseStatus = parseInt(responseStatusMatch[1]);
                    currentRequest.responseStatusText = responseStatusMatch[2];
                    HttpRequestRunner.outputChannel.appendLine(`Found response status: ${currentRequest.responseStatus} ${currentRequest.responseStatusText}`);
                    continue;
                }

                // Look for response body: "Response's body (application/json):"
                if (currentRequest && line.includes("Response's body")) {
                    const contentTypeMatch = line.match(/\(([^)]+)\)/);
                    if (contentTypeMatch) {
                        currentRequest.responseHeaders['Content-Type'] = contentTypeMatch[1];
                    }
                    
                    // Read all lines until we hit another log entry
                    const bodyLines: string[] = [];
                    let j = i + 1;
                    while (j < lines.length) {
                        const bodyLine = lines[j];
                        // Stop if we hit another log entry (starts with [timestamp])
                        if (bodyLine.trim().match(/^\[[\d:]+\s+\w+\]/)) {
                            break;
                        }
                        // Stop if we hit "INF] End processing"
                        if (bodyLine.includes('INF] End processing')) {
                            break;
                        }
                        bodyLines.push(bodyLine);
                        j++;
                    }
                    
                    if (bodyLines.length > 0) {
                        // Join all body lines and clean up
                        currentRequest.responseBody = bodyLines.join('\n').trim();
                        HttpRequestRunner.outputChannel.appendLine(`Found response body (${bodyLines.length} lines): ${currentRequest.responseBody.substring(0, 100)}...`);
                    }
                    
                    // Move index forward to skip processed lines
                    i = j - 1;
                    continue;
                }

                // Look for: "End processing HTTP request after 228.6335ms - 201"
                const endRequestMatch = line.match(/End processing HTTP request after ([\d.]+)ms - (\d+)/);
                if (endRequestMatch) {
                    const duration = endRequestMatch[1] + 'ms';
                    const statusCode = parseInt(endRequestMatch[2]);
                    
                    // If we have a current request, update it
                    if (currentRequest) {
                        currentRequest.duration = duration;
                        currentRequest.responseStatus = statusCode;
                        
                        httpRequests.push(currentRequest);
                        HttpRequestRunner.outputChannel.appendLine(`✅ Completed request: ${currentRequest.method} ${currentRequest.url} -> ${currentRequest.responseStatus} (${currentRequest.duration})`);
                        
                        currentRequest = null;
                    } else {
                        // If no current request, try to find which request this belongs to by looking backwards
                        HttpRequestRunner.outputChannel.appendLine(`⚠️ Found end marker without current request: ${duration} - ${statusCode}. Looking for matching start...`);
                        
                        // Look for the most recent started request that hasn't been completed yet
                        for (let startIndex = startedRequests.length - 1; startIndex >= 0; startIndex--) {
                            const startedReq = startedRequests[startIndex];
                            const [method, url] = startedReq.split(' ', 2);
                            
                            // Check if this request was already completed
                            const alreadyCompleted = httpRequests.some(req => req.method === method && req.url === url);
                            if (!alreadyCompleted) {
                                // Found the matching uncompleted request, now try to find its body and response body by looking backwards
                                let requestBody: string | undefined;
                                let responseBody: string | undefined;
                                let responseStatusText: string | undefined;
                                const requestHeaders: {[key: string]: string} = {};
                                const responseHeaders: {[key: string]: string} = {};
                                
                                // Look backwards from current position to find request/response data for this specific request
                                for (let backIndex = i - 1; backIndex >= 0; backIndex--) {
                                    const backLine = lines[backIndex].trim();
                                    
                                    // Stop if we hit the start of this request
                                    if (backLine.includes(`Start processing HTTP request ${method} ${url}`)) {
                                        break;
                                    }
                                    
                                    // Look for request body
                                    if (!requestBody && backLine.includes("Following HTTP request's body")) {
                                        const contentTypeMatch = backLine.match(/\(([^)]+)\)/);
                                        if (contentTypeMatch) {
                                            requestHeaders['Content-Type'] = contentTypeMatch[1];
                                        }
                                        
                                        // Read body lines after this marker
                                        const bodyLines: string[] = [];
                                        let bodyIndex = backIndex + 1;
                                        while (bodyIndex < lines.length) {
                                            const bodyLine = lines[bodyIndex];
                                            if (bodyLine.trim().match(/^\[[\d:]+\s+\w+\]/) || bodyLine.includes('INF] Sending HTTP request')) {
                                                break;
                                            }
                                            bodyLines.push(bodyLine);
                                            bodyIndex++;
                                        }
                                        if (bodyLines.length > 0) {
                                            requestBody = bodyLines.join('\n').trim();
                                        }
                                    }
                                    
                                    // Look for response body
                                    if (!responseBody && backLine.includes("Response's body")) {
                                        const contentTypeMatch = backLine.match(/\(([^)]+)\)/);
                                        if (contentTypeMatch) {
                                            responseHeaders['Content-Type'] = contentTypeMatch[1];
                                        }
                                        
                                        // Read body lines after this marker
                                        const bodyLines: string[] = [];
                                        let bodyIndex = backIndex + 1;
                                        while (bodyIndex < lines.length) {
                                            const bodyLine = lines[bodyIndex];
                                            if (bodyLine.trim().match(/^\[[\d:]+\s+\w+\]/) || bodyLine.includes('INF] End processing')) {
                                                break;
                                            }
                                            bodyLines.push(bodyLine);
                                            bodyIndex++;
                                        }
                                        if (bodyLines.length > 0) {
                                            responseBody = bodyLines.join('\n').trim();
                                        }
                                    }
                                    
                                    // Look for response status text
                                    if (!responseStatusText) {
                                        const statusMatch = backLine.match(/HTTP Response \d+ \(([^)]+)\) was received/);
                                        if (statusMatch) {
                                            responseStatusText = statusMatch[1];
                                        }
                                    }
                                }
                                
                                // Found the matching uncompleted request
                                const orphanedRequest = {
                                    method: method,
                                    url: url,
                                    duration: duration,
                                    responseStatus: statusCode,
                                    responseStatusText: responseStatusText,
                                    requestBody: requestBody,
                                    responseBody: responseBody,
                                    requestHeaders: requestHeaders,
                                    responseHeaders: responseHeaders
                                };
                                
                                httpRequests.push(orphanedRequest);
                                HttpRequestRunner.outputChannel.appendLine(`✅ Recovered orphaned request: ${method} ${url} -> ${statusCode} (${duration}) with ${requestBody ? 'request body' : 'no request body'} and ${responseBody ? 'response body' : 'no response body'}`);
                                break;
                            }
                        }
                    }
                    continue;
                }
            }

            // Handle any remaining currentRequest that didn't complete properly
            if (currentRequest) {
                HttpRequestRunner.outputChannel.appendLine(`⚠️ Found incomplete request: ${currentRequest.method} ${currentRequest.url} (no end marker found)`);
                // Add it anyway, it might have useful information
                httpRequests.push(currentRequest);
            }

            HttpRequestRunner.outputChannel.appendLine(`Found ${httpRequests.length} total HTTP requests in verbose output`);
            
            // Debug: Show all started vs completed requests
            HttpRequestRunner.outputChannel.appendLine('=== REQUEST TRACKING ===');
            HttpRequestRunner.outputChannel.appendLine(`Started requests: ${startedRequests.length}`);
            startedRequests.forEach((req, index) => {
                HttpRequestRunner.outputChannel.appendLine(`  ${index + 1}. ${req}`);
            });
            HttpRequestRunner.outputChannel.appendLine(`Completed requests: ${httpRequests.length}`);
            httpRequests.forEach((req, index) => {
                HttpRequestRunner.outputChannel.appendLine(`  ${index + 1}. ${req.method} ${req.url} -> ${req.responseStatus || 'no response'}`);
            });
            HttpRequestRunner.outputChannel.appendLine('=== END TRACKING ===');

            // Convert parsed HTTP requests to test format, removing duplicates by method+url
            // Group requests by method and URL, keeping only the best response
            const uniqueRequests = new Map<string, any>();
            
            httpRequests.forEach((req, index) => {
                const requestKey = `${req.method}:${req.url}`;
                
                if (uniqueRequests.has(requestKey)) {
                    const existing = uniqueRequests.get(requestKey);
                    
                    // Prefer successful responses (2xx status codes)
                    const currentIsSuccess = req.responseStatus ? (req.responseStatus >= 200 && req.responseStatus < 300) : false;
                    const existingIsSuccess = existing.responseStatus ? (existing.responseStatus >= 200 && existing.responseStatus < 300) : false;
                    
                    // Keep the current one if:
                    // 1. Current is successful and existing is not
                    // 2. Both are successful or both are not successful, keep the one with more complete data
                    if ((currentIsSuccess && !existingIsSuccess) ||
                        (currentIsSuccess === existingIsSuccess && 
                         (req.responseBody || !existing.responseBody))) {
                        uniqueRequests.set(requestKey, req);
                        HttpRequestRunner.outputChannel.appendLine(`Replacing duplicate request ${requestKey}: current=${req.responseStatus || 'none'}, existing=${existing.responseStatus || 'none'}`);
                    } else {
                        HttpRequestRunner.outputChannel.appendLine(`Keeping existing request ${requestKey}: keeping=${existing.responseStatus || 'none'}, ignoring=${req.responseStatus || 'none'}`);
                    }
                } else {
                    uniqueRequests.set(requestKey, req);
                    HttpRequestRunner.outputChannel.appendLine(`Adding new request ${requestKey}: status=${req.responseStatus || 'none'}`);
                }
            });

            HttpRequestRunner.outputChannel.appendLine(`Reduced ${httpRequests.length} requests to ${uniqueRequests.size} unique requests`);
            
            // Debug: Show what requests we're keeping
            HttpRequestRunner.outputChannel.appendLine('=== FINAL UNIQUE REQUESTS ===');
            Array.from(uniqueRequests.values()).forEach((req, index) => {
                HttpRequestRunner.outputChannel.appendLine(`${index + 1}. ${req.method} ${req.url} -> ${req.responseStatus || 'no response'}`);
            });
            HttpRequestRunner.outputChannel.appendLine('=== END UNIQUE REQUESTS ===');

            // Convert unique requests to test format
            Array.from(uniqueRequests.values()).forEach((req, index) => {
                const test: TeaPieTest = {
                    Name: `${req.method} ${req.url}`,
                    Status: req.responseStatus && req.responseStatus >= 200 && req.responseStatus < 400 ? 'Passed' : 'Failed',
                    Duration: req.duration || '0ms',
                    Request: {
                        Method: req.method,
                        Url: req.url,
                        Headers: req.requestHeaders || {},
                        Body: req.requestBody
                    }
                };

                if (req.responseStatus) {
                    test.Response = {
                        StatusCode: req.responseStatus,
                        StatusText: req.responseStatusText || (req.responseStatus >= 200 && req.responseStatus < 300 ? 'OK' : 'Error'),
                        Headers: req.responseHeaders || {},
                        Body: req.responseBody,
                        Duration: req.duration || '0ms'
                    };
                }

                testSuite.Tests.push(test);
            });

            // If no requests found, try to extract from .http file
            if (httpRequests.length === 0) {
                const httpFileRequests = HttpRequestRunner.parseHttpFile(filePath);
                httpFileRequests.forEach(req => {
                    const test: TeaPieTest = {
                        Name: `${req.Method} ${req.Url}`,
                        Status: 'Failed',
                        Duration: '0ms',
                        Request: req,
                        ErrorMessage: 'Request was parsed from file but no execution output found'
                    };
                    testSuite.Tests.push(test);
                });
            }

            testSuite.Status = testSuite.Tests.length > 0 && testSuite.Tests.every(t => t.Status === 'Passed') ? 'Passed' : 'Failed';
            result.TestSuites.TestSuite.push(testSuite);
            
            return result;
            
        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`Verbose output parsing error: ${error}`);
            
            return {
                TestSuites: {
                    TestSuite: [{
                        Name: path.basename(filePath),
                        FilePath: filePath,
                        Tests: [{
                            Name: 'Parse Error',
                            Status: 'Failed',
                            Duration: '0s',
                            ErrorMessage: `Failed to parse verbose output: ${error}`
                        }],
                        Status: 'Failed',
                        Duration: '0s'
                    }]
                }
            };
        }
    }

    private static parseHttpOutput(stdout: string, filePath: string): TeaPieResult {
        const result: TeaPieResult = {
            TestSuites: {
                TestSuite: []
            }
        };

        try {
            const fileName = path.basename(filePath, path.extname(filePath));
            const lines = stdout.split('\n');
            
            HttpRequestRunner.outputChannel.appendLine(`Parsing HTTP output with ${lines.length} lines:`);
            
            const testSuite: TeaPieTestSuite = {
                Name: fileName,
                FilePath: filePath,
                Tests: [],
                Status: 'Unknown',
                Duration: '0s'
            };

            // Parse HTTP requests from the .http file itself
            const httpRequests = HttpRequestRunner.parseHttpFile(filePath);
            
            // For each HTTP request, try to find corresponding response in the output
            httpRequests.forEach((request, index) => {
                const test: TeaPieTest = {
                    Name: `${request.Method} ${request.Url}`,
                    Status: 'Completed',
                    Duration: '0ms',
                    Request: request
                };

                // Try to find response information in the stdout
                const responseInfo = HttpRequestRunner.findResponseInOutput(lines, request, index);
                if (responseInfo) {
                    test.Response = responseInfo.response;
                    test.Duration = responseInfo.duration;
                    test.Status = responseInfo.response.StatusCode >= 200 && responseInfo.response.StatusCode < 400 ? 'Passed' : 'Failed';
                } else {
                    test.Status = 'Failed';
                    test.ErrorMessage = 'No response found in output';
                }

                testSuite.Tests.push(test);
            });

            // If no requests found in file, create a generic one based on output
            if (httpRequests.length === 0) {
                const genericTest: TeaPieTest = {
                    Name: 'HTTP Request',
                    Status: 'Unknown',
                    Duration: '0ms'
                };

                // Try to extract any HTTP information from stdout
                const extractedInfo = HttpRequestRunner.extractHttpInfoFromOutput(lines);
                if (extractedInfo) {
                    genericTest.Request = extractedInfo.request;
                    genericTest.Response = extractedInfo.response;
                    genericTest.Status = extractedInfo.response?.StatusCode >= 200 && extractedInfo.response?.StatusCode < 400 ? 'Passed' : 'Failed';
                } else {
                    genericTest.Status = 'Failed';
                    genericTest.ErrorMessage = 'Could not parse HTTP request/response from output';
                }

                testSuite.Tests.push(genericTest);
            }

            testSuite.Status = testSuite.Tests.every(t => t.Status === 'Passed') ? 'Passed' : 'Failed';
            result.TestSuites.TestSuite.push(testSuite);
            
            return result;
            
        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`HTTP output parsing error: ${error}`);
            
            return {
                TestSuites: {
                    TestSuite: [{
                        Name: path.basename(filePath),
                        FilePath: filePath,
                        Tests: [{
                            Name: 'Parse Error',
                            Status: 'Failed',
                            Duration: '0s',
                            ErrorMessage: `Failed to parse HTTP output: ${error}`
                        }],
                        Status: 'Failed',
                        Duration: '0s'
                    }]
                }
            };
        }
    }

    private static parseStdoutOutput(stdout: string, filePath: string): TeaPieResult {
        const result: TeaPieResult = {
            TestSuites: {
                TestSuite: []
            }
        };

        try {
            const fileName = path.basename(filePath, path.extname(filePath));
            const lines = stdout.split('\n');
            
            // Debug: log all lines to see what we're working with
            HttpRequestRunner.outputChannel.appendLine(`Parsing stdout with ${lines.length} lines:`);
            lines.forEach((line, index) => {
                HttpRequestRunner.outputChannel.appendLine(`[${index}]: "${line.trim()}"`);
            });
            
            const testSuite: TeaPieTestSuite = {
                Name: fileName,
                FilePath: filePath,
                Tests: [],
                Status: 'Unknown',
                Duration: '0s'
            };

            let currentTest: TeaPieTest | null = null;
            let isSuccess = false;
            let foundTestNumbers: number[] = [];
            let testMap: Map<number, TeaPieTest> = new Map(); // Track tests by number to avoid duplicates
            let nonNumberedTests: TeaPieTest[] = []; // Collect non-numbered tests separately

            for (let i = 0; i < lines.length; i++) {
                const trimmedLine = lines[i].trim();
                
                // Look for test execution start
                const testStartMatch = trimmedLine.match(/Running test: '(.+?)' \((.+?)\)/);
                if (testStartMatch) {
                    currentTest = {
                        Name: testStartMatch[1],
                        Status: 'Running',
                        Duration: '0s'
                    };
                    
                    // Try to extract HTTP method and URL from the file
                    try {
                        const httpContent = fs.readFileSync(filePath, 'utf8');
                        const httpLines = httpContent.split('\n');
                        for (const httpLine of httpLines) {
                            const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                            if (methodMatch) {
                                currentTest.Request = {
                                    Method: methodMatch[1].toUpperCase(),
                                    Url: methodMatch[2].trim(),
                                    Headers: {}
                                };
                                break;
                            }
                        }
                    } catch (error) {
                        HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file: ${error}`);
                    }
                }
                
                // Look for test execution with pattern: Running test: '[1] Status code should match...'
                const testRunningMatch = trimmedLine.match(/Running test: '\[(\d+)\]\s+(.+?)'\s+\(/);
                if (testRunningMatch) {
                    const testNumber = parseInt(testRunningMatch[1]);
                    const testDescription = testRunningMatch[2];
                    foundTestNumbers.push(testNumber);
                    
                    HttpRequestRunner.outputChannel.appendLine(`Found running test [${testNumber}]: ${testDescription}`);
                    
                    const test: TeaPieTest = {
                        Name: `[${testNumber}] ${testDescription}`,
                        Status: 'Running',
                        Duration: '0ms'
                    };
                    
                    // Extract HTTP method and URL for this test
                    try {
                        const httpContent = fs.readFileSync(filePath, 'utf8');
                        const httpLines = httpContent.split('\n');
                        for (const httpLine of httpLines) {
                            const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                            if (methodMatch) {
                                test.Request = {
                                    Method: methodMatch[1].toUpperCase(),
                                    Url: methodMatch[2].trim(),
                                    Headers: {}
                                };
                                break;
                            }
                        }
                    } catch (error) {
                        HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file: ${error}`);
                    }
                    
                    testMap.set(testNumber, test);
                    continue;
                }
                
                // Look for test failure with pattern: Test '[1] Status code...' failed: after 3 ms
                const testFailedMatch = trimmedLine.match(/Test '\[(\d+)\]\s+(.+?)'\s+failed:\s+after\s+(\d+)\s+ms/);
                if (testFailedMatch) {
                    const testNumber = parseInt(testFailedMatch[1]);
                    const testDescription = testFailedMatch[2];
                    const duration = testFailedMatch[3] + 'ms';
                    
                    if (!foundTestNumbers.includes(testNumber)) {
                        foundTestNumbers.push(testNumber);
                    }
                    
                    HttpRequestRunner.outputChannel.appendLine(`Found failed test [${testNumber}]: ${testDescription}`);
                    
                    // Update existing test or create new one
                    let failedTest = testMap.get(testNumber);
                    if (!failedTest) {
                        failedTest = {
                            Name: `[${testNumber}] ${testDescription}`,
                            Status: 'Failed',
                            Duration: duration
                        };
                        
                        // Extract HTTP method and URL for this test
                        try {
                            const httpContent = fs.readFileSync(filePath, 'utf8');
                            const httpLines = httpContent.split('\n');
                            for (const httpLine of httpLines) {
                                const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                                if (methodMatch) {
                                    failedTest.Request = {
                                        Method: methodMatch[1].toUpperCase(),
                                        Url: methodMatch[2].trim(),
                                        Headers: {}
                                    };
                                    break;
                                }
                            }
                        } catch (error) {
                            HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file: ${error}`);
                        }
                    } else {
                        // Update existing test
                        failedTest.Status = 'Failed';
                        failedTest.Duration = duration;
                    }
                    
                    // Look for reason on next line
                    if (i + 1 < lines.length) {
                        const reasonMatch = lines[i + 1].trim().match(/Reason:\s+(.+)/);
                        if (reasonMatch) {
                            failedTest.ErrorMessage = reasonMatch[1];
                        }
                    }
                    
                    testMap.set(testNumber, failedTest);
                    isSuccess = false;
                    continue;
                }
                
                // Look for test completion with pattern: Test Passed: '[2] Response should have body.' in 0 ms
                const testPassMatch = trimmedLine.match(/Test Passed: '\[(\d+)\]\s+(.+?)'\s+in\s+(\d+)\s+ms/);
                if (testPassMatch) {
                    const testNumber = parseInt(testPassMatch[1]);
                    const testDescription = testPassMatch[2];
                    const duration = testPassMatch[3] + 'ms';
                    
                    if (!foundTestNumbers.includes(testNumber)) {
                        foundTestNumbers.push(testNumber);
                    }
                    
                    HttpRequestRunner.outputChannel.appendLine(`Found passed test [${testNumber}]: ${testDescription}`);
                    
                    // Update existing test or create new one
                    let passedTest = testMap.get(testNumber);
                    if (!passedTest) {
                        passedTest = {
                            Name: `[${testNumber}] ${testDescription}`,
                            Status: 'Passed',
                            Duration: duration
                        };
                        
                        // Extract HTTP method and URL for this test
                        try {
                            const httpContent = fs.readFileSync(filePath, 'utf8');
                            const httpLines = httpContent.split('\n');
                            for (const httpLine of httpLines) {
                                const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                                if (methodMatch) {
                                    passedTest.Request = {
                                        Method: methodMatch[1].toUpperCase(),
                                        Url: methodMatch[2].trim(),
                                        Headers: {}
                                    };
                                    break;
                                }
                            }
                        } catch (error) {
                            HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file: ${error}`);
                        }
                    } else {
                        // Update existing test
                        passedTest.Status = 'Passed';
                        passedTest.Duration = duration;
                    }
                    
                    // Add response for passed tests
                    if (passedTest.Request) {
                        passedTest.Response = {
                            StatusCode: 200,
                            StatusText: 'OK',
                            Headers: {},
                            Duration: '0ms'
                        };
                    }
                    
                    testMap.set(testNumber, passedTest);
                    isSuccess = true;
                    continue;
                }
                
                // Look for non-numbered tests (like CSX script tests)
                const testPassMatchOld = trimmedLine.match(/Test Passed: '(.+?)' in (\d+) ms/);
                if (testPassMatchOld && !testPassMatchOld[1].includes('[')) {
                    const testName = testPassMatchOld[1];
                    const duration = testPassMatchOld[2] + 'ms';
                    
                    HttpRequestRunner.outputChannel.appendLine(`Found non-numbered passed test: ${testName}`);
                    
                    const passedTest: TeaPieTest = {
                        Name: testName,
                        Status: 'Passed',
                        Duration: duration
                    };
                    
                    // Extract HTTP method and URL for this test
                    try {
                        const httpContent = fs.readFileSync(filePath, 'utf8');
                        const httpLines = httpContent.split('\n');
                        for (const httpLine of httpLines) {
                            const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                            if (methodMatch) {
                                passedTest.Request = {
                                    Method: methodMatch[1].toUpperCase(),
                                    Url: methodMatch[2].trim(),
                                    Headers: {}
                                };
                                passedTest.Response = {
                                    StatusCode: 200,
                                    StatusText: 'OK',
                                    Headers: {},
                                    Duration: duration
                                };
                                break;
                            }
                        }
                    } catch (error) {
                        HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file: ${error}`);
                    }
                    
                    nonNumberedTests.push(passedTest);
                    isSuccess = true;
                    continue;
                }
                
                // Look for overall success/failure
                if (trimmedLine.includes('Success! All') && trimmedLine.includes('tests passed')) {
                    isSuccess = true;
                }
                
                if (trimmedLine.includes('Failed:') || trimmedLine.includes('tests failed')) {
                    isSuccess = false;
                }
            }
            
            // Convert testMap to sorted array and add to testSuite first (numbered tests)
            const sortedTests = Array.from(testMap.entries())
                .sort((a, b) => a[0] - b[0]) // Sort by test number
                .map(([_, test]) => test);
            
            testSuite.Tests.push(...sortedTests);
            
            // Then add non-numbered tests at the end
            testSuite.Tests.push(...nonNumberedTests);
            
            // Check for missing test numbers - if we have [2], [3], [4] but no [1], create a failed [1]
            if (foundTestNumbers.length > 0) {
                const minTest = Math.min(...foundTestNumbers);
                const maxTest = Math.max(...foundTestNumbers);
                
                for (let testNum = 1; testNum <= maxTest; testNum++) {
                    if (!foundTestNumbers.includes(testNum)) {
                        HttpRequestRunner.outputChannel.appendLine(`Missing test [${testNum}] - creating failed test`);
                        
                        // Try to extract HTTP method and URL
                        let request: any = {
                            Method: 'GET',
                            Url: 'Unknown',
                            Headers: {}
                        };
                        
                        try {
                            const httpContent = fs.readFileSync(filePath, 'utf8');
                            const httpLines = httpContent.split('\n');
                            for (const httpLine of httpLines) {
                                const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                                if (methodMatch) {
                                    request = {
                                        Method: methodMatch[1].toUpperCase(),
                                        Url: methodMatch[2].trim(),
                                        Headers: {}
                                    };
                                    break;
                                }
                            }
                        } catch (error) {
                            HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file for missing test: ${error}`);
                        }
                        
                        const missingTest: TeaPieTest = {
                            Name: `[${testNum}] Test Failed (not found in output)`,
                            Status: 'Failed',
                            Duration: '0ms',
                            Request: request,
                            ErrorMessage: 'This test failed and was not reported in the output. Check the console for details.'
                        };
                        
                        testSuite.Tests.unshift(missingTest); // Add at the beginning
                        isSuccess = false;
                    }
                }
                
                // Re-sort tests after adding missing ones
                testSuite.Tests.sort((a, b) => {
                    const aMatch = a.Name.match(/^\[(\d+)\]/);
                    const bMatch = b.Name.match(/^\[(\d+)\]/);
                    if (aMatch && bMatch) {
                        return parseInt(aMatch[1]) - parseInt(bMatch[1]);
                    }
                    return 0;
                });
            }
            
            // If no specific tests found but we have success indication, create a generic successful test
            if (testSuite.Tests.length === 0 && isSuccess) {
                // Try to extract HTTP method and URL from the file
                let request: any = {
                    Method: 'GET',
                    Url: 'Unknown',
                    Headers: {}
                };
                
                try {
                    const httpContent = fs.readFileSync(filePath, 'utf8');
                    const httpLines = httpContent.split('\n');
                    for (const httpLine of httpLines) {
                        const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                        if (methodMatch) {
                            request = {
                                Method: methodMatch[1].toUpperCase(),
                                Url: methodMatch[2].trim(),
                                Headers: {}
                            };
                            break;
                        }
                    }
                } catch (error) {
                    HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file for fallback: ${error}`);
                }
                
                testSuite.Tests.push({
                    Name: 'HTTP Request Test',
                    Status: 'Passed',
                    Duration: '0ms',
                    Request: request,
                    Response: {
                        StatusCode: 200,
                        StatusText: 'OK',
                        Headers: {},
                        Duration: '0ms'
                    }
                });
            }
            
            // If no tests found and no success indication, but we have output, create a failed test
            if (testSuite.Tests.length === 0 && !isSuccess && stdout.trim().length > 0) {
                // Try to extract HTTP method and URL from the file
                let request: any = {
                    Method: 'GET',
                    Url: 'Unknown',
                    Headers: {}
                };
                
                try {
                    const httpContent = fs.readFileSync(filePath, 'utf8');
                    const httpLines = httpContent.split('\n');
                    for (const httpLine of httpLines) {
                        const methodMatch = httpLine.trim().match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                        if (methodMatch) {
                            request = {
                                Method: methodMatch[1].toUpperCase(),
                                Url: methodMatch[2].trim(),
                                Headers: {}
                            };
                            break;
                        }
                    }
                } catch (error) {
                    HttpRequestRunner.outputChannel.appendLine(`Error reading HTTP file for failed test: ${error}`);
                }
                
                // Look for error messages in the stdout
                const errorLines = lines.filter(line => 
                    line.includes('[ERR]') || 
                    line.includes('[ERROR]') || 
                    line.includes('Failed:') ||
                    line.includes('Error:')
                );
                
                const errorMessage = errorLines.length > 0 ? errorLines.join('\n') : 'Test execution failed - check output for details';
                
                testSuite.Tests.push({
                    Name: 'HTTP Request Test',
                    Status: 'Failed',
                    Duration: '0ms',
                    Request: request,
                    ErrorMessage: errorMessage
                });
            }
            
            testSuite.Status = isSuccess ? 'Passed' : 'Failed';
            result.TestSuites.TestSuite.push(testSuite);
            
            return result;
            
        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`Stdout parsing error: ${error}`);
            
            // Return a basic result with error info
            return {
                TestSuites: {
                    TestSuite: [{
                        Name: path.basename(filePath),
                        FilePath: filePath,
                        Tests: [{
                            Name: 'Parse Error',
                            Status: 'Failed',
                            Duration: '0s',
                            ErrorMessage: `Failed to parse stdout: ${error}`
                        }],
                        Status: 'Failed',
                        Duration: '0s'
                    }]
                }
            };
        }
    }

    private static parseXmlReport(xmlContent: string, filePath: string): TeaPieResult {
        // Simple XML parsing for TeaPie report format
        // This is a basic implementation - for production use, consider using a proper XML parser
        
        const result: TeaPieResult = {
            TestSuites: {
                TestSuite: []
            }
        };

        try {
            // Extract test suites using regex (basic approach)
            const testSuiteRegex = /<testsuite[^>]*name="([^"]*)"[^>]*time="([^"]*)"[^>]*failures="([^"]*)"[^>]*>(.*?)<\/testsuite>/gs;
            const testCaseRegex = /<testcase[^>]*name="([^"]*)"[^>]*time="([^"]*)"[^>]*>(.*?)<\/testcase>/gs;
            
            let suiteMatch;
            while ((suiteMatch = testSuiteRegex.exec(xmlContent)) !== null) {
                const suiteName = suiteMatch[1];
                const suiteTime = suiteMatch[2];
                const failures = parseInt(suiteMatch[3] || '0');
                const suiteContent = suiteMatch[4];
                
                const testSuite: TeaPieTestSuite = {
                    Name: suiteName,
                    FilePath: filePath,
                    Tests: [],
                    Status: failures === 0 ? 'Passed' : 'Failed',
                    Duration: suiteTime + 's'
                };

                let testMatch;
                while ((testMatch = testCaseRegex.exec(suiteContent)) !== null) {
                    const testName = testMatch[1];
                    const testTime = testMatch[2];
                    const testContent = testMatch[3];
                    
                    const test: TeaPieTest = {
                        Name: testName,
                        Status: testContent.includes('<failure') || testContent.includes('<error') ? 'Failed' : 'Passed',
                        Duration: testTime + 's'
                    };

                    // Try to extract request/response info from stdout/system-out
                    const systemOutMatch = testContent.match(/<system-out><!\[CDATA\[(.*?)\]\]><\/system-out>/s);
                    if (systemOutMatch) {
                        const output = systemOutMatch[1];
                        
                        // Parse request info (basic parsing)
                        const requestMatch = output.match(/Request:\s*(\w+)\s+(.+)/);
                        if (requestMatch) {
                            test.Request = {
                                Method: requestMatch[1],
                                Url: requestMatch[2].trim(),
                                Headers: {}
                            };
                        }

                        // Parse response info (basic parsing)
                        const responseMatch = output.match(/Response:\s*(\d+)\s*(.+)/);
                        if (responseMatch) {
                            test.Response = {
                                StatusCode: parseInt(responseMatch[1]),
                                StatusText: responseMatch[2].trim(),
                                Headers: {},
                                Duration: testTime + 's'
                            };
                        }
                    }

                    // Extract error messages
                    const failureMatch = testContent.match(/<failure[^>]*><!\[CDATA\[(.*?)\]\]><\/failure>/s);
                    if (failureMatch) {
                        test.ErrorMessage = failureMatch[1];
                    }

                    testSuite.Tests.push(test);
                }

                result.TestSuites.TestSuite.push(testSuite);
            }

            return result;
        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`XML parsing error: ${error}`);
            
            // Return a basic result with error info
            return {
                TestSuites: {
                    TestSuite: [{
                        Name: path.basename(filePath),
                        FilePath: filePath,
                        Tests: [{
                            Name: 'Parse Error',
                            Status: 'Failed',
                            Duration: '0s',
                            ErrorMessage: `Failed to parse test results: ${error}`
                        }],
                        Status: 'Failed',
                        Duration: '0s'
                    }]
                }
            };
        }
    }

    private static parseHttpFile(filePath: string): Array<{Method: string, Url: string, Headers: {[key: string]: string}, Body?: string}> {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            const requests: Array<{Method: string, Url: string, Headers: {[key: string]: string}, Body?: string}> = [];
            
            let currentRequest: {Method: string, Url: string, Headers: {[key: string]: string}, Body?: string} | null = null;
            let isBody = false;
            let bodyLines: string[] = [];
            
            for (const line of lines) {
                const trimmed = line.trim();
                
                // Skip comments and empty lines
                if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed === '') {
                    continue;
                }
                
                // Check for HTTP method line
                const methodMatch = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                if (methodMatch) {
                    // Save previous request if exists
                    if (currentRequest) {
                        if (bodyLines.length > 0) {
                            currentRequest.Body = bodyLines.join('\n');
                        }
                        requests.push(currentRequest);
                    }
                    
                    // Start new request
                    currentRequest = {
                        Method: methodMatch[1].toUpperCase(),
                        Url: methodMatch[2].trim(),
                        Headers: {}
                    };
                    isBody = false;
                    bodyLines = [];
                    continue;
                }
                
                if (currentRequest) {
                    // Check for headers (key: value format)
                   
                    if (!isBody && trimmed.includes(':') && !trimmed.startsWith('{')) {
                        const headerMatch = trimmed.match(/^([^:]+):\s*(.+)/);
                        if (headerMatch) {
                            currentRequest.Headers[headerMatch[1].trim()] = headerMatch[2].trim();
                            continue;
                        }
                    }
                    
                    // If we hit a non-header line after headers, it's the body
                    if (!isBody && trimmed !== '') {
                        isBody = true;
                    }
                    
                    if (isBody && trimmed !== '') {
                        bodyLines.push(line);
                    }
                }
            }
            
            // Save last request if exists
            if (currentRequest) {
                if (bodyLines.length > 0) {
                    currentRequest.Body = bodyLines.join('\n');
                }
                requests.push(currentRequest);
            }
            
            return requests;
        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`Error parsing HTTP file: ${error}`);
            return [];
        }
    }

    private static findResponseInOutput(lines: string[], request: {Method: string, Url: string, Headers: {[key: string]: string}, Body?: string}, index: number): {response: any, duration: string} | null {
        try {
            // Look for response patterns in the output
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Look for HTTP response status line
                const statusMatch = line.match(/HTTP\/[\d.]+\s+(\d+)\s+(.+)/i);
                if (statusMatch) {
                    const statusCode = parseInt(statusMatch[1]);
                    const statusText = statusMatch[2].trim();
                    
                    const response: any = {
                        StatusCode: statusCode,
                        StatusText: statusText,
                        Headers: {},
                        Duration: '0ms'
                    };
                    
                    // Look for response headers in following lines
                    let j = i + 1;
                    while (j < lines.length && lines[j].trim() !== '') {
                        const headerLine = lines[j].trim();
                        const headerMatch = headerLine.match(/^([^:]+):\s*(.+)/);
                        if (headerMatch) {
                            response.Headers[headerMatch[1].trim()] = headerMatch[2].trim();
                        }
                        j++;
                    }
                    
                    // Look for response body
                    if (j < lines.length) {
                        const bodyLines = [];
                        j++; // Skip empty line
                        while (j < lines.length && !lines[j].trim().startsWith('HTTP/')) {
                            if (lines[j].trim() !== '') {
                                bodyLines.push(lines[j]);
                            }
                            j++;
                        }
                        if ( bodyLines.length > 0) {
                            response.Body = bodyLines.join('\n');
                        }
                    }
                    
                    // Try to find duration
                    const durationMatch = line.match(/(\d+)\s*ms/);
                    if (durationMatch) {
                        response.Duration = durationMatch[1] + 'ms';
                    }
                    
                    return { response, duration: response.Duration };
                }
                
                // Alternative: look for status code patterns
                const statusCodeMatch = line.match(/(\d{3})\s+[\w\s]+/);
                if (statusCodeMatch && parseInt(statusCodeMatch[1]) >= 100) {
                    const statusCode = parseInt(statusCodeMatch[1]);
                    const response: any = {
                        StatusCode: statusCode,
                        StatusText: statusCode >= 200 && statusCode < 300 ? 'OK' : 
                                   statusCode >= 400 ? 'Client Error' : 'Unknown',
                        Headers: {},
                        Duration: '0ms'
                    };
                    
                    return { response, duration: '0ms' };
                }
            }
            
                       
            return null;
        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`Error finding response in output: ${error}`);
            return null;
        }
    }

    private static extractHttpInfoFromOutput(lines: string[]): {request?: any, response?: any} | null {
        try {
            let request: any = null;
            let response: any = null;
            
            for (const line of lines) {
                const trimmed = line.trim();
                
                // Look for request method and URL
                const requestMatch = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
                if (requestMatch && !request) {
                    request = {
                        Method: requestMatch[1].toUpperCase(),
                        Url: requestMatch[2].trim(),
                        Headers: {}
                    };
                }
                
                // Look for response status
                const responseMatch = trimmed.match(/HTTP\/[\d.]+\s+(\d+)\s+(.+)|(\d{3})\s+[\w\s]+/i);
                if (responseMatch && !response) {
                    const statusCode = parseInt(responseMatch[1] || responseMatch[3]);
                    response = {
                        StatusCode: statusCode,
                        StatusText: responseMatch[2] || (statusCode >= 200 && statusCode < 300 ? 'OK' : 'Error'),
                        Headers: {},
                        Duration: '0ms'
                    };
                }
            }
            
            return request || response ? { request, response } : null;
        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`Error extracting HTTP info from output: ${error}`);
            return null;
        }
    }
}
