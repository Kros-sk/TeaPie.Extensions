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

        try {
            // Run TeaPie and get results
            const results = await HttpRequestRunner.executeTeaPie(uri.fsPath);
            
            // If we already have a panel, show it
            if (HttpRequestRunner.currentPanel) {
                HttpRequestRunner.currentPanel.reveal(column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
                HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getWebviewContent(results, uri);
                return;
            }

            // Otherwise, create a new panel
            HttpRequestRunner.currentPanel = vscode.window.createWebviewPanel(
                'httpRequestResults',
                'HTTP Request Results',
                column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            HttpRequestRunner.currentPanel.webview.html = HttpRequestRunner.getWebviewContent(results, uri);

            // Reset when the panel is disposed
            HttpRequestRunner.currentPanel.onDidDispose(
                () => {
                    HttpRequestRunner.currentPanel = undefined;
                    HttpRequestRunner.currentFile = undefined;
                },
                null,
                []
            );

        } catch (error) {
            const errorMessage = `Failed to run HTTP requests: ${error}`;
            HttpRequestRunner.outputChannel.appendLine(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
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

        // Use simpler command without XML report - just capture stdout
        const command = `teapie test "${filePath}" --no-logo${envParam}`;
        
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

            // Parse stdout directly since it contains all the information we need
            return HttpRequestRunner.parseStdoutOutput(stdout, filePath);

        } catch (error) {
            HttpRequestRunner.outputChannel.appendLine(`TeaPie execution error: ${error}`);
            throw error;
        }
    }

    private static getWebviewContent(results: TeaPieResult, fileUri: vscode.Uri): string {
        const fileName = path.basename(fileUri.fsPath);
        
        let testSuitesHtml = '';
        
        if (results.TestSuites && results.TestSuites.TestSuite) {
            results.TestSuites.TestSuite.forEach(suite => {
                const statusClass = suite.Status === 'Passed' ? 'success' : 'error';
                
                let testsHtml = '';
                if (suite.Tests) {
                    suite.Tests.forEach(test => {
                        const testStatusClass = test.Status === 'Passed' ? 'success' : 'error';
                        
                        let requestHtml = '';
                        if (test.Request) {
                            const headersHtml = Object.entries(test.Request.Headers || {})
                                .map(([key, value]) => `<div class="header-item"><strong>${key}:</strong> ${value}</div>`)
                                .join('');
                            
                            requestHtml = `
                                <div class="request-section">
                                    <h4>Request</h4>
                                    <div class="method-url">
                                        <span class="method method-${test.Request.Method.toLowerCase()}">${test.Request.Method}</span>
                                        <span class="url">${test.Request.Url}</span>
                                    </div>
                                    ${headersHtml ? `<div class="headers"><h5>Headers:</h5>${headersHtml}</div>` : ''}
                                    ${test.Request.Body ? `<div class="body"><h5>Body:</h5><pre>${test.Request.Body}</pre></div>` : ''}
                                </div>
                            `;
                        }
                        
                        let responseHtml = '';
                        if (test.Response) {
                            const statusClass = test.Response.StatusCode >= 200 && test.Response.StatusCode < 300 ? 'success' : 
                                               test.Response.StatusCode >= 400 ? 'error' : 'warning';
                            
                            const responseHeadersHtml = Object.entries(test.Response.Headers || {})
                                .map(([key, value]) => `<div class="header-item"><strong>${key}:</strong> ${value}</div>`)
                                .join('');
                            
                            responseHtml = `
                                <div class="response-section">
                                    <h4>Response</h4>
                                    <div class="status-line">
                                        <span class="status-code status-${statusClass}">${test.Response.StatusCode}</span>
                                        <span class="status-text">${test.Response.StatusText}</span>
                                        <span class="duration">${test.Response.Duration}</span>
                                    </div>
                                    ${responseHeadersHtml ? `<div class="headers"><h5>Headers:</h5>${responseHeadersHtml}</div>` : ''}
                                    ${test.Response.Body ? `<div class="body"><h5>Body:</h5><pre>${test.Response.Body}</pre></div>` : ''}
                                </div>
                            `;
                        }
                        
                        let errorHtml = '';
                        if (test.ErrorMessage) {
                            errorHtml = `<div class="error-section"><h4>Error</h4><pre class="error-message">${test.ErrorMessage}</pre></div>`;
                        }
                        
                        testsHtml += `
                            <div class="test-item">
                                <div class="test-header">
                                    <h3 class="test-name ${testStatusClass}">${test.Name}</h3>
                                    <span class="test-status ${testStatusClass}">${test.Status}</span>
                                    <span class="test-duration">${test.Duration}</span>
                                </div>
                                ${requestHtml}
                                ${responseHtml}
                                ${errorHtml}
                            </div>
                        `;
                    });
                }
                
                testSuitesHtml += `
                    <div class="test-suite">
                        <div class="suite-header">
                            <h2 class="suite-name ${statusClass}">${suite.Name}</h2>
                            <span class="suite-status ${statusClass}">${suite.Status}</span>
                            <span class="suite-duration">${suite.Duration}</span>
                        </div>
                        <div class="tests-container">
                            ${testsHtml}
                        </div>
                    </div>
                `;
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
        }
        
        .test-suite {
            margin-bottom: 30px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            overflow: hidden;
        }
        
        .suite-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .suite-name {
            margin: 0;
            font-size: 18px;
        }
        
        .suite-status, .test-status {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            text-transform: uppercase;
        }
        
        .suite-duration, .test-duration {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        
        .success {
            color: var(--vscode-terminal-ansiGreen);
        }
        
        .error {
            color: var(--vscode-terminal-ansiRed);
        }
        
        .warning {
            color: var(--vscode-terminal-ansiYellow);
        }
        
        .tests-container {
            padding: 0;
        }
        
        .test-item {
            border-bottom: 1px solid var(--vscode-panel-border);
            padding: 20px;
        }
        
        .test-item:last-child {
            border-bottom: none;
        }
        
        .test-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        
        .test-name {
            margin: 0;
            font-size: 16px;
        }
        
        .request-section, .response-section, .error-section {
            margin: 15px 0;
            padding: 15px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background-color: var(--vscode-editor-background);
        }
        
        .request-section h4, .response-section h4, .error-section h4 {
            margin: 0 0 10px 0;
            color: var(--vscode-foreground);
        }
        
        .method-url {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
        }
        
        .method {
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
        }
        
        .method-get { background-color: #4CAF50; color: white; }
        .method-post { background-color: #FF9800; color: white; }
        .method-put { background-color: #2196F3; color: white; }
        .method-delete { background-color: #F44336; color: white; }
        .method-patch { background-color: #9C27B0; color: white; }
        
        .url {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            word-break: break-all;
        }
        
        .status-line {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
        }
        
        .status-code {
            padding: 2px 6px;
            border-radius: 3px;
            font-weight: bold;
            font-size: 12px;
        }
        
        .status-success { background-color: #4CAF50; color: white; }
        .status-warning { background-color: #FF9800; color: white; }
        .status-error { background-color: #F44336; color: white; }
        
        .headers {
            margin: 10px 0;
        }
        
        .headers h5 {
            margin: 0 0 5px 0;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        
        .header-item {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 12px;
            margin-bottom: 2px;
            word-break: break-all;
        }
        
        .body {
            margin: 10px 0;
        }
        
        .body h5 {
            margin: 0 0 5px 0;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 12px;
            margin: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        
        .error-message {
            color: var(--vscode-terminal-ansiRed);
        }
        
        .no-results {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>HTTP Request Results: ${fileName}</h1>
    </div>
    
    ${testSuitesHtml || '<div class="no-results">No test results available</div>'}
</body>
</html>`;
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
            
            const testSuite: TeaPieTestSuite = {
                Name: fileName,
                FilePath: filePath,
                Tests: [],
                Status: 'Unknown',
                Duration: '0s'
            };

            let currentTest: TeaPieTest | null = null;
            let isSuccess = false;

            for (const line of lines) {
                const trimmedLine = line.trim();
                
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
                
                // Look for test completion
                const testPassMatch = trimmedLine.match(/Test Passed: '(.+?)' in (\d+) ms/);
                if (testPassMatch && currentTest) {
                    currentTest.Status = 'Passed';
                    currentTest.Duration = testPassMatch[2] + 'ms';
                    
                    // For successful tests, we can create a mock successful response
                    if (currentTest.Request) {
                        currentTest.Response = {
                            StatusCode: 200,
                            StatusText: 'OK',
                            Headers: {},
                            Duration: currentTest.Duration
                        };
                    }
                    
                    testSuite.Tests.push(currentTest);
                    currentTest = null;
                    isSuccess = true;
                }
                
                const testFailMatch = trimmedLine.match(/Test Failed: '(.+?)' in (\d+) ms/);
                if (testFailMatch && currentTest) {
                    currentTest.Status = 'Failed';
                    currentTest.Duration = testFailMatch[2] + 'ms';
                    testSuite.Tests.push(currentTest);
                    currentTest = null;
                }
                
                // Look for overall success
                if (trimmedLine.includes('Success! All') && trimmedLine.includes('tests passed')) {
                    isSuccess = true;
                }
                
                // Look for overall failure
                if (trimmedLine.includes('Failed:') || trimmedLine.includes('tests failed')) {
                    isSuccess = false;
                }
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
}
