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
        '@host': 'Define the host URL for the request',
        '@name': 'Set a name for the test case',
        '@description': 'Add a description for the test case',
        '@auth': 'Specify authentication settings',
        '@headers': 'Define common headers for requests',
        '@variables': 'Define variables for the test case',
        'TEST-EXPECT-STATUS': 'Expected HTTP status code(s) for the response',
        'TEST-HAS-BODY': 'Verifies that the response has a body',
        'TEST-HAS-HEADER': 'Verifies that the response contains the specified header',
        'TEST-SUCCESSFUL-STATUS': 'Verifies that the response has a successful status code (2xx)',
        'RETRY-STRATEGY': 'Defines the retry strategy for failed requests',
        'RETRY-MAX-ATTEMPTS': 'Maximum number of retry attempts',
        'RETRY-BACKOFF-TYPE': 'Type of delay between retries (Linear, Exponential)',
        'RETRY-MAX-DELAY': 'Maximum delay between retries',
        'RETRY-UNTIL-STATUS': 'Retry until response matches specified status code(s)',
        'AUTH-PROVIDER': 'Specifies the authentication provider to use for this request'
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