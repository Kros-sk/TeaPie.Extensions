import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { 
    STATUS_PASSED,
    STATUS_FAILED,
    STATUS_TESTS_FAILED,
    ERROR_CONNECTION_REFUSED,
    ERROR_HOST_NOT_FOUND,
    ERROR_TIMEOUT,
    ERROR_EXECUTION_FAILED,
    ERROR_NO_HTTP_FOUND
} from '../constants/httpResults';
import { HttpRequestResults, CliParseResult, HttpTestResult, HttpRequestResult } from './HttpRequestTypes';
import { StructuredJsonParser } from './StructuredJsonParser';
import { XmlTestParser } from './XmlTestParser';

const execAsync = promisify(exec);

/**
 * Handles TeaPie CLI execution and result processing
 */
export class TeaPieExecutor {
    private static outputChannel: vscode.OutputChannel;

    static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
        XmlTestParser.setOutputChannel(channel);
        StructuredJsonParser.setOutputChannel(channel);
    }

    static async executeTeaPie(filePath: string): Promise<HttpRequestResults> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder is open');
        }
        
        const config = vscode.workspace.getConfiguration('teapie');
        const teapieExecutable = config.get<string>('executablePath', 'teapie');
        const currentEnv = config.get<string>('currentEnvironment');
        const timeout = config.get<number>('requestTimeout', 60000);
        
        // Use unique file names with timestamp to prevent cache issues
        const timestamp = Date.now();
        const envParam = currentEnv ? ` -e "${currentEnv}"` : '';
        const reportPath = path.join(workspaceFolder.uri.fsPath, '.teapie', 'reports', `run-${timestamp}-report.xml`);
        
        // For structured requests, use workspace .teapie directory
        const structuredRequestsFile = path.join(workspaceFolder.uri.fsPath, '.teapie', 'reports', `run-${timestamp}-requests.json`);
        
        // Build command - handle both executable path and dotnet run scenarios
        let command: string;
        if (teapieExecutable.includes('dotnet run')) {
            // For dotnet run commands, append the test command and parameters
            command = `${teapieExecutable} -- test "${filePath}" --no-logo --verbose -r "${reportPath}" --requests-log-file "${structuredRequestsFile}"${envParam}`;
        } else {
            // For executable paths, use quoted path
            command = `"${teapieExecutable}" test "${filePath}" --no-logo --verbose -r "${reportPath}" --requests-log-file "${structuredRequestsFile}"${envParam}`;
        }
        
        this.outputChannel?.appendLine(`Executing TeaPie command: ${command}`);
        this.outputChannel?.appendLine(`Report file: ${reportPath}`);
        this.outputChannel?.appendLine(`Structured requests file: ${structuredRequestsFile}`);
        
        // Ensure reports directory exists (no need to create file, TeaPie will create it)
        const reportsDir = path.dirname(reportPath);
        await fs.mkdir(reportsDir, { recursive: true });
        
        // Get timestamp of existing report file (0 if doesn't exist)
        const beforeTimestamp = await fs.stat(reportPath)
            .then(stats => stats.mtime.getTime())
            .catch(() => 0);
        
        try {
            // Determine the working directory for dotnet run commands
            let workingDir = workspaceFolder.uri.fsPath;
            
            if (teapieExecutable.includes('dotnet run')) {
                // Extract the TeaPie project directory from the executable path
                const projectMatch = teapieExecutable.match(/--project\s+([^"']+|"[^"]+"|'[^']+')/);
                if (projectMatch) {
                    const projectPath = projectMatch[1].replace(/['"]/g, '');
                    workingDir = path.dirname(projectPath);
                }
            }
            
            this.outputChannel?.appendLine(`[TeaPieExecutor] Working directory: ${workingDir}`);
            
            // Test if the TeaPie executable is accessible and get versions
            if (teapieExecutable.includes('dotnet run')) {
                this.outputChannel?.appendLine(`[TeaPieExecutor] Testing dotnet accessibility...`);
                try {
                    const testResult = await execAsync('dotnet --version', { cwd: workingDir });
                    this.outputChannel?.appendLine(`[TeaPieExecutor] Dotnet version: ${testResult.stdout.trim()}`);
                } catch (testError) {
                    this.outputChannel?.appendLine(`[TeaPieExecutor] Dotnet test failed: ${testError}`);
                }
                
                // Get TeaPie version
                try {
                    const teapieVersionCmd = `${teapieExecutable} -- --version`;
                    const versionResult = await execAsync(teapieVersionCmd, { cwd: workingDir });
                    this.outputChannel?.appendLine(`[TeaPieExecutor] TeaPie version: ${versionResult.stdout.trim()}`);
                } catch (versionError) {
                    this.outputChannel?.appendLine(`[TeaPieExecutor] Could not get TeaPie version`);
                }
            }
            
            this.outputChannel?.appendLine(`[TeaPieExecutor] About to execute TeaPie command...`);
            
            try {
                await execAsync(command, {
                    cwd: workingDir,
                    timeout: timeout
                });
                this.outputChannel?.appendLine(`[TeaPieExecutor] TeaPie command completed successfully (exit code 0)`);
            } catch (error: unknown) {
                const execError = error as { stdout?: string; stderr?: string; message?: string; code?: number };
                const exitCode = execError.code || 0;
                
                // Exit code 2 means tests failed, but TeaPie executed successfully
                // Exit code 0 means all tests passed
                // Other codes are actual execution failures
                if (exitCode === 2 && execError.stdout) {
                    this.outputChannel?.appendLine(`[TeaPieExecutor] TeaPie completed with exit code 2 (tests failed)`);
                } else {
                    // Real execution failure
                    this.outputChannel?.appendLine(`[TeaPieExecutor] TeaPie execution failed: ${execError.message}`);
                    this.outputChannel?.appendLine(`[TeaPieExecutor] Exit code: ${exitCode}`);
                    this.outputChannel?.appendLine(`[TeaPieExecutor] stdout: ${execError.stdout || 'none'}`);
                    this.outputChannel?.appendLine(`[TeaPieExecutor] stderr: ${execError.stderr || 'none'}`);
                    
                    // Extract meaningful error from TeaPie output
                    let meaningfulError = this.extractTeaPieError(execError.stdout || '', execError.stderr || '');
                    if (!meaningfulError) {
                        meaningfulError = execError.message || String(error);
                    }
                    
                    throw new Error(this.mapConnectionError(meaningfulError));
                }
            }
            
            await XmlTestParser.waitForXmlReportUpdate(reportPath, beforeTimestamp);
            
            const result = await this.parseOutput(filePath, workspaceFolder.uri.fsPath, structuredRequestsFile, reportPath);
            if (!result.RequestGroups?.RequestGroup?.[0]?.Requests?.length) {
                return this.createFailedResult(filePath, ERROR_NO_HTTP_FOUND);
            }
            return result;
        } catch (error: unknown) {
            this.outputChannel?.appendLine(`[TeaPieExecutor] Fatal error during TeaPie execution`);
            throw error;
        }
    }

    /**
     * Parses TeaPie structured JSON requests and returns HTTP request results
     */
    private static async parseOutput(filePath: string, workspacePath: string, structuredRequestsFile: string, reportPath: string): Promise<HttpRequestResults> {
        const fileName = path.basename(filePath, path.extname(filePath));
        
        // Parse test results from XML file
        const testResultsFromXml = await XmlTestParser.parseTestResultsFromXml(workspacePath, filePath, reportPath);
        
        // Parse structured JSON requests
        let structuredParseResult: CliParseResult;
        try {
            this.outputChannel?.appendLine(`[TeaPieExecutor] Attempting to parse structured JSON requests from: ${structuredRequestsFile}`);
            structuredParseResult = await StructuredJsonParser.parseStructuredJsonRequests(structuredRequestsFile, filePath);
            
            if (structuredParseResult.requests.length === 0 && !structuredParseResult.foundHttpRequest) {
                this.outputChannel?.appendLine(`[TeaPieExecutor] No structured JSON requests found`);
                return this.createFailedResult(filePath, 'No HTTP requests found in structured JSON files');
            }
            
            this.outputChannel?.appendLine(`[TeaPieExecutor] Successfully parsed structured JSON requests`);
        } catch (structuredError) {
            this.outputChannel?.appendLine(`[TeaPieExecutor] Failed to parse structured JSON requests: ${structuredError}`);
            return this.createFailedResult(filePath, `Failed to parse structured JSON requests: ${structuredError}`);
        }

        // Build final results combining structured JSON data with test results
        return this.buildHttpRequestResults(
            fileName,
            filePath,
            structuredParseResult,
            testResultsFromXml
        );
    }

    private static buildHttpRequestResults(
        fileName: string,
        filePath: string,
        structuredResult: CliParseResult,
        testResultsFromXml: Map<string, HttpTestResult[]>
    ): HttpRequestResults {
        // If a connection error is present, always show it as the main result
        if (structuredResult.connectionError) {
            return this.createFailedResult(filePath, structuredResult.connectionError);
        }
        
        // Build the result structure
        const requests: HttpRequestResult[] = structuredResult.requests.map((request, index) => {
            // Get test results for this specific request
            const requestName = request.name || `Request ${index + 1}`;
            const requestTestResults = testResultsFromXml.get(requestName) || [];
            
            // Determine status based on HTTP response and inline tests
            const httpSuccess = request.responseStatus && request.responseStatus >= 200 && request.responseStatus < 300;
            const inlineTests = requestTestResults.filter(t => t.Source === 'inline' || !t.Source);
            const hasFailedInlineTests = inlineTests.length > 0 && inlineTests.some(t => !t.Passed);
            
            let status: string;
            if (!httpSuccess) {
                status = STATUS_FAILED; // HTTP request failed
            } else if (hasFailedInlineTests) {
                status = STATUS_TESTS_FAILED; // HTTP succeeded but tests failed
            } else {
                status = STATUS_PASSED; // Everything succeeded
            }
            
            return {
                Name: requestName,
                Status: status,
                Duration: request.duration || '0ms',
                Request: {
                    Method: request.method,
                    Url: request.url,
                    TemplateUrl: request.templateUrl || undefined,
                    Headers: request.requestHeaders,
                    Body: request.requestBody
                },
                Response: {
                    StatusCode: request.responseStatus || 0,
                    StatusText: request.responseStatusText || 'No Response',
                    Headers: request.responseHeaders,
                    Body: request.responseBody,
                    Duration: request.duration || '0ms'
                },
                Tests: requestTestResults.length > 0 ? requestTestResults : undefined,
                RetryInfo: request.retryInfo,
                ErrorMessage: request.ErrorMessage
            };
        });

        // Add any unassigned custom CSX tests as a separate "request" entry (only if there are truly unassigned tests)
        const customCsxTests = testResultsFromXml.get('_CUSTOM_CSX_TESTS');
        if (customCsxTests && customCsxTests.length > 0) {
            const allCustomTestsPassed = customCsxTests.every(test => test.Passed);
            
            requests.push({
                Name: 'Custom CSX Tests',
                Status: allCustomTestsPassed ? 'PASSED' : 'FAILED',
                Duration: '0ms',
                Tests: customCsxTests
            });
        }

        return {
            RequestGroups: {
                RequestGroup: [{
                    Name: fileName,
                    FilePath: filePath,
                    Status: requests.some(r => r.Status === 'FAILED') ? 'FAILED' : 'PASSED',
                    Duration: requests.reduce((total, r) => {
                        const ms = parseInt(r.Duration.replace('ms', '')) || 0;
                        return total + ms;
                    }, 0) + 'ms',
                    Requests: requests
                }]
            }
        };
    }

    private static mapConnectionError(errorMessage: string): string {
        // If the error message already has structured format (Reason:/Details:), use it as-is
        if (errorMessage.includes('Reason:') && errorMessage.includes('Details:')) {
            return errorMessage;
        }
        
        // Otherwise, map to user-friendly messages with details
        if (errorMessage?.includes('ECONNREFUSED') || errorMessage?.includes('connection refused') || errorMessage?.includes('actively refused')) {
            return `${ERROR_CONNECTION_REFUSED}\n\nDetailed error: ${errorMessage}`;
        } else if (errorMessage?.includes('ENOTFOUND') || errorMessage?.includes('getaddrinfo')) {
            return `${ERROR_HOST_NOT_FOUND}\n\nDetailed error: ${errorMessage}`;
        } else if (errorMessage?.includes('timeout')) {
            return `${ERROR_TIMEOUT}\n\nDetailed error: ${errorMessage}`;
        }
        return `${ERROR_EXECUTION_FAILED}\n\nDetailed error: ${errorMessage}`;
    }

    /**
     * Extracts meaningful error information from TeaPie stdout/stderr
     */
    private static extractTeaPieError(stdout: string, stderr: string): string {
        const output = stdout + '\n' + stderr;
        
        // Look for TeaPie's structured error output
        const reasonMatch = output.match(/Reason:\s*(.+)/);
        const detailsMatch = output.match(/Details:\s*(.+)/);
        
        if (reasonMatch && detailsMatch) {
            return `Reason: ${reasonMatch[1].trim()}\nDetails: ${detailsMatch[1].trim()}`;
        }
        
        // Look for specific error patterns in the output
        const connectionRefusedMatch = output.match(/No connection could be made because the target machine actively refused it\. \(([^)]+)\)/);
        if (connectionRefusedMatch) {
            return `Reason: Application Error\nDetails: No connection could be made because the target machine actively refused it. (${connectionRefusedMatch[1]})`;
        }
        
        // Look for other common error patterns
        const hostNotFoundMatch = output.match(/No such host is known\. \(([^)]+)\)/);
        if (hostNotFoundMatch) {
            return `Reason: Application Error\nDetails: No such host is known. (${hostNotFoundMatch[1]})`;
        }
        
        // Look for general exception messages
        const exceptionMatch = output.match(/Exception was thrown during execution[^:]*:\s*([^.]+\.)/);
        if (exceptionMatch) {
            return `Reason: Application Error\nDetails: ${exceptionMatch[1].trim()}`;
        }
        
        // If no structured error found, return empty string to fall back to raw message
        return '';
    }

    private static createFailedResult(filePath: string, errorMessage: string): HttpRequestResults {
        const fileName = path.basename(filePath, path.extname(filePath));
        return {
            RequestGroups: {
                RequestGroup: [{
                    Name: fileName,
                    FilePath: filePath,
                    Requests: [{
                        Name: 'HTTP request execution failed',
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
}
