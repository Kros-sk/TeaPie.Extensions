import * as fs from 'fs';
import * as vscode from 'vscode';

export class HttpPreviewProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;

    public static show(uri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (HttpPreviewProvider.currentPanel) {
            HttpPreviewProvider.currentPanel.reveal(column);
            HttpPreviewProvider.currentPanel.webview.html = HttpPreviewProvider.getWebviewContent(uri);
            return;
        }

        // Otherwise, create a new panel
        HttpPreviewProvider.currentPanel = vscode.window.createWebviewPanel(
            'httpPreview',
            'HTTP Preview',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        HttpPreviewProvider.currentPanel.webview.html = HttpPreviewProvider.getWebviewContent(uri);

        // Reset when the panel is disposed
        HttpPreviewProvider.currentPanel.onDidDispose(
            () => {
                HttpPreviewProvider.currentPanel = undefined;
            },
            null
        );
    }

    private static getWebviewContent(uri: vscode.Uri): string {
        const content = fs.readFileSync(uri.fsPath, 'utf8');

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
                    html += `<pre class="http-request">${this.syntaxHighlight(requestLine)}</pre>\n`;
                    const [method, ...urlParts] = requestLine.split(' ');
                    const url = urlParts.join(' ');
                    const escapedHeaders = currentHeaders.split('\n')
                        .filter(h => h.includes(':'))
                        .map(h => h.replace(/"/g, '\\"'));

                    // Format body if it exists
                    let formattedBody = bodyContent.trim();
                    if (formattedBody) {
                        try {
                            // Try to parse as JSON first
                            const jsonBody = JSON.parse(formattedBody);
                            formattedBody = JSON.stringify(jsonBody);
                        } catch {
                            // If not JSON, use as is but remove trailing newlines
                            formattedBody = formattedBody.replace(/\n+$/, '');
                        }
                    }
                    
                    html += `<div class="request-actions">
                        <button class="copy-curl-btn" onclick="copyCurlCommand(this)" 
                            data-method="${method}"
                            data-url="${url}"
                            data-headers="${JSON.stringify(escapedHeaders).replace(/"/g, '&quot;')}"
                            data-body="${formattedBody.replace(/"/g, '&quot;')}">
                            Copy as cURL
                        </button>
                    </div>\n`;
                }

                // Add headers with title if any
                if (currentHeaders) {
                    html += `<div class="section-title">Headers</div>\n`;
                    html += `<pre class="http-headers">${this.syntaxHighlight(currentHeaders)}</pre>\n`;
                }

                // Add body with title if any
                if (bodyContent.trim()) {
                    html += `<div class="section-title">Body</div>\n`;
                    const formattedBody = this.formatBody(bodyContent);
                    html += `<pre class="http-body"><code>${this.syntaxHighlight(formattedBody)}</code></pre>\n`;
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
                    .http-request,
                    .http-headers,
                    .http-body {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 12px;
                        border-radius: 4px;
                        margin: 8px 0;
                        font-family: monospace;
                        white-space: pre-wrap;
                    }
                    .comment {
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        margin: 0.5em 0;
                    }
                    .string { color: var(--vscode-debugTokenExpression-string); }
                    .number { color: var(--vscode-debugTokenExpression-number); }
                    .boolean { color: var(--vscode-debugTokenExpression-boolean); }
                    .null { color: var(--vscode-debugTokenExpression-error); }
                    .key { color: var(--vscode-debugTokenExpression-name); }
                    .method { color: var(--vscode-debugIcon-startForeground); font-weight: bold; }
                    .url { color: var(--vscode-textLink-foreground); }
                    .header-name { color: var(--vscode-debugTokenExpression-name); }
                    .header-value { color: var(--vscode-debugTokenExpression-string); }
                    .request-actions {
                        display: flex;
                        gap: 8px;
                        margin: 8px 0;
                    }
                    .copy-curl-btn {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 6px 12px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    }
                    .copy-curl-btn:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                </style>
                <script>
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
                                button.textContent = 'Copied!';
                                setTimeout(() => {
                                    button.textContent = 'Copy as cURL';
                                }, 2000);
                            }).catch(() => {
                                // Fallback for clipboard write failure
                                const textarea = document.createElement('textarea');
                                textarea.value = curlCommand;
                                document.body.appendChild(textarea);
                                textarea.select();
                                document.execCommand('copy');
                                document.body.removeChild(textarea);
                                button.textContent = 'Copied!';
                                setTimeout(() => {
                                    button.textContent = 'Copy as cURL';
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
                            button.textContent = 'Copied!';
                            setTimeout(() => {
                                button.textContent = 'Copy as cURL';
                            }, 2000);
                        }
                    }
                </script>
            </head>
            <body>
                ${html}
            </body>
            </html>
        `;
    }

    private static syntaxHighlight(text: string): string {
        // Highlight HTTP method and URL
        text = text.replace(/^(GET|POST|PUT|DELETE|PATCH)(\s+)([^\n]+)/gm,
            '<span class="method">$1</span>$2<span class="url">$3</span>');

        // Highlight headers
        text = text.replace(/^([^:\n]+)(:)(.+)$/gm,
            '<span class="header-name">$1</span>$2<span class="header-value">$3</span>');

        // Highlight special header format in body
        text = text.replace(/"header-name">\s*"([^"]+)"/g, '"<span class="key">$1</span>"');
        text = text.replace(/"header-value">\s*"([^"]+)"/g, '"<span class="string">$1</span>"');
        text = text.replace(/"header-value">\s*(\d+)/g, '<span class="number">$1</span>');
        text = text.replace(/"header-value">\s*(true|false)/g, '<span class="boolean">$1</span>');
        text = text.replace(/"header-value">\s*(null)/g, '<span class="null">$1</span>');

        return text;
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

            return JSON.stringify(jsonObj, null, 2);
        }

        // For standard JSON, try to parse and format
        try {
            const jsonObj = JSON.parse(body);
            return JSON.stringify(jsonObj, null, 2);
        } catch {
            return body;
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