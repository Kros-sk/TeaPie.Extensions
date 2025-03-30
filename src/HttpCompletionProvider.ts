import * as vscode from 'vscode';

export class HttpCompletionProvider implements vscode.CompletionItemProvider {
    private directives = [
        '@host',
        '@name',
        '@description',
        '@auth',
        '@headers',
        '@variables'
    ];

    private testDirectives = [
        'TEST-EXPECT-STATUS',
        'TEST-HAS-BODY',
        'TEST-HAS-HEADER',
        'TEST-SUCCESSFUL-STATUS'
    ];

    private retryDirectives = [
        'RETRY-STRATEGY',
        'RETRY-MAX-ATTEMPTS',
        'RETRY-BACKOFF-TYPE',
        'RETRY-MAX-DELAY',
        'RETRY-UNTIL-STATUS'
    ];

    private authDirectives = [
        'AUTH-PROVIDER'
    ];

    private directiveDescriptions: { [key: string]: string } = {
        '@host': 'Define the host URL for the request\n\n```\n@host https://api.example.com\n```',
        '@name': 'Set a name for the test case\n\n```\n@name Get User Profile\n```',
        '@description': 'Add a description for the test case\n\n```\n@description Tests the user profile endpoint with valid credentials\n```',
        '@auth': 'Specify authentication settings\n\n```\n@auth {"type": "bearer", "token": "{{token}}"}\n```',
        '@headers': 'Define common headers for requests\n\n```\n@headers {"Accept": "application/json", "X-API-Key": "{{apiKey}}"}\n```',
        '@variables': 'Define variables for the test case\n\n```\n@variables {"userId": "123", "apiKey": "xyz789"}\n```',
        'TEST-EXPECT-STATUS': 'Expected HTTP status code(s) for the response\n\n```\n## TEST-EXPECT-STATUS: [200]\n## TEST-EXPECT-STATUS: [200, 201]\n```',
        'TEST-HAS-BODY': 'Verifies that the response has a body\n\n```\n## TEST-HAS-BODY: true\n```',
        'TEST-HAS-HEADER': 'Verifies that the response contains the specified header\n\n```\n## TEST-HAS-HEADER: ["Content-Type"]\n## TEST-HAS-HEADER: ["Content-Type", "ETag"]\n```',
        'TEST-SUCCESSFUL-STATUS': 'Verifies that the response has a successful status code (2xx)\n\n```\n## TEST-SUCCESSFUL-STATUS: true\n```',
        'RETRY-STRATEGY': 'Defines the retry strategy for failed requests\n\n```\n## RETRY-STRATEGY: DefaultRetry\n## RETRY-STRATEGY: CustomRetry\n```',
        'RETRY-MAX-ATTEMPTS': 'Maximum number of retry attempts\n\n```\n## RETRY-MAX-ATTEMPTS: 3\n```',
        'RETRY-BACKOFF-TYPE': 'Type of delay between retries (Linear, Exponential)\n\n```\n## RETRY-BACKOFF-TYPE: Linear\n## RETRY-BACKOFF-TYPE: Exponential\n```',
        'RETRY-MAX-DELAY': 'Maximum delay between retries\n\n```\n## RETRY-MAX-DELAY: 5000\n```',
        'RETRY-UNTIL-STATUS': 'Retry until response matches specified status code(s)\n\n```\n## RETRY-UNTIL-STATUS: 200\n## RETRY-UNTIL-STATUS: [200, 201]\n```',
        'AUTH-PROVIDER': 'Specifies the authentication provider to use for this request\n\n```\n## AUTH-PROVIDER: OAuth2\n## AUTH-PROVIDER: CustomAuth\n```'
    };

    private retryBackoffTypes = [
        'Linear',
        'Exponential'
    ];

    private httpMethods = [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'PATCH',
        'HEAD',
        'OPTIONS',
        'TRACE',
        'CONNECT'
    ];

