import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { 
    ERROR_CONNECTION_REFUSED,
    ERROR_HOST_NOT_FOUND,
    ERROR_TIMEOUT,
    ERROR_EXECUTION_FAILED,
    ERROR_NO_HTTP_FOUND
} from '../constants/cliPatterns';
import { STATUS_FAILED } from '../constants/httpResults';
import { HttpRequestResults, CliParseResult, HttpTestResult } from './HttpRequestTypes';
import { CliOutputParser } from './CliOutputParser';
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
    }

    static async executeTeaPie(filePath: string): Promise<HttpRequestResults> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder is open');
        }
        
        const config = vscode.workspace.getConfiguration('teapie');
        const currentEnv = config.get<string>('currentEnvironment');
        const timeout = config.get<number>('requestTimeout', 60000);
        
        const envParam = currentEnv ? ` -e "${currentEnv}"` : '';
        const reportPath = path.join(workspaceFolder.uri.fsPath, '.teapie', 'reports', 'last-run-report.xml');
        const command = `teapie test "${filePath}" --no-logo --verbose -r "${reportPath}"${envParam}`;
        
        this.outputChannel?.appendLine(`Executing TeaPie command: ${command}`);
        
        // Ensure reports directory exists
        const reportsDir = path.dirname(reportPath);
        await fs.mkdir(reportsDir, { recursive: true });
        
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
            
            const result = await this.parseOutput(stdout, filePath, workspaceFolder.uri.fsPath);
            if (!result.RequestGroups?.RequestGroup?.[0]?.Requests?.length) {
                return this.createFailedResult(filePath, ERROR_NO_HTTP_FOUND);
            }
            return result;
        } catch (error: unknown) {
            const execError = error as { stdout?: string; message?: string };
            if (execError.stdout) {
                try {
                    await XmlTestParser.waitForXmlReportUpdate(reportPath, beforeTimestamp);
                    
                    const result = await this.parseOutput(execError.stdout, filePath, workspaceFolder.uri.fsPath);
                    if (!result.RequestGroups?.RequestGroup?.[0]?.Requests?.length) {
                        return this.createFailedResult(filePath, this.mapConnectionError(execError.message || String(error)));
                    }
                    return result;
                } catch (parseError) {
                    // Failed to parse even with stdout, fall through to error handling
                }
            }
            return this.createFailedResult(filePath, this.mapConnectionError(execError.message || String(error)));
        }
    }

    /**
     * Parses TeaPie CLI output and returns structured HTTP request results
     */
    private static async parseOutput(stdout: string, filePath: string, workspacePath: string): Promise<HttpRequestResults> {
        const fileName = path.basename(filePath, path.extname(filePath));
        
        // Parse test results from XML file
        const testResultsFromXml = await XmlTestParser.parseTestResultsFromXml(workspacePath, filePath);
        
        // Parse the CLI stdout to extract request/response data
        const cliParseResult = await CliOutputParser.parseCliOutput(stdout, filePath);
        
        // Build final results combining CLI data with test results
        return this.buildHttpRequestResults(
            fileName,
            filePath,
            cliParseResult,
            testResultsFromXml
        );
    }

    private static buildHttpRequestResults(
        fileName: string,
        filePath: string,
        cliResult: CliParseResult,
        testResultsFromXml: Map<string, HttpTestResult[]>
    ): HttpRequestResults {
        return CliOutputParser.buildHttpRequestResults(
            fileName,
            filePath,
            cliResult,
            testResultsFromXml
        );
    }

    private static mapConnectionError(errorMessage: string): string {
        if (errorMessage?.includes('ECONNREFUSED') || errorMessage?.includes('connection refused')) {
            return ERROR_CONNECTION_REFUSED;
        } else if (errorMessage?.includes('ENOTFOUND') || errorMessage?.includes('getaddrinfo')) {
            return ERROR_HOST_NOT_FOUND;
        } else if (errorMessage?.includes('timeout')) {
            return ERROR_TIMEOUT;
        }
        return ERROR_EXECUTION_FAILED;
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
