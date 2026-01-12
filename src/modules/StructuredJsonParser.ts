import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { InternalRequest, CliParseResult } from './HttpRequestTypes';

interface LogEntry {
    Properties: {
        RequestLogFileEntry: StructuredLogEntry;
    };
}

interface StructuredLogEntry {
    RequestId: string;
    StartTime: string;
    EndTime: string;
    DurationMs: number;
    Request: {
        Name: string;
        Method: string;
        Uri: string;
        Headers: Record<string, string>;
        FilePath: string;
        Body?: string;
        ContentType?: string;
    };
    Response: {
        StatusCode: number;
        ReasonPhrase: string;
        Headers: Record<string, string>;
        Body: string;
        ContentType: string;
        ReceivedAt: string;
    };
    Authentication?: {
        ProviderType: string;
        IsDefault: boolean;
        AuthenticatedAt: string;
    };
    Errors: string[];
    Metadata?: {
        testCaseId?: string;
        hasResiliencePipeline?: boolean;
    };
}

export class StructuredJsonParser {
    private static outputChannel: vscode.OutputChannel;

    static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
    }

    /**
     * Parses TeaPie JSONL (JSON Lines) request file to extract HTTP request/response data
     * Each line contains a log entry with request data nested in Properties.StructuredRequestLog
     */
    static async parseStructuredJsonRequests(requestsFilePath: string, httpFilePath?: string): Promise<CliParseResult> {
        try {
            this.outputChannel?.appendLine(`[StructuredJsonParser] Parsing JSONL requests from: ${requestsFilePath}`);
            
            // Check if requests file exists
            try {
                await fs.access(requestsFilePath);
            } catch {
                this.outputChannel?.appendLine(`[StructuredJsonParser] Requests file not found: ${requestsFilePath}`);
                return {
                    requests: [],
                    connectionError: 'Structured requests file not found - TeaPie might not support --requests-log-file parameter',
                    foundHttpRequest: false
                };
            }

            // Parse the JSONL file (each line is a separate JSON object)
            const fileContent = await fs.readFile(requestsFilePath, 'utf8');
            const lines = fileContent.trim().split('\n').filter(line => line.trim());
            
            if (lines.length === 0) {
                this.outputChannel?.appendLine(`[StructuredJsonParser] Empty JSONL file`);
                return {
                    requests: [],
                    connectionError: 'Empty JSONL file',
                    foundHttpRequest: false
                };
            }

            this.outputChannel?.appendLine(`[StructuredJsonParser] Found ${lines.length} log entries in JSONL file`);
            
            // Group requests by name to consolidate retries
            const requestMap = new Map<string, {
                firstEntry: StructuredLogEntry;
                allEntries: StructuredLogEntry[];
            }>();
            let connectionError: string | null = null;
            let foundHttpRequest = false;

            // First pass: parse and group by request name
            for (const line of lines) {
                try {
                    const logEntry: LogEntry = JSON.parse(line);
                    
                    // Check if this is a structured request log entry
                    if (!logEntry.Properties?.RequestLogFileEntry) {
                        continue;
                    }
                    
                    const structuredLog = logEntry.Properties.RequestLogFileEntry;
                    
                    // Validate required fields
                    if (!structuredLog.Request || !structuredLog.Response) {
                        this.outputChannel?.appendLine(`[StructuredJsonParser] Skipping entry with missing Request or Response`);
                        continue;
                    }
                    
                    foundHttpRequest = true;
                    
                    // Use request name as the grouping key
                    const requestKey = structuredLog.Request.Name;
                    
                    if (!requestMap.has(requestKey)) {
                        requestMap.set(requestKey, {
                            firstEntry: structuredLog,
                            allEntries: [structuredLog]
                        });
                    } else {
                        requestMap.get(requestKey)!.allEntries.push(structuredLog);
                    }
                    
                } catch (parseError) {
                    this.outputChannel?.appendLine(`[StructuredJsonParser] Failed to parse JSONL line: ${parseError}`);
                    continue;
                }
            }

            // Second pass: convert grouped requests to InternalRequest format
            const requests: InternalRequest[] = [];
            
            for (const [, { firstEntry, allEntries }] of requestMap) {
                // Build retry attempts from all entries (if more than one)
                const entriesCount = allEntries.length;
                const retryAttempts = allEntries.map((entry, index) => ({
                    attemptNumber: index + 1,
                    timestamp: entry.StartTime,
                    success: entry.Response?.StatusCode ? (entry.Response.StatusCode >= 200 && entry.Response.StatusCode < 300) : false,
                    statusCode: entry.Response?.StatusCode,
                    statusText: entry.Response?.ReasonPhrase,
                    duration: `${Math.round(entry.DurationMs)}ms`,
                    reason: index === 0 ? 'Initial attempt' : 'Retry'
                }));
                
                // Use the last entry for the final response (most recent attempt)
                const lastEntry = allEntries[allEntries.length - 1];
                
                // Convert to InternalRequest format
                const requestName = firstEntry.Request.Name;
                const request: InternalRequest = {
                    method: firstEntry.Request.Method,
                    url: firstEntry.Request.Uri,
                    requestHeaders: firstEntry.Request.Headers || {},
                    requestBody: firstEntry.Request.Body,
                    responseStatus: lastEntry.Response?.StatusCode || 0,
                    responseStatusText: lastEntry.Response?.ReasonPhrase || 'No Response',
                    responseHeaders: lastEntry.Response?.Headers || {},
                    responseBody: lastEntry.Response?.Body,
                    duration: `${Math.round(lastEntry.DurationMs)}ms`,
                    uniqueKey: firstEntry.RequestId,
                    title: requestName,
                    name: requestName,
                    templateUrl: firstEntry.Request.Uri,
                    // Retry info from grouped entries
                    retryInfo: {
                        strategyName: firstEntry.Metadata?.hasResiliencePipeline ? 'Resilience Pipeline' : undefined,
                        actualAttempts: entriesCount,
                        wasRetried: entriesCount > 1,
                        attempts: retryAttempts
                    }
                };

                // Check for errors in any of the entries
                const errors = allEntries.flatMap(entry => entry.Errors).filter(err => err);
                if (errors.length > 0) {
                    request.ErrorMessage = errors.join('; ');
                    if (!connectionError) {
                        connectionError = errors[0];
                    }
                }

                requests.push(request);
                
                this.outputChannel?.appendLine(`[StructuredJsonParser] Parsed request: ${request.name} (${request.method} ${request.url}) with ${entriesCount} attempts, startTime: ${firstEntry.StartTime}`);
            }

            this.outputChannel?.appendLine(`[StructuredJsonParser] Completed parsing. Found ${requests.length} requests from JSONL file, foundHttpRequest: ${foundHttpRequest}`);
            
            if (httpFilePath && requests.length > 0) {
                this.outputChannel?.appendLine(`[StructuredJsonParser] Successfully parsed JSONL results for ${path.basename(httpFilePath)}`);
            }

            return {
                requests,
                connectionError,
                foundHttpRequest
            };
        } catch (error) {
            this.outputChannel?.appendLine(`[StructuredJsonParser] Error parsing JSONL requests: ${error}`);
            throw error;
        }
    }
}
