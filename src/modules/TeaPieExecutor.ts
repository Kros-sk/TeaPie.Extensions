import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { 
    STATUS_FAILED,
    ERROR_CONNECTION_REFUSED,
    ERROR_HOST_NOT_FOUND,
    ERROR_TIMEOUT,
    ERROR_EXECUTION_FAILED,
    ERROR_NO_HTTP_FOUND
} from '../constants/httpResults';
import { HttpRequestResults, CliParseResult, HttpTestResult } from './HttpRequestTypes';
import { LogFileParser } from './LogFileParser';
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
        LogFileParser.setOutputChannel(channel);
    }

    static async executeTeaPie(filePath: string): Promise<HttpRequestResults> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder is open');
        }
        
        const config = vscode.workspace.getConfiguration('teapie');
        const currentEnv = config.get<string>('currentEnvironment');
        const timeout = config.get<number>('requestTimeout', 60000);
        
        // Use unique file names with timestamp to prevent cache issues
        const timestamp = Date.now();
        const envParam = currentEnv ? ` -e "${currentEnv}"` : '';
        const reportPath = path.join(workspaceFolder.uri.fsPath, '.teapie', 'reports', `run-${timestamp}-report.xml`);
        const logPath = path.join(workspaceFolder.uri.fsPath, '.teapie', 'logs', `run-${timestamp}.log`);
        
        // Updated command to include log file parameters with unique names
        const command = `teapie test "${filePath}" --no-logo --verbose -r "${reportPath}" --log-file "${logPath}" --log-file-log-level Trace${envParam}`;
        
        this.outputChannel?.appendLine(`Executing TeaPie command: ${command}`);
        this.outputChannel?.appendLine(`Report file: ${reportPath}`);
        this.outputChannel?.appendLine(`Log file: ${logPath}`);
        
        // Ensure reports and logs directories exist
        const reportsDir = path.dirname(reportPath);
        const logsDir = path.dirname(logPath);
        await fs.mkdir(reportsDir, { recursive: true });
        await fs.mkdir(logsDir, { recursive: true });
        
        // Get timestamp of existing report file (0 if doesn't exist)
        const beforeTimestamp = await fs.stat(reportPath)
            .then(stats => stats.mtime.getTime())
            .catch(() => 0);
        
        try {
            const { stdout } = await execAsync(command, {
                cwd: workspaceFolder.uri.fsPath,
                timeout: timeout
            });
            
            await XmlTestParser.waitForXmlReportUpdate(reportPath, beforeTimestamp);
            
            const result = await this.parseOutput(stdout, filePath, workspaceFolder.uri.fsPath, logPath);
            if (!result.RequestGroups?.RequestGroup?.[0]?.Requests?.length) {
                return this.createFailedResult(filePath, ERROR_NO_HTTP_FOUND);
            }
            return result;
        } catch (error: unknown) {
            const execError = error as { stdout?: string; stderr?: string; message?: string; code?: number };
            
            this.outputChannel?.appendLine(`[TeaPieExecutor] TeaPie execution failed: ${execError.message}`);
            this.outputChannel?.appendLine(`[TeaPieExecutor] Exit code: ${execError.code}`);
            
            // Try to extract meaningful error from TeaPie stdout/stderr first
            let meaningfulError = '';
            if (execError.stdout || execError.stderr) {
                meaningfulError = this.extractTeaPieError(execError.stdout || '', execError.stderr || '');
            }
            
            // If we couldn't extract a meaningful error, fall back to the raw message
            if (!meaningfulError) {
                meaningfulError = execError.message || String(error);
            }
            
            // Even when TeaPie fails with non-zero exit code, it might still generate useful results
            // This happens especially with test failures (e.g., TEST-SUCCESSFUL-STATUS: False when request succeeds)
            // First, try to parse the output and XML reports
            if (execError.stdout) {
                try {
                    await XmlTestParser.waitForXmlReportUpdate(reportPath, beforeTimestamp);
                    
                    const result = await this.parseOutput(execError.stdout, filePath, workspaceFolder.uri.fsPath, logPath);
                    if (result.RequestGroups?.RequestGroup?.[0]?.Requests?.length) {
                        this.outputChannel?.appendLine(`[TeaPieExecutor] Successfully parsed results despite TeaPie exit code ${execError.code}`);
                        return result;
                    }
                } catch (parseError) {
                    this.outputChannel?.appendLine(`[TeaPieExecutor] Failed to parse results from failed execution: ${parseError}`);
                }
            }
            
            // If we can't parse useful results, then treat it as a true execution failure
            this.outputChannel?.appendLine(`[TeaPieExecutor] No valid results found, treating as execution failure`);
            return this.createFailedResult(filePath, this.mapConnectionError(meaningfulError));
        }
    }

    /**
     * Parses TeaPie log file and returns structured HTTP request results
     */
    private static async parseOutput(stdout: string, filePath: string, workspacePath: string, logPath: string): Promise<HttpRequestResults> {
        const fileName = path.basename(filePath, path.extname(filePath));
        
        // Parse test results from XML file
        const testResultsFromXml = await XmlTestParser.parseTestResultsFromXml(workspacePath, filePath);
        
        // Parse the log file to extract request/response data
        let logParseResult: CliParseResult;
        try {
            logParseResult = await LogFileParser.parseLogFile(logPath, filePath);
            this.outputChannel?.appendLine(`[TeaPieExecutor] Successfully parsed log file: ${logPath}`);
        } catch (logError) {
            this.outputChannel?.appendLine(`[TeaPieExecutor] Failed to parse log file: ${logError}`);
            // Return error result if log file parsing fails
            return this.createFailedResult(filePath, `Failed to parse TeaPie log file: ${logError}`);
        }
        
        // Build final results combining log data with test results
        return this.buildHttpRequestResults(
            fileName,
            filePath,
            logParseResult,
            testResultsFromXml
        );
    }

    private static buildHttpRequestResults(
        fileName: string,
        filePath: string,
        logResult: CliParseResult,
        testResultsFromXml: Map<string, HttpTestResult[]>
    ): HttpRequestResults {
        return LogFileParser.buildHttpRequestResults(
            fileName,
            filePath,
            logResult,
            testResultsFromXml
        );
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
        return {
            RequestGroups: {
                RequestGroup: [{
                    Name: path.basename(filePath, path.extname(filePath)),
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