    private commonHeaders = [
        'Accept',
        'Accept-Charset',
        'Accept-Encoding',
        'Accept-Language',
        'Authorization',
        'Cache-Control',
        'Connection',
        'Content-Length',
        'Content-Type',
        'Cookie',
        'Date',
        'Host',
        'If-Match',
        'If-Modified-Since',
        'If-None-Match',
        'If-Range',
        'If-Unmodified-Since',
        'Origin',
        'Pragma',
        'Referer',
        'User-Agent'
    ];

    private contentTypes = [
        'application/json',
        'application/xml',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
        'text/plain',
        'text/html',
        'text/xml',
        'text/css',
        'text/javascript'
    ];

    private authSchemes = [
        'Basic',
        'Bearer',
        'Digest',
        'OAuth'
    ];

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const linePrefix = document.lineAt(position).text.substr(0, position.character);
        const items: vscode.CompletionItem[] = [];

        // Suggest directives at the start of a line with #
        if (linePrefix.trim().startsWith('#')) {
            // Add test directives
            this.testDirectives.forEach(directive => {
                const item = new vscode.CompletionItem(directive, vscode.CompletionItemKind.Keyword);
                item.documentation = new vscode.MarkdownString(this.directiveDescriptions[directive] || 'TeaPie test directive');
                item.insertText = `## ${directive}: `;
                items.push(item);
            });

            // Add retry directives
            this.retryDirectives.forEach(directive => {
                const item = new vscode.CompletionItem(directive, vscode.CompletionItemKind.Keyword);
                item.documentation = new vscode.MarkdownString(this.directiveDescriptions[directive] || 'TeaPie retry directive');
                item.insertText = `## ${directive}: `;
                items.push(item);
            });

            // Add auth directives
            this.authDirectives.forEach(directive => {
                const item = new vscode.CompletionItem(directive, vscode.CompletionItemKind.Keyword);
                item.documentation = new vscode.MarkdownString(this.directiveDescriptions[directive] || 'TeaPie authentication directive');
                item.insertText = `## ${directive}: `;
                items.push(item);
            });
        }

        // Suggest directives at the start of a line with @
        if (linePrefix.trim() === '' || linePrefix.trim().startsWith('@')) {
            this.directives.forEach(directive => {
                const item = new vscode.CompletionItem(directive, vscode.CompletionItemKind.Keyword);
                item.documentation = new vscode.MarkdownString(this.directiveDescriptions[directive] || 'TeaPie directive');
                items.push(item);
            });
        }

        // Suggest HTTP methods at the start of a line
        if (linePrefix.trim() === '') {
            this.httpMethods.forEach(method => {
                const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method);
                item.documentation = new vscode.MarkdownString(`HTTP ${method} request method`);
                items.push(item);
            });
        }

        // Suggest headers when line ends with colon
        if (linePrefix.trim().endsWith(':')) {
            this.commonHeaders.forEach(header => {
                const item = new vscode.CompletionItem(header, vscode.CompletionItemKind.Field);
                item.documentation = new vscode.MarkdownString(`HTTP header: ${header}`);
                items.push(item);
            });
        }

        // Suggest content types after Content-Type:
        if (linePrefix.trim().toLowerCase().startsWith('content-type:')) {
            this.contentTypes.forEach(type => {
                const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.Value);
                item.documentation = new vscode.MarkdownString(`Content type: ${type}`);
                items.push(item);
            });
        }

        // Suggest auth schemes after Authorization:
        if (linePrefix.trim().toLowerCase().startsWith('authorization:')) {
            this.authSchemes.forEach(scheme => {
                const item = new vscode.CompletionItem(scheme, vscode.CompletionItemKind.Value);
                item.documentation = new vscode.MarkdownString(`Authentication scheme: ${scheme}`);
                items.push(item);
            });
        }

        // Suggest backoff types after RETRY-BACKOFF-TYPE:
        if (linePrefix.trim().includes('RETRY-BACKOFF-TYPE:')) {
            this.retryBackoffTypes.forEach(type => {
                const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.Value);
                item.documentation = new vscode.MarkdownString(`Retry backoff type: ${type}`);
                items.push(item);
            });
        }

        return items;
    }
} 