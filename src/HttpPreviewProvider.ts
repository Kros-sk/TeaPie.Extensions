import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { VariablesProvider } from './VariablesProvider';

export class HttpPreviewProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static currentFile: vscode.Uri | undefined;
    private static fileWatcher: vscode.FileSystemWatcher | undefined;
    private static showVariableValues: boolean = true;

    public static async show(uri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // Store the current file URI
        HttpPreviewProvider.currentFile = uri;

        // Load variables and show output
        const variablesProvider = VariablesProvider.getInstance();
        await variablesProvider.loadVariables(path.dirname(uri.fsPath));
        variablesProvider.showOutput();

        // If we already have a panel, show it
        if (HttpPreviewProvider.currentPanel) {
            HttpPreviewProvider.currentPanel.reveal(column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
            HttpPreviewProvider.currentPanel.webview.html = await HttpPreviewProvider.getWebviewContent(uri);
            return;
        }

        // Otherwise, create a new panel
        HttpPreviewProvider.currentPanel = vscode.window.createWebviewPanel(
            'httpPreview',
            'HTTP Preview',
            column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        HttpPreviewProvider.currentPanel.webview.html = await HttpPreviewProvider.getWebviewContent(uri);

        // Handle messages from the webview
        HttpPreviewProvider.currentPanel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'toggleVariables':
                        HttpPreviewProvider.showVariableValues = !HttpPreviewProvider.showVariableValues;
                        if (HttpPreviewProvider.currentPanel && HttpPreviewProvider.currentFile) {
                            HttpPreviewProvider.currentPanel.webview.html = await HttpPreviewProvider.getWebviewContent(HttpPreviewProvider.currentFile);
                        }
                        return;
                }
            },
            undefined,
            []
        );

        // Setup file watcher if not already set up
        if (!HttpPreviewProvider.fileWatcher) {
            HttpPreviewProvider.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*-req.http');
            
            // Watch for file changes
            HttpPreviewProvider.fileWatcher.onDidChange(async (changedUri) => {
                if (HttpPreviewProvider.currentPanel && 
                    HttpPreviewProvider.currentFile && 
                    changedUri.fsPath === HttpPreviewProvider.currentFile.fsPath) {
                    HttpPreviewProvider.currentPanel.webview.html = await HttpPreviewProvider.getWebviewContent(changedUri);
                }
            });
        }

        // Reset when the panel is disposed
        HttpPreviewProvider.currentPanel.onDidDispose(
            () => {
                HttpPreviewProvider.currentPanel = undefined;
                // Dispose file watcher when panel is closed
                if (HttpPreviewProvider.fileWatcher) {
                    HttpPreviewProvider.fileWatcher.dispose();
                    HttpPreviewProvider.fileWatcher = undefined;
                }
                HttpPreviewProvider.currentFile = undefined;
            },
            null,
            []
        );
    }

    private static generateBreadcrumb(filePath: string): string {
        // Get workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return ''; // Return empty if no workspace
        }

        // Get path relative to workspace
        const relativePath = path.relative(workspaceRoot, filePath);
        
        // Normalize path separators to forward slashes
        const normalizedPath = relativePath.replace(/\\/g, '/');
        
        // Split path into segments
        const segments = normalizedPath.split('/').filter(Boolean);

        // Format each segment to be more readable
        const displaySegments = segments.map(segment => {
            // If it's a test case file, remove the suffix
            if (segment.endsWith('-req.http')) {
                return segment.replace('-req.http', '');
            }
            // Make the segment more readable
            return segment
                .replace(/([A-Z])/g, ' $1') // Add space before capital letters
                .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
                .trim();
        });

        // Generate breadcrumb HTML
        const breadcrumbItems = segments.map((segment, index) => {
            // Create path up to this segment for navigation
            const pathToSegment = path.join(workspaceRoot, ...segments.slice(0, index + 1));
            
            return `
                <span class="breadcrumb-item">
                    <a href="command:teapie-extensions.navigateToFolder?${encodeURIComponent(JSON.stringify(pathToSegment))}">
                        ${displaySegments[index]}
                    </a>
                </span>
                ${index < segments.length - 1 ? '<span class="breadcrumb-separator">/</span>' : ''}
            `;
        }).join('');

        return `
            <div class="breadcrumb">
                <span class="breadcrumb-item">
                    <a href="command:teapie-extensions.navigateToFolder?${encodeURIComponent(JSON.stringify(workspaceRoot))}">
                        Root
                    </a>
                </span>
                ${segments.length > 0 ? '<span class="breadcrumb-separator">/</span>' : ''}
                ${breadcrumbItems}
            </div>
        `;
    }

    private static async getWebviewContent(uri: vscode.Uri): Promise<string> {
        const content = fs.readFileSync(uri.fsPath, 'utf8');
        const variablesProvider = VariablesProvider.getInstance();

        // Parse HTTP content and convert to HTML
        const lines = content.split('\n');
        let html = '';
        let inBody = false;
        let bodyContent = '';
        let currentRequest = '';
        let currentHeaders = '';
        let currentMetadata = '';
        let requestLine = '';
        let directives: string[] = [];

        const finishCurrentRequest = () => {
            if (currentRequest || currentHeaders || requestLine) {
                // Add directives with title if any
                if (currentMetadata) {
                    html += `<div class="section-title">Directives</div>\n`;
                    html += `<div class="metadata">${currentMetadata}</div>\n`;
                    currentMetadata = '';
                }

                // Add request line if any
                if (requestLine) {
                    html += `<div class="section-title">Request</div>\n`;
                    const processedRequestLine = variablesProvider.replaceVariables(requestLine, HttpPreviewProvider.showVariableValues);
                    const [method, ...urlParts] = processedRequestLine.split(' ');
                    const url = urlParts.join(' ');
                    const escapedHeaders = currentHeaders.split('\n')
                        .filter(h => h.includes(':'))
                        .map(h => variablesProvider.replaceVariables(h, HttpPreviewProvider.showVariableValues))
                        .map(h => h.replace(/"/g, '\\"'));

                    // Format body if it exists
                    let formattedBody = bodyContent.trim();
                    if (formattedBody) {
                        formattedBody = variablesProvider.replaceVariables(formattedBody, HttpPreviewProvider.showVariableValues);
                        try {
                            // Try to parse as JSON first
                            const jsonBody = JSON.parse(formattedBody);
                            formattedBody = JSON.stringify(jsonBody);
                        } catch {
                            // If not JSON, use as is but remove trailing newlines
                            formattedBody = formattedBody.replace(/\n+$/, '');
                        }
                    }

                    html += `<div class="http-request">
                        ${this.syntaxHighlight(processedRequestLine)}
                        <button class="copy-curl-btn" onclick="copyCurlCommand(this)" 
                            data-method="${method}"
                            data-url="${url}"
                            data-headers="${JSON.stringify(escapedHeaders).replace(/"/g, '&quot;')}"
                            data-body="${formattedBody.replace(/"/g, '&quot;')}"
                            title="Copy as cURL">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                                <path fill-rule="evenodd" clip-rule="evenodd" d="M4 4h8v1H4V4zm0 3h8v1H4V7zm0 3h8v1H4v-1z"/>
                                <path fill-rule="evenodd" clip-rule="evenodd" d="M3 3L2 2V14L3 15H13L14 14V2L13 1H3L2 2V14L3 15V3Z"/>
                            </svg>
                        </button>
                    </div>\n`;
                }

                // Add headers with title if any
                if (currentHeaders) {
                    html += `<div class="section-title">Headers</div>\n`;
                    const processedHeaders = variablesProvider.replaceVariables(currentHeaders, HttpPreviewProvider.showVariableValues);
                    html += `<pre class="http-headers">${this.syntaxHighlight(processedHeaders)}</pre>\n`;
                }

                // Add body with title if any
                if (bodyContent.trim()) {
                    html += `<div class="section-title">Body</div>\n`;
                    const processedBody = variablesProvider.replaceVariables(bodyContent, HttpPreviewProvider.showVariableValues);
                    const formattedBody = this.formatBody(processedBody);
                    html += `<pre class="http-body"><code>${formattedBody}</code></pre>\n`;
                }

                currentRequest = '';
                currentHeaders = '';
                requestLine = '';
                bodyContent = '';
                inBody = false;
            }
        };

        for (const line of lines) {
            // Skip empty lines at the start
            if (!html && !line.trim()) {
                continue;
            }

            // Handle request separator
            if (line.startsWith('###')) {
                finishCurrentRequest();
                const title = line.replace(/^###\s*/, '').trim();
                if (title) {
                    html += `<h3 class="request-name">${title}</h3>\n`;
                }
                continue;
            }

            // Handle comments
            if (line.startsWith('# ') || line.startsWith('// ')) {
                const comment = line.replace(/^[#/]+\s*/, '');
                if (comment.startsWith('@name')) {
                    currentRequest = comment.replace('@name', '').trim();
                    html += `<h3 class="request-name">${currentRequest}</h3>\n`;
                } else if (comment.startsWith('##')) {
                    // Handle directives
                    const directive = comment.replace('##', '').trim();
                    directives.push(directive);
                    currentMetadata += this.formatDirective(directive);
                } else {
                    html += `<div class="comment">${comment}</div>\n`;
                }
                continue;
            }

            // Handle HTTP method and URL
            if (line.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/)) {
                requestLine = line;
                inBody = false;
                continue;
            }

            // Handle headers
            if (line.includes(':') && !inBody) {
                // Check if this is a directive (starts with ##)
                if (line.trim().startsWith('##')) {
                    const directive = line.trim().substring(2).trim();
                    directives.push(directive);
                    currentMetadata += this.formatDirective(directive);
                } else {
                    currentHeaders += (currentHeaders ? '\n' : '') + line;
                }
                continue;
            }

            // Handle body
            if (!inBody && line.trim() === '') {
                inBody = true;
                continue;
            }

            if (inBody) {
                bodyContent += line + '\n';
            }
        }

        // Finish the last request
        finishCurrentRequest();

        // Add toggle button to the top of the page
        const toggleButton = `
            <div class="toolbar">
                <button onclick="toggleVariables()" class="toggle-btn">
                    ${HttpPreviewProvider.showVariableValues ? 'Show Variable Names' : 'Show Variable Values'}
                </button>
            </div>
        `;

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
                    .section-title {
                        color: var(--vscode-descriptionForeground);
                        font-size: 0.9em;
                        text-transform: uppercase;
                        letter-spacing: 0.1em;
                        margin: 1em 0 0.5em;
                        border-bottom: 1px solid var(--vscode-widget-border);
                        padding-bottom: 0.3em;
                    }
                    h3 {
                        color: var(--vscode-editor-foreground);
                        margin-top: 1.5em;
                        margin-bottom: 0.5em;
                    }
                    .request-name {
                        color: var(--vscode-textLink-foreground);
                        font-size: 1.2em;
                        font-weight: 600;
                    }
                    .directive {
                        display: inline-block;
                        padding: 3px 8px;
                        border-radius: 4px;
                        margin: 2px;
                        font-family: monospace;
                        font-size: 0.9em;
                        border: 1px solid transparent;
                        cursor: help;
                    }
                    .directive.retry {
                        background-color: var(--vscode-debugConsole-warningForeground);
                        color: var(--vscode-editor-background);
                        border-color: var(--vscode-debugConsole-warningForeground);
                    }
                    .directive.auth {
                        background-color: var(--vscode-debugConsole-infoForeground);
                        color: var(--vscode-editor-background);
                        border-color: var(--vscode-debugConsole-infoForeground);
                    }
                    .directive.test {
                        background-color: var(--vscode-testing-iconPassed);
                        color: var(--vscode-editor-background);
                        border-color: var(--vscode-testing-iconPassed);
                    }
                    .directive.other {
                        background-color: var(--vscode-badge-background);
                        color: var(--vscode-badge-foreground);
                        border-color: var(--vscode-badge-background);
                    }
                    .directive-name {
                        font-weight: 600;
                    }
                    .directive-separator {
                        margin: 0 4px;
                        opacity: 0.8;
                    }
                    .directive-value {
                        opacity: 0.9;
                    }
                    .metadata {
                        margin: 8px 0;
                        display: flex;
                        flex-wrap: wrap;
                        gap: 4px;
                    }
                    .http-request {
                        position: relative;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 8px 12px;
                        border-radius: 4px;
                        margin: 8px 0;
                        font-family: monospace;
                        white-space: pre-wrap;
                        min-height: 32px;
                        display: flex;
                        align-items: center;
                    }
                    .copy-curl-btn {
                        position: absolute;
                        top: 50%;
                        transform: translateY(-50%);
                        right: 12px;
                        background: none;
                        border: none;
                        padding: 4px;
                        cursor: pointer;
                        color: var(--vscode-descriptionForeground);
                        opacity: 0.6;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        border-radius: 3px;
                        height: 24px;
                        width: 24px;
                    }
                    .http-request > :first-child {
                        margin-right: 32px;
                        padding: 0;
                    }
                    .copy-curl-btn:hover {
                        opacity: 1;
                        background-color: var(--vscode-toolbar-hoverBackground);
                    }
                    .copy-curl-btn.copied {
                        color: var(--vscode-gitDecoration-addedResourceForeground);
                    }
                    .http-request,
                    .http-headers,
                    .http-body {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 12px;
                        border-radius: 4px;
                        margin: 8px 0;
                        font-family: monospace;
                        white-space: pre-wrap;
                        tab-size: 4;
                    }
                    .http-body code {
                        display: block;
                        line-height: 1.5;
                        background-color: transparent;
                    }
                    .comment {
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        margin: 0.5em 0;
                    }
                    /* JSON syntax highlighting */
                    .json-string { 
                        color: var(--vscode-debugTokenExpression-string);
                    }
                    .json-number { 
                        color: var(--vscode-debugTokenExpression-number);
                    }
                    .json-boolean { 
                        color: var(--vscode-debugTokenExpression-boolean);
                        font-weight: bold;
                    }
                    .json-null { 
                        color: var(--vscode-debugTokenExpression-error);
                        font-weight: bold;
                    }
                    .json-key { 
                        color: var(--vscode-debugTokenExpression-name);
                        font-weight: bold;
                    }
                    .method { color: var(--vscode-debugIcon-startForeground); font-weight: bold; }
                    .url { color: var(--vscode-textLink-foreground); }
                    .header-name { color: var(--vscode-debugTokenExpression-name); }
                    .header-value { color: var(--vscode-debugTokenExpression-string); }
                    .request-actions {
                        display: flex;
                        gap: 8px;
                        margin: 8px 0;
                    }
                    .breadcrumb {
                        padding: 10px;
                        background-color: var(--vscode-editor-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        margin-bottom: 20px;
                    }
                    .breadcrumb-item {
                        display: inline-block;
                    }
                    .breadcrumb-item a {
                        color: var(--vscode-textLink-foreground);
                        text-decoration: none;
                    }
                    .breadcrumb-item a:hover {
                        text-decoration: underline;
                    }
                    .breadcrumb-separator {
                        margin: 0 8px;
                        color: var(--vscode-descriptionForeground);
                    }
                    .toolbar {
                        position: sticky;
                        top: 0;
                        background-color: var(--vscode-editor-background);
                        padding: 10px 0;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        z-index: 1000;
                        margin-bottom: 20px;
                    }
                    .toggle-btn {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    .toggle-btn:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                </style>
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function toggleVariables() {
                        vscode.postMessage({
                            command: 'toggleVariables'
                        });
                    }
                    
                    function copyCurlCommand(button) {
                        const method = button.getAttribute('data-method') || '';
                        const url = button.getAttribute('data-url') || '';
                        const headers = JSON.parse(button.getAttribute('data-headers') || '[]');
                        const body = button.getAttribute('data-body') || '';

                        let curlCmd = ['curl'];
                        
                        // Add method if not GET
                        if (method !== 'GET') {
                            curlCmd.push(\`-X \${method}\`);
                        }

                        // Add URL
                        curlCmd.push(\`"\${url}"\`);

                        // Add headers
                        headers.forEach(header => {
                            const [name, ...values] = header.split(':');
                            if (name && values.length) {
                                curlCmd.push(\`-H "\${name.trim()}: \${values.join(':').trim()}"\`);
                            }
                        });

                        // Add Content-Type header if body exists and it's not already set
                        if (body && !headers.some(h => h.toLowerCase().startsWith('content-type:'))) {
                            try {
                                JSON.parse(body);
                                curlCmd.push('-H "Content-Type: application/json"');
                            } catch {
                                curlCmd.push('-H "Content-Type: text/plain"');
                            }
                        }

                        // Add body if exists and method is not GET
                        if (body && method !== 'GET') {
                            try {
                                // Try to parse as JSON first to validate
                                JSON.parse(body);
                                // Use the original body string to preserve formatting
                                curlCmd.push(\`-d '\${body}'\`);
                            } catch {
                                // If not valid JSON, send as plain text
                                curlCmd.push(\`-d '\${body}'\`);
                            }
                        }

                        // Copy to clipboard
                        const curlCommand = curlCmd.join(' ');
                        
                        try {
                            navigator.clipboard.writeText(curlCommand).then(() => {
                                button.classList.add('copied');
                                setTimeout(() => {
                                    button.classList.remove('copied');
                                }, 2000);
                            }).catch(() => {
                                // Fallback for clipboard write failure
                                const textarea = document.createElement('textarea');
                                textarea.value = curlCommand;
                                document.body.appendChild(textarea);
                                textarea.select();
                                document.execCommand('copy');
                                document.body.removeChild(textarea);
                                button.classList.add('copied');
                                setTimeout(() => {
                                    button.classList.remove('copied');
                                }, 2000);
                            });
                        } catch (error) {
                            // Fallback for old browsers
                            const textarea = document.createElement('textarea');
                            textarea.value = curlCommand;
                            document.body.appendChild(textarea);
                            textarea.select();
                            document.execCommand('copy');
                            document.body.removeChild(textarea);
                            button.classList.add('copied');
                            setTimeout(() => {
                                button.classList.remove('copied');
                            }, 2000);
                        }
                    }
                </script>
            </head>
            <body>
                ${toggleButton}
                ${this.generateBreadcrumb(uri.fsPath)}
                ${html}
            </body>
            </html>
        `;
    }

    private static formatBody(body: string): string {
        // For special header format, convert to standard JSON
        if (body.includes('"header-name">') || body.includes('"header-value">')) {
            const lines = body.split('\n');
            const jsonObj: { [key: string]: any } = {};

            for (const line of lines) {
                const match = line.match(/"header-name">\s*"([^"]+)":\s*"header-value">\s*(.+?),?\s*$/);
                if (match) {
                    const [, key, value] = match;
                    // Try to parse the value as JSON if possible
                    try {
                        jsonObj[key] = JSON.parse(value);
                    } catch {
                        jsonObj[key] = value.replace(/"/g, '');
                    }
                }
            }

            return this.formatJsonString(JSON.stringify(jsonObj));
        }

        // For standard JSON, try to parse and format
        try {
            // First try to parse as JSON
            const jsonObj = JSON.parse(body.trim());
            return this.formatJsonString(JSON.stringify(jsonObj));
        } catch {
            // If not JSON, try to detect if it's a JSON-like string that needs cleanup
            const cleanBody = body.trim()
                .replace(/,\s*$/, '')  // Remove trailing commas
                .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":'); // Add quotes to unquoted keys
            
            try {
                const jsonObj = JSON.parse(cleanBody);
                return this.formatJsonString(JSON.stringify(jsonObj));
            } catch {
                // If still not JSON, return as is without any highlighting
                return body;
            }
        }
    }

    private static syntaxHighlight(text: string): string {
        // Don't apply syntax highlighting if it looks like JSON
        if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            try {
                JSON.parse(text);
                return this.formatJsonString(text);
            } catch {
                // Continue with regular syntax highlighting if not valid JSON
            }
        }

        // Highlight HTTP method and URL
        text = text.replace(/^(GET|POST|PUT|DELETE|PATCH)(\s+)([^\n]+)/gm,
            '<span class="method">$1</span>$2<span class="url">$3</span>');

        // Highlight headers
        text = text.replace(/^([^:\n]+)(:)(.+)$/gm,
            '<span class="header-name">$1</span>$2<span class="header-value">$3</span>');

        return text;
    }

    private static formatJsonString(jsonString: string): string {
        try {
            const obj = JSON.parse(jsonString);
            return JSON.stringify(obj, null, 4)
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

    private static getDirectiveType(directive: string): string {
        if (directive.startsWith('RETRY-')) {
            return 'retry';
        }
        if (directive.startsWith('AUTH-')) {
            return 'auth';
        }
        if (directive.startsWith('TEST-')) {
            return 'test';
        }
        return 'other';
    }

    private static getDirectiveTooltip(name: string): string {
        const tooltips: { [key: string]: string } = {
            'AUTH-PROVIDER': 'Specifies the authentication provider to use for this request. Must be registered beforehand.',
            'TEST-EXPECT-STATUS': 'Expected HTTP status code(s) for the response.',
            'TEST-HAS-BODY': 'Verifies that the response has a body.',
            'TEST-HAS-HEADER': 'Verifies that the response contains the specified header.',
            'TEST-SUCCESSFUL-STATUS': 'Verifies that the response has a successful status code (2xx).',
            'RETRY-STRATEGY': 'Defines the retry strategy for failed requests.',
            'RETRY-MAX-ATTEMPTS': 'Maximum number of retry attempts.',
            'RETRY-BACKOFF-TYPE': 'Type of delay between retries (Linear, Exponential).',
            'RETRY-MAX-DELAY': 'Maximum delay between retries.',
            'RETRY-UNTIL-STATUS': 'Retry until response matches specified status code(s).'
        };

        return tooltips[name] || 'Configuration directive for the request';
    }

    private static formatDirective(directive: string): string {
        const type = this.getDirectiveType(directive);
        const [name, ...valueParts] = directive.split(':');
        const value = valueParts.join(':').trim();
        const tooltip = this.getDirectiveTooltip(name);

        if (value) {
            return `<div class="directive ${type}" title="${tooltip}">
                <span class="directive-name">${name}</span>
                <span class="directive-separator">:</span>
                <span class="directive-value">${value}</span>
            </div>`;
        } else {
            return `<div class="directive ${type}" title="${tooltip}">
                <span class="directive-name">${name}</span>
            </div>`;
        }
    }
} 