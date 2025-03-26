import * as fs from 'fs';
import * as vscode from 'vscode';

interface HttpRequest {
    name: string;
    method: string;
    url: string;
    headers: { name: string; value: string; }[];
    directives: { name: string; value: string; }[];
    body: string;
    comments: string[];
}

export class VisualTestEditorProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;

    public static show(uri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (VisualTestEditorProvider.currentPanel) {
            VisualTestEditorProvider.currentPanel.reveal(column);
            VisualTestEditorProvider.currentPanel.webview.html = VisualTestEditorProvider.getWebviewContent(uri);
            return;
        }

        // Otherwise, create a new panel
        VisualTestEditorProvider.currentPanel = vscode.window.createWebviewPanel(
            'visualTestEditor',
            'Visual Test Editor',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        VisualTestEditorProvider.currentPanel.webview.html = VisualTestEditorProvider.getWebviewContent(uri);

        // Handle messages from the webview
        VisualTestEditorProvider.currentPanel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'saveRequest':
                        await VisualTestEditorProvider.saveRequest(uri, message.request);
                        break;
                    case 'addDirective':
                        await VisualTestEditorProvider.addDirective(uri, message.directive);
                        break;
                    case 'addHeader':
                        await VisualTestEditorProvider.addHeader(uri, message.header);
                        break;
                    case 'addComment':
                        await VisualTestEditorProvider.addComment(uri, message.comment);
                        break;
                }
            },
            undefined
        );

        // Reset when the panel is disposed
        VisualTestEditorProvider.currentPanel.onDidDispose(
            () => {
                VisualTestEditorProvider.currentPanel = undefined;
            },
            null
        );
    }

    private static parseHttpFile(content: string): HttpRequest[] {
        const requests: HttpRequest[] = [];
        const lines = content.split('\n');
        let currentRequest: HttpRequest | null = null;
        let currentComments: string[] = [];
        let inBody = false;
        let bodyContent = '';

        for (const line of lines) {
            // Skip empty lines at the start
            if (!currentRequest && !line.trim()) {
                continue;
            }

            // Handle request separator
            if (line.startsWith('###')) {
                if (currentRequest) {
                    currentRequest.body = bodyContent.trim();
                    requests.push(currentRequest);
                    bodyContent = '';
                    inBody = false;
                }
                currentRequest = {
                    name: line.replace('###', '').trim(),
                    method: '',
                    url: '',
                    headers: [],
                    directives: [],
                    body: '',
                    comments: []
                };
                currentComments = [];
                continue;
            }

            if (!currentRequest) {
                continue;
            }

            // Handle comments and directives
            if (line.startsWith('# ') || line.startsWith('// ')) {
                const comment = line.replace(/^[#/]+\s*/, '');
                if (comment.startsWith('@name')) {
                    currentRequest.name = comment.replace('@name', '').trim();
                } else {
                    currentComments.push(line.trim());
                }
                continue;
            }

            // Handle directives
            if (line.startsWith('##')) {
                const [name, ...valueParts] = line.replace('##', '').trim().split(':');
                const value = valueParts.join(':').trim();
                currentRequest.directives.push({ name: name.trim(), value });
                continue;
            }

            // Handle HTTP method and URL
            if (line.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/)) {
                const [method, ...urlParts] = line.trim().split(' ');
                currentRequest.method = method;
                currentRequest.url = urlParts.join(' ');
                currentRequest.comments = currentComments;
                currentComments = [];
                continue;
            }

            // Handle headers
            if (line.includes(':') && !inBody) {
                const [name, ...valueParts] = line.split(':');
                const value = valueParts.join(':').trim();
                if (!line.trim().startsWith('##')) {
                    currentRequest.headers.push({ name: name.trim(), value });
                }
                continue;
            }

            // Handle body
            if (line.trim() === '') {
                inBody = true;
                continue;
            }

            if (inBody) {
                bodyContent += line + '\n';
            }
        }

        // Add the last request if any
        if (currentRequest) {
            currentRequest.body = bodyContent.trim();
            requests.push(currentRequest);
        }

        return requests;
    }

    private static async saveRequest(uri: vscode.Uri, request: HttpRequest) {
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const lines = content.split('\n');
            
            // Find the position to insert the new request
            let insertPosition = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('###')) {
                    insertPosition = i;
                    break;
                }
            }

            // Create the new request content
            const newRequest = [
                '### ' + request.name,
                ...request.comments,
                request.method + ' ' + request.url,
                ...request.directives.map(d => `## ${d.name}: ${d.value}`),
                ...request.headers.map(h => `${h.name}: ${h.value}`),
                '',
                request.body
            ].join('\n');

            // Insert the new request
            lines.splice(insertPosition, 0, newRequest);

            // Write back to file
            await fs.promises.writeFile(uri.fsPath, lines.join('\n'));
            vscode.window.showInformationMessage('Request saved successfully');
        } catch (error) {
            vscode.window.showErrorMessage('Failed to save request: ' + error);
        }
    }

    private static async addDirective(uri: vscode.Uri, directive: any) {
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const lines = content.split('\n');
            
            // Find the position to insert the directive
            let insertPosition = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('###')) {
                    insertPosition = i;
                    break;
                }
            }

            // Create the directive line
            const directiveLine = `## ${directive.name}: ${directive.value}`;

            // Insert the directive
            lines.splice(insertPosition, 0, directiveLine);

            // Write back to file
            await fs.promises.writeFile(uri.fsPath, lines.join('\n'));
            vscode.window.showInformationMessage('Directive added successfully');
        } catch (error) {
            vscode.window.showErrorMessage('Failed to add directive: ' + error);
        }
    }

    private static async addHeader(uri: vscode.Uri, header: any) {
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const lines = content.split('\n');
            
            // Find the position to insert the header
            let insertPosition = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('###')) {
                    insertPosition = i + 1; // Insert after the request line
                    break;
                }
            }

            // Create the header line
            const headerLine = `${header.name}: ${header.value}`;

            // Insert the header
            lines.splice(insertPosition, 0, headerLine);

            // Write back to file
            await fs.promises.writeFile(uri.fsPath, lines.join('\n'));
            vscode.window.showInformationMessage('Header added successfully');
        } catch (error) {
            vscode.window.showErrorMessage('Failed to add header: ' + error);
        }
    }

    private static async addComment(uri: vscode.Uri, comment: any) {
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const lines = content.split('\n');
            
            // Find the position to insert the comment
            let insertPosition = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('###')) {
                    insertPosition = i + 1; // Insert after the request line
                    break;
                }
            }

            // Create the comment line
            const commentLine = comment.text.startsWith('//') ? comment.text : `// ${comment.text}`;

            // Insert the comment
            lines.splice(insertPosition, 0, commentLine);

            // Write back to file
            await fs.promises.writeFile(uri.fsPath, lines.join('\n'));
            vscode.window.showInformationMessage('Comment added successfully');
        } catch (error) {
            vscode.window.showErrorMessage('Failed to add comment: ' + error);
        }
    }

    private static getWebviewContent(uri: vscode.Uri): string {
        const content = fs.readFileSync(uri.fsPath, 'utf8');
        const requests = this.parseHttpFile(content);

        // Predefined lists
        const commonDirectives = [
            { name: 'AUTH-PROVIDER', description: 'Authentication provider to use' },
            { name: 'TEST-EXPECT-STATUS', description: 'Expected HTTP status code(s)' },
            { name: 'TEST-HAS-BODY', description: 'Verify response has body' },
            { name: 'TEST-HAS-HEADER', description: 'Verify response has header' },
            { name: 'TEST-SUCCESSFUL-STATUS', description: 'Verify successful status (2xx)' },
            { name: 'RETRY-STRATEGY', description: 'Retry strategy for failed requests' },
            { name: 'RETRY-MAX-ATTEMPTS', description: 'Maximum retry attempts' },
            { name: 'RETRY-BACKOFF-TYPE', description: 'Type of retry delay (Linear/Exponential)' },
            { name: 'RETRY-MAX-DELAY', description: 'Maximum delay between retries' },
            { name: 'RETRY-UNTIL-STATUS', description: 'Retry until status code matches' }
        ];

        const commonHeaders = [
            { name: 'Content-Type', values: ['application/json', 'application/xml', 'text/plain', 'multipart/form-data'] },
            { name: 'Accept', values: ['application/json', 'application/xml', 'text/plain', '*/*'] },
            { name: 'Authorization', values: ['Bearer ', 'Basic '] },
            { name: 'X-Request-ID', values: ['{{$guid}}'] },
            { name: 'X-Client-Version', values: ['1.0.0'] },
            { name: 'X-API-Key', values: ['{{ApiKey}}'] },
            { name: 'Cache-Control', values: ['no-cache', 'max-age=0'] },
            { name: 'User-Agent', values: ['TeaPie/1.0'] }
        ];
        
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                        line-height: 1.6;
                        padding: 20px;
                        margin: 0;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        height: 100vh;
                        box-sizing: border-box;
                    }
                    .container {
                        display: flex;
                        gap: 20px;
                        height: 100%;
                    }
                    .requests-list {
                        width: 300px;
                        flex-shrink: 0;
                        border-right: 1px solid var(--vscode-widget-border);
                        padding-right: 20px;
                        overflow-y: auto;
                        height: 100%;
                    }
                    .editor-container {
                        flex-grow: 1;
                        overflow-y: auto;
                        padding-right: 20px;
                    }
                    .request-form {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 20px;
                        border-radius: 4px;
                        margin-bottom: 20px;
                    }
                    .form-group {
                        margin-bottom: 15px;
                    }
                    .form-row {
                        display: flex;
                        gap: 10px;
                        align-items: flex-start;
                        min-width: 0;
                    }
                    .form-row select {
                        width: 100px;
                        flex-shrink: 0;
                    }
                    .form-row input {
                        flex: 1;
                        min-width: 0;
                    }
                    label {
                        display: block;
                        margin-bottom: 5px;
                        color: var(--vscode-editor-foreground);
                    }
                    input, select, textarea {
                        width: 100%;
                        padding: 8px;
                        border: 1px solid var(--vscode-input-border);
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border-radius: 4px;
                    }
                    button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .headers-list, .directives-list, .comments-list {
                        margin-top: 10px;
                    }
                    .header-item, .directive-item, .comment-item {
                        display: flex;
                        gap: 10px;
                        margin-bottom: 5px;
                    }
                    .remove-btn {
                        background-color: var(--vscode-errorForeground);
                    }
                    .request-item {
                        padding: 10px;
                        margin-bottom: 10px;
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                        cursor: pointer;
                        word-break: break-all;
                        overflow-wrap: break-word;
                    }
                    .request-item:hover {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                    }
                    .request-item.selected {
                        border-color: var(--vscode-focusBorder);
                        background-color: var(--vscode-editor-selectionBackground);
                    }
                    .request-item strong {
                        display: block;
                        margin-bottom: 5px;
                    }
                    .request-item .url-line {
                        display: flex;
                        gap: 8px;
                        align-items: flex-start;
                    }
                    .request-item .method {
                        flex-shrink: 0;
                    }
                    .request-item .url {
                        word-break: break-all;
                        overflow-wrap: break-word;
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
                    .dropdown-content {
                        display: none;
                        position: absolute;
                        background-color: var(--vscode-dropdown-background);
                        border: 1px solid var(--vscode-dropdown-border);
                        border-radius: 4px;
                        max-height: 200px;
                        overflow-y: auto;
                        z-index: 1000;
                        width: 250px;
                    }
                    .dropdown-item {
                        padding: 8px 12px;
                        cursor: pointer;
                    }
                    .dropdown-item:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .dropdown-description {
                        font-size: 0.9em;
                        color: var(--vscode-descriptionForeground);
                        margin-top: 2px;
                    }
                    .header-item, .directive-item {
                        position: relative;
                    }
                    .suggestions {
                        position: absolute;
                        top: 100%;
                        left: 0;
                        background-color: var(--vscode-dropdown-background);
                        border: 1px solid var(--vscode-dropdown-border);
                        border-radius: 4px;
                        max-height: 200px;
                        overflow-y: auto;
                        z-index: 1000;
                        width: 100%;
                        display: none;
                    }
                    .suggestion-item {
                        padding: 4px 8px;
                        cursor: pointer;
                    }
                    .suggestion-item:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="requests-list">
                        <h2>Requests</h2>
                        <div id="requestsList"></div>
                        <button onclick="addNewRequest()">Add New Request</button>
                    </div>

                    <div class="editor-container">
                        <div id="requestForm" class="request-form" style="display: none;">
                            <h2>Edit Request</h2>
                            <div class="form-group">
                                <label for="requestName">Request Name</label>
                                <input type="text" id="requestName" placeholder="Enter request name">
                            </div>
                            <div class="form-group">
                                <label for="comments">Comments</label>
                                <textarea id="comments" rows="3" placeholder="Enter comments (use // or # for each line)"></textarea>
                            </div>
                            <div class="form-group">
                                <label>Request Line</label>
                                <div class="form-row">
                                    <select id="method" onchange="toggleBody()">
                                        <option value="GET">GET</option>
                                        <option value="POST">POST</option>
                                        <option value="PUT">PUT</option>
                                        <option value="DELETE">DELETE</option>
                                        <option value="PATCH">PATCH</option>
                                    </select>
                                    <input type="text" id="url" placeholder="Enter URL">
                                </div>
                            </div>
                            <div class="form-group">
                                <label>Directives</label>
                                <div id="directivesList" class="directives-list"></div>
                                <button onclick="addDirective()">Add Directive</button>
                            </div>
                            <div class="form-group">
                                <label>Headers</label>
                                <div id="headersList" class="headers-list"></div>
                                <button onclick="addHeader()">Add Header</button>
                            </div>
                            <div class="form-group" id="bodyGroup">
                                <label for="body">Body</label>
                                <textarea id="body" rows="10" placeholder="Enter request body"></textarea>
                            </div>
                            <div class="form-group">
                                <button onclick="saveRequest()">Save Request</button>
                                <button onclick="cancelEdit()">Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let requests = ${JSON.stringify(requests)};
                    let currentRequestIndex = -1;
                    const commonDirectives = ${JSON.stringify(commonDirectives)};
                    const commonHeaders = ${JSON.stringify(commonHeaders)};

                    function displayRequests() {
                        const requestsList = document.getElementById('requestsList');
                        requestsList.innerHTML = requests.map((req, index) => \`
                            <div class="request-item \${index === currentRequestIndex ? 'selected' : ''}" onclick="editRequest(\${index})">
                                <strong>\${req.name || 'Unnamed Request'}</strong>
                                <div class="url-line">
                                    <span class="method">\${req.method}</span>
                                    <span class="url">\${req.url}</span>
                                </div>
                            </div>
                        \`).join('');
                    }

                    function editRequest(index) {
                        currentRequestIndex = index;
                        const request = requests[index];
                        
                        document.getElementById('requestName').value = request.name || '';
                        document.getElementById('method').value = request.method;
                        document.getElementById('url').value = request.url;
                        document.getElementById('body').value = request.body || '';
                        document.getElementById('comments').value = request.comments.join('\\n');
                        
                        const headersList = document.getElementById('headersList');
                        headersList.innerHTML = request.headers.map(h => \`
                            <div class="header-item">
                                <div class="form-row">
                                    <input type="text" placeholder="Header name" class="header-name" value="\${h.name}" 
                                        onfocus="showHeaderSuggestions(this)" 
                                        oninput="filterHeaderSuggestions(this)">
                                    <input type="text" placeholder="Header value" class="header-value" value="\${h.value}" 
                                        onfocus="showHeaderValueSuggestions(this)"
                                        oninput="filterHeaderValueSuggestions(this)">
                                    <button class="remove-btn" onclick="this.parentElement.parentElement.remove()">Remove</button>
                                </div>
                                <div class="suggestions"></div>
                            </div>
                        \`).join('');
                        
                        const directivesList = document.getElementById('directivesList');
                        directivesList.innerHTML = request.directives.map(d => \`
                            <div class="directive-item">
                                <div class="form-row">
                                    <input type="text" placeholder="Directive name" class="directive-name" value="\${d.name}" 
                                        onfocus="showDirectiveSuggestions(this)"
                                        oninput="filterDirectiveSuggestions(this)">
                                    <input type="text" placeholder="Directive value" class="directive-value" value="\${d.value}">
                                    <button class="remove-btn" onclick="this.parentElement.parentElement.remove()">Remove</button>
                                </div>
                                <div class="suggestions"></div>
                            </div>
                        \`).join('');
                        
                        document.getElementById('requestForm').style.display = 'block';
                        toggleBody();
                        displayRequests();
                    }

                    function showDirectiveSuggestions(input) {
                        const suggestionsDiv = input.parentElement.nextElementSibling;
                        suggestionsDiv.innerHTML = commonDirectives.map(d => \`
                            <div class="suggestion-item" onclick="selectDirective('\${d.name}', this)">
                                <div>\${d.name}</div>
                                <div class="dropdown-description">\${d.description}</div>
                            </div>
                        \`).join('');
                        suggestionsDiv.style.display = 'block';
                        filterDirectiveSuggestions(input);
                    }

                    function filterDirectiveSuggestions(input) {
                        const suggestionsDiv = input.parentElement.nextElementSibling;
                        const value = input.value.toLowerCase();
                        
                        Array.from(suggestionsDiv.children).forEach(child => {
                            const directiveName = child.querySelector('div').textContent.toLowerCase();
                            child.style.display = directiveName.includes(value) ? 'block' : 'none';
                        });
                    }

                    function showHeaderSuggestions(input) {
                        const suggestionsDiv = input.parentElement.nextElementSibling;
                        suggestionsDiv.innerHTML = commonHeaders.map(h => \`
                            <div class="suggestion-item" onclick="selectHeader('\${h.name}', this)">
                                \${h.name}
                            </div>
                        \`).join('');
                        suggestionsDiv.style.display = 'block';
                        filterHeaderSuggestions(input);
                    }

                    function filterHeaderSuggestions(input) {
                        const suggestionsDiv = input.parentElement.nextElementSibling;
                        const value = input.value.toLowerCase();
                        
                        Array.from(suggestionsDiv.children).forEach(child => {
                            const headerName = child.textContent.toLowerCase();
                            child.style.display = headerName.includes(value) ? 'block' : 'none';
                        });
                    }

                    function showHeaderValueSuggestions(input) {
                        const headerName = input.previousElementSibling.value;
                        const header = commonHeaders.find(h => h.name === headerName);
                        const suggestionsDiv = input.parentElement.nextElementSibling;
                        
                        if (header && header.values.length > 0) {
                            suggestionsDiv.innerHTML = header.values.map(value => \`
                                <div class="suggestion-item" onclick="selectHeaderValue('\${value}', this)">
                                    \${value}
                                </div>
                            \`).join('');
                            suggestionsDiv.style.display = 'block';
                            filterHeaderValueSuggestions(input);
                        }
                    }

                    function filterHeaderValueSuggestions(input) {
                        const suggestionsDiv = input.parentElement.nextElementSibling;
                        const value = input.value.toLowerCase();
                        
                        Array.from(suggestionsDiv.children).forEach(child => {
                            const headerValue = child.textContent.toLowerCase();
                            child.style.display = headerValue.includes(value) ? 'block' : 'none';
                        });
                    }

                    function selectDirective(name, element) {
                        const input = element.closest('.directive-item').querySelector('.directive-name');
                        input.value = name;
                        element.closest('.suggestions').style.display = 'none';
                        input.focus();
                    }

                    function selectHeader(name, element) {
                        const input = element.closest('.header-item').querySelector('.header-name');
                        input.value = name;
                        element.closest('.suggestions').style.display = 'none';
                        const valueInput = input.nextElementSibling;
                        valueInput.focus();
                        showHeaderValueSuggestions(valueInput);
                    }

                    function selectHeaderValue(value, element) {
                        const input = element.closest('.header-item').querySelector('.header-value');
                        input.value = value;
                        element.closest('.suggestions').style.display = 'none';
                        input.focus();
                    }

                    // Hide suggestions when clicking outside
                    document.addEventListener('click', function(e) {
                        if (!e.target.closest('.header-item') && !e.target.closest('.directive-item')) {
                            document.querySelectorAll('.suggestions').forEach(div => div.style.display = 'none');
                        }
                    });

                    function addNewRequest() {
                        currentRequestIndex = -1;
                        document.getElementById('requestForm').style.display = 'block';
                        document.getElementById('requestName').value = '';
                        document.getElementById('method').value = 'GET';
                        document.getElementById('url').value = '';
                        document.getElementById('body').value = '';
                        document.getElementById('comments').value = '';
                        document.getElementById('headersList').innerHTML = '';
                        document.getElementById('directivesList').innerHTML = '';
                        toggleBody();
                    }

                    function addHeader() {
                        const headersList = document.getElementById('headersList');
                        const headerItem = document.createElement('div');
                        headerItem.className = 'header-item';
                        headerItem.innerHTML = \`
                            <div class="form-row">
                                <input type="text" placeholder="Header name" class="header-name" 
                                    onfocus="showHeaderSuggestions(this)"
                                    oninput="filterHeaderSuggestions(this)">
                                <input type="text" placeholder="Header value" class="header-value" 
                                    onfocus="showHeaderValueSuggestions(this)"
                                    oninput="filterHeaderValueSuggestions(this)">
                                <button class="remove-btn" onclick="this.parentElement.parentElement.remove()">Remove</button>
                            </div>
                            <div class="suggestions"></div>
                        \`;
                        headersList.appendChild(headerItem);
                        headerItem.querySelector('.header-name').focus();
                    }

                    function addDirective() {
                        const directivesList = document.getElementById('directivesList');
                        const directiveItem = document.createElement('div');
                        directiveItem.className = 'directive-item';
                        directiveItem.innerHTML = \`
                            <div class="form-row">
                                <input type="text" placeholder="Directive name" class="directive-name" 
                                    onfocus="showDirectiveSuggestions(this)"
                                    oninput="filterDirectiveSuggestions(this)">
                                <input type="text" placeholder="Directive value" class="directive-value">
                                <button class="remove-btn" onclick="this.parentElement.parentElement.remove()">Remove</button>
                            </div>
                            <div class="suggestions"></div>
                        \`;
                        directivesList.appendChild(directiveItem);
                        directiveItem.querySelector('.directive-name').focus();
                    }

                    function saveRequest() {
                        const request = {
                            name: document.getElementById('requestName').value,
                            method: document.getElementById('method').value,
                            url: document.getElementById('url').value,
                            headers: Array.from(document.getElementsByClassName('header-item')).map(item => ({
                                name: item.querySelector('.header-name').value,
                                value: item.querySelector('.header-value').value
                            })),
                            directives: Array.from(document.getElementsByClassName('directive-item')).map(item => ({
                                name: item.querySelector('.directive-name').value,
                                value: item.querySelector('.directive-value').value
                            })),
                            comments: document.getElementById('comments').value.split('\\n'),
                            body: document.getElementById('body').value
                        };

                        if (currentRequestIndex === -1) {
                            requests.push(request);
                        } else {
                            requests[currentRequestIndex] = request;
                        }

                        vscode.postMessage({
                            command: 'saveRequest',
                            request: request
                        });

                        document.getElementById('requestForm').style.display = 'none';
                        displayRequests();
                    }

                    function cancelEdit() {
                        document.getElementById('requestForm').style.display = 'none';
                        currentRequestIndex = -1;
                        displayRequests();
                    }

                    function toggleBody() {
                        const method = document.getElementById('method').value;
                        const bodyGroup = document.getElementById('bodyGroup');
                        bodyGroup.style.display = method === 'GET' ? 'none' : 'block';
                    }

                    // Initial display
                    displayRequests();
                </script>
            </body>
            </html>
        `;
    }
} 