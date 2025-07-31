import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { 
    InternalRequest, 
    CliParseResult, 
    HttpFileRequest,
    HttpRequestResults,
    HttpRequestResult,
    HttpTestResult,
    RetryInfo
} from './HttpRequestTypes';
import { HttpFileParser } from './HttpFileParser';
import { STATUS_PASSED, STATUS_FAILED, ERROR_HTTP_FAILED } from '../constants/httpResults';

/**
 * Parses TeaPie log files to extract HTTP request/response data
 */
export class LogFileParser {
    private static outputChannel: vscode.OutputChannel;

    static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
    }

    /**
     * Parses TeaPie log file to extract HTTP request/response data
     */
    static async parseLogFile(logFilePath: string, httpFilePath: string): Promise<CliParseResult> {
        try {
            const logContent = await fs.readFile(logFilePath, 'utf8');
            const lines = logContent.split('\n');
            
            this.outputChannel?.appendLine(`[LogFileParser] Parsing log file: ${logFilePath}`);
            this.outputChannel?.appendLine(`[LogFileParser] Log file has ${lines.length} lines`);
            
            const requests: InternalRequest[] = [];
            const pendingRequests: Map<string, InternalRequest> = new Map();
            
            let connectionError: string | null = null;
            let foundHttpRequest = false;
            let currentRetryInfo: Partial<RetryInfo> = {};
            let lastRequestKey: string | null = null;
            
            const httpFileRequests = await HttpFileParser.parseHttpFileForNames(httpFilePath);
            this.outputChannel?.appendLine(`[LogFileParser] Expected ${httpFileRequests.length} requests from HTTP file`);
            
            // Parse retry directives from HTTP file
            const httpFileContent = await fs.readFile(httpFilePath, 'utf8');
            const httpRetryDirectives = this.parseHttpFileRetryDirectives(httpFileContent);
            this.outputChannel?.appendLine(`[LogFileParser] Found ${Object.keys(httpRetryDirectives).length} retry directives in HTTP file`);
            
            // Log the expected requests from HTTP file for debugging
            httpFileRequests.forEach((req, index) => {
                this.outputChannel?.appendLine(`[LogFileParser] HTTP File Request ${index}: ${req.method} ${req.url} (name: ${req.name})`);
                if (req.name && httpRetryDirectives[req.name]) {
                    this.outputChannel?.appendLine(`[LogFileParser] Retry directive for ${req.name}: ${JSON.stringify(httpRetryDirectives[req.name])}`);
                }
            });
            
            // Track processed requests to avoid duplicates
            let processedRequestCount = 0;
            const maxRequests = httpFileRequests.length;
            const processedUrls = new Set<string>();

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                // Skip empty lines
                if (!line) continue;

                // Only treat [ERR] as a connection error if it matches known connection failure patterns
                const isConnectionError = (
                    line.includes('Connection refused') ||
                    line.includes('Host not found') ||
                    line.includes('Connection timeout') ||
                    line.includes('Network error') ||
                    line.toLowerCase().includes('exception was thrown') ||
                    line.includes('Reason: Application Error')
                );
                if (isConnectionError) {
                    // Try to extract a detailed error message
                    let errorMsg = line;
                    // Look ahead for 'Details:' or next error lines
                    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                        const nextLine = lines[j].trim();
                        if (nextLine.startsWith('Details:')) {
                            errorMsg += '\n' + nextLine;
                        } else if (nextLine.startsWith('Reason:')) {
                            errorMsg += '\n' + nextLine;
                        } else if (nextLine.includes('[ERR]')) {
                            errorMsg += '\n' + nextLine;
                        }
                    }
                    connectionError = errorMsg;
                    this.outputChannel?.appendLine(`[LogFileParser] Detected connection error: ${errorMsg}`);
                    break;
                }

                // Look for HTTP request start indicators in log
                if (this.isLogRequestStartLine(line)) {
                    foundHttpRequest = true;
                    
                    // Extract method and URL to check for duplicates, but allow retries
                    const methodMatch = line.match(/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^\s]+)/);
                    if (methodMatch) {
                        const requestId = `${methodMatch[1]}_${methodMatch[2]}`;
                        
                        // Check if we already have this exact request processed 
                        const existingRequest = Array.from(pendingRequests.values()).find(req => 
                            req.method === methodMatch[1] && req.url === methodMatch[2]
                        );
                        
                        // If we already have this request in pending, it's likely a retry - skip creating a new one
                        if (existingRequest) {
                            this.outputChannel?.appendLine(`[LogFileParser] Skipped retry attempt for existing pending request: ${requestId}`);
                            continue;
                        }
                        
                        // If we've reached the max number of unique requests, don't process more
                        if (processedRequestCount >= maxRequests && maxRequests > 0) {
                            this.outputChannel?.appendLine(`[LogFileParser] Reached max requests limit (${maxRequests}), skipping: ${requestId}`);
                            continue;
                        }
                        
                        // Track this URL pattern but allow processing
                        processedUrls.add(requestId);
                    }
                    
                    const processed = this.processLogRequestStart(
                        line,
                        pendingRequests,
                        httpFileRequests,
                        processedRequestCount,
                        processedRequestCount,
                        currentRetryInfo,
                        httpRetryDirectives
                    );
                    if (processed) {
                        processedRequestCount++;
                    }
                } else if (this.isLogRequestBodyLine(line)) {
                    this.processLogRequestBody(line, lines, i, pendingRequests);
                } else if (this.isLogResponseLine(line)) {
                    this.outputChannel?.appendLine(`[LogFileParser] Found response line: ${line}`);
                    this.processLogResponse(line, pendingRequests);
                } else if (this.isLogResponseBodyLine(line)) {
                    this.outputChannel?.appendLine(`[LogFileParser] Found response body line: ${line.substring(0, 100)}`);
                    this.processLogResponseBody(line, lines, i, pendingRequests);
                } else if (this.isLogRequestEndLine(line)) {
                    this.processLogRequestEnd(line, pendingRequests, requests);
                } else if (this.isLogConnectionErrorLine(line)) {
                    connectionError = this.extractLogConnectionError(line, lines, i);
                } else if (this.isRetryStrategyLine(line)) {
                    this.processRetryStrategyInfo(line, currentRetryInfo);
                } else if (this.isRetryAttemptLine(line)) {
                    // Find the most recent pending request
                    const requestsArr = Array.from(pendingRequests.values());
                    let targetRequest = requestsArr.length > 0 ? requestsArr[requestsArr.length - 1] : undefined;
                    if (targetRequest) {
                        if (!targetRequest.retryInfo) {
                            targetRequest.retryInfo = { attempts: [], actualAttempts: 1 };
                        }
                        this.processRetryAttempt(line, lines, i, targetRequest.retryInfo);
                        targetRequest.retryInfo.actualAttempts = (targetRequest.retryInfo.actualAttempts || 1) + 1;
                        targetRequest.retryInfo.wasRetried = true;
                    } else {
                        // Fallback to global
                        this.processRetryAttempt(line, lines, i, currentRetryInfo);
                        currentRetryInfo.actualAttempts = (currentRetryInfo.actualAttempts || 1) + 1;
                        currentRetryInfo.wasRetried = true;
                    }
                }
            }

            // Handle any remaining pending requests
            for (const [key, request] of pendingRequests) {
                // Only set default status if no response status was captured
                if (request.responseStatus === undefined) {
                    LogFileParser.outputChannel?.appendLine(`[LogFileParser] Pending request without status, assuming 200 OK`);
                    request.responseStatus = 200;
                    request.responseStatusText = 'OK';
                } else {
                    LogFileParser.outputChannel?.appendLine(`[LogFileParser] Pending request already has status: ${request.responseStatus} ${request.responseStatusText}`);
                }
                // Ensure retryInfo is set and actualAttempts is correct
                if (!request.retryInfo) {
                    request.retryInfo = { actualAttempts: currentRetryInfo.actualAttempts || 1 };
                }
                // If attempts array exists, use its length
                if (request.retryInfo.attempts && request.retryInfo.attempts.length > 0) {
                    request.retryInfo.actualAttempts = request.retryInfo.attempts.length + 1; // initial + retries
                } else if (typeof request.retryInfo.actualAttempts !== 'number' || request.retryInfo.actualAttempts < 1) {
                    request.retryInfo.actualAttempts = 1;
                }
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Moving request to completed - has response body: ${request.responseBody ? 'yes' : 'no'}, length: ${request.responseBody?.length || 0}`);
                requests.push(request);
                this.outputChannel?.appendLine(`[LogFileParser] Moved pending request to completed: ${key} with final status ${request.responseStatus}`);
            }

            this.outputChannel?.appendLine(`[LogFileParser] Completed parsing. Found ${requests.length} requests, foundHttpRequest: ${foundHttpRequest}`);

            return {
                requests,
                connectionError,
                foundHttpRequest
            };
        } catch (error) {
            this.outputChannel?.appendLine(`[LogFileParser] Error parsing log file: ${error}`);
            throw error;
        }
    }

    private static isLogRequestStartLine(line: string): boolean {
        // Look for log patterns that indicate HTTP request start
        // These patterns should match what TeaPie logs at Trace level when starting an HTTP request
        
        // Skip internal system requests
        if (this.isInternalSystemRequest(line)) {
            return false;
        }
        
        // Only consider requests that look like actual user HTTP requests
        const hasHttpMethod = line.includes('POST ') || line.includes('GET ') || line.includes('PUT ') || 
                             line.includes('DELETE ') || line.includes('PATCH ') || line.includes('HEAD ') ||
                             line.includes('OPTIONS ');
        
        const hasUrl = line.includes('http://') || line.includes('https://');
        
        // Additional patterns that indicate this is a real HTTP request log entry
        const hasRequestIndicator = line.includes('Sending HTTP request') || 
                                   line.includes('HTTP Request:') ||
                                   line.includes('Starting request to');
        
        return (hasHttpMethod && hasUrl) || hasRequestIndicator;
    }

    private static isInternalSystemRequest(line: string): boolean {
        // Filter out internal TeaPie/system requests that shouldn't be shown to users
        const internalPatterns = [
            // NuGet and package management
            'api.nuget.org',
            'nuget.org',
            'packages.nuget.org',
            'registration5-gz-semver2',
            
            // Authentication
            '/auth/token',
            '/token',
            'oauth',
            
            // Microsoft services
            'microsoft.com',
            'dotnet.microsoft.com',
            'login.microsoftonline.com',
            
            // Development/build tools
            'github.com/NuGet',
            'dotnetcli.azureedge.net',
            
            // Package names that are clearly internal
            'microsoft.csharp',
            'xunit.assert',
            'system.',
            'microsoft.',
        ];
        
        const lowerLine = line.toLowerCase();
        return internalPatterns.some(pattern => lowerLine.includes(pattern.toLowerCase()));
    }

    private static isLogRequestBodyLine(line: string): boolean {
        // Look for request body indicators in logs
        return line.includes('Request Body:') || 
               line.includes('Body:') ||
               line.includes('Request content:') ||
               line.includes('Following HTTP request\'s body') ||
               line.includes("Following HTTP request's body");
    }

    private static isLogResponseLine(line: string): boolean {
        // Look for response indicators in logs - be more flexible with status codes
        const hasResponseIndicator = line.includes('Response:') || 
                                    line.includes('HTTP Response:') ||
                                    line.includes('Received response') ||
                                    line.includes('Response received') ||
                                    line.includes('HTTP response') ||
                                    line.includes('Response status:') ||
                                    line.includes('Status code:');
        
        // Look for HTTP status line patterns
        const hasHttpStatus = line.includes('HTTP/') && /\s\d{3}\s/.test(line);
        
        // Look for status code patterns (more flexible)
        const hasStatusCode = /status:\s*\d{3}/i.test(line) || 
                             /code:\s*\d{3}/i.test(line) ||
                             /response.*\d{3}/i.test(line) ||
                             /\b\d{3}\b/.test(line) && (line.includes('OK') || line.includes('Created') || line.includes('Bad Request') || line.includes('Not Found'));
        
        // Look for standalone status codes that might be on their own line
        const hasStandaloneStatus = /^\s*\d{3}\s*$/.test(line);
        
        return hasResponseIndicator || hasHttpStatus || hasStatusCode || hasStandaloneStatus;
    }

    private static isLogRequestHeaderLine(line: string): boolean {
        // Look for request header indicators in logs from TeaPie response body
        return (line.includes('"headers"') || line.includes('"Authorization"') || 
                line.includes('"Content-Type"') || line.includes('"User-Agent"') ||
                line.includes('"Accept"') || line.includes('"Host"')) && line.includes(':');
    }

    private static isLogResponseHeaderLine(line: string): boolean {
        // Look for response header indicators in logs
        return line.includes('Response headers:') || 
               (line.includes('Content-Length') || line.includes('Content-Type') || 
                line.includes('Server') || line.includes('Date') ||
                line.includes('Cache-Control') || line.includes('Set-Cookie')) && line.includes(':');
    }

    private static isLogResponseBodyLine(line: string): boolean {
        // Look for response body indicators in logs - be more specific
        return line.includes('Response Body:') || 
               line.includes('Response content:') ||
               line.includes('Body content:') ||
               line.includes('Response data:') ||
               line.includes('Body:') ||
               line.includes('Response\'s body') ||
               // Specific TeaPie pattern: "[VRB] Response's body (application/json):"
               (line.includes('Response\'s body') && line.includes('(') && line.includes('):')) ||
               // TeaPie also logs request body: "[VRB] Following HTTP request's body"
               (line.includes('HTTP request\'s body') && line.includes('(') && line.includes('):'));
               // Removed the JSON detection patterns that were causing overwrites
    }

    private static isLogRequestEndLine(line: string): boolean {
        // Look for request completion indicators in logs
        return line.includes('Request completed') || 
               line.includes('HTTP request finished') ||
               line.includes('Request execution completed');
    }

    private static isLogConnectionErrorLine(line: string): boolean {
        // Look for connection error indicators in logs
        return line.includes('Connection refused') || 
               line.includes('Host not found') ||
               line.includes('Connection timeout') ||
               line.includes('Network error');
    }

    private static isRetryStrategyLine(line: string): boolean {
        return line.includes('retry strategy') || 
               line.includes('Maximal number of retry attempts') ||
               line.includes('Backoff type') ||
               line.includes('Using altered default retry strategy') ||
               line.includes('Using default retry strategy');
    }

    private static isRetryAttemptLine(line: string): boolean {
        // TeaPie retry patterns based on actual logs
        // Primary pattern: "[DBG] Retry attempt number 1."
        return line.includes('Retry attempt number') ||
               line.includes('Retrying request') ||
               line.includes('Request failed, retrying') ||
               line.includes('Attempting retry') ||
               // Pattern for subsequent HTTP requests after failure
               (line.includes('Sending HTTP request') && line.includes('(retry'));
    }

    private static processRetryAttempt(line: string, lines: string[], currentIndex: number, currentRetryInfo: Partial<RetryInfo>): void {
        // Initialize attempts array if not exists
        if (!currentRetryInfo.attempts) {
            currentRetryInfo.attempts = [];
        }

        const attemptNumber = currentRetryInfo.attempts.length + 1;
        const attempt: import('./HttpRequestTypes').RetryAttempt = {
            attemptNumber,
            success: false, // Will be updated below
            timestamp: this.extractTimestamp(line)
        };

        // Look ahead for the response status of this retry attempt
        let foundStatus = false;
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Processing retry attempt ${attemptNumber} from line: ${line.trim()}`);
        
        for (let i = currentIndex + 1; i < Math.min(currentIndex + 50, lines.length); i++) {
            const nextLine = lines[i];
            
            // Look for TeaPie-specific HTTP response patterns
            // Pattern 1: "Received HTTP response headers after 122.684ms - 200"
            const responseHeaderMatch = nextLine.match(/Received HTTP response headers after [^-]+ - (\d+)/);
            if (responseHeaderMatch) {
                attempt.statusCode = parseInt(responseHeaderMatch[1], 10);
                attempt.success = attempt.statusCode >= 200 && attempt.statusCode < 400;
                foundStatus = true;
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] ✅ Found status via response headers: ${attempt.statusCode}, success: ${attempt.success}`);
                break;
            }
            
            // Pattern 2: "HTTP Response 200 (OK) was received from..."
            const httpResponseMatch = nextLine.match(/HTTP Response (\d+) \(([^)]+)\) was received/);
            if (httpResponseMatch) {
                attempt.statusCode = parseInt(httpResponseMatch[1], 10);
                attempt.statusText = httpResponseMatch[2];
                attempt.success = attempt.statusCode >= 200 && attempt.statusCode < 400;
                foundStatus = true;
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] ✅ Found status via HTTP Response: ${attempt.statusCode} (${attempt.statusText}), success: ${attempt.success}`);
                break;
            }
            
            // Pattern 3: "End processing HTTP request after 110.8695ms - 200"
            const endProcessingMatch = nextLine.match(/End processing HTTP request after [^-]+ - (\d+)/);
            if (endProcessingMatch) {
                attempt.statusCode = parseInt(endProcessingMatch[1], 10);
                attempt.success = attempt.statusCode >= 200 && attempt.statusCode < 400;
                foundStatus = true;
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] ✅ Found status via end processing: ${attempt.statusCode}, success: ${attempt.success}`);
                break;
            }
            
            // Look for actual error messages (not test failures)
            if ((nextLine.includes('[ERR]') || nextLine.includes('error') || nextLine.includes('failed') || nextLine.includes('timeout')) 
                && !nextLine.includes('Test') && !nextLine.includes('Assert')) {
                attempt.errorMessage = nextLine.trim();
                attempt.success = false;
                foundStatus = true;
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] ❌ Found error: ${attempt.errorMessage}`);
                break;
            }
            
            // Stop looking if we hit another retry attempt, but NOT if we hit "Start processing HTTP request" 
            // since that's part of the current retry attempt
            if (nextLine.includes('Retry attempt number') && !nextLine.includes(`Retry attempt number ${attemptNumber}`)) {
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Stopping search at next retry attempt: ${nextLine.trim().substring(0, 100)}`);
                break;
            }
        }

        // If no status found, default to failed
        if (!foundStatus) {
            attempt.success = false;
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] ❌ No status found for retry attempt ${attemptNumber}, defaulting to failed`);
        }

        currentRetryInfo.attempts.push(attempt);
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Final retry attempt ${attemptNumber}: status=${attempt.statusCode}, success=${attempt.success}, timestamp=${attempt.timestamp}`);
    }

    private static extractTimestamp(line: string): string | undefined {
        // Try to extract timestamp from log line
        const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
        return timestampMatch ? timestampMatch[1] : undefined;
    }

    private static processLogRequestStart(
        line: string,
        pendingRequests: Map<string, InternalRequest>,
        httpFileRequests: HttpFileRequest[],
        httpFileRequestIdx: number,
        requestCounter: number,
        currentRetryInfo: Partial<RetryInfo>,
        httpRetryDirectives: { [requestName: string]: Partial<RetryInfo> }
    ): boolean {
        // Extract HTTP method and URL from log line
        const methodMatch = line.match(/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^\s]+)/);
        if (!methodMatch) return false;

        const method = methodMatch[1];
        const url = methodMatch[2];
        
        // Skip if this is an internal system request
        if (this.isInternalSystemRequest(line)) {
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Skipped internal request: ${line.substring(0, 100)}`);
            return false;
        }
        
        // Prefer localhost requests for testing - this helps filter out external calls
        const isLocalhost = url.includes('localhost') || url.includes('127.0.0.1');
        if (!isLocalhost && (url.includes('api.') || url.includes('microsoft.') || url.includes('nuget.'))) {
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Skipped non-localhost request: ${method} ${url}`);
            return false;
        }
        
        // Create request key - use a simpler approach to avoid duplicates
        const requestKey = `${method}_${url}_${Date.now()}`;
        
        // Try to find matching HTTP file request by method and URL pattern
        let httpFileRequest = this.findMatchingHttpFileRequest(method, url, httpFileRequests);
        
        // If no exact match found, try to use sequential matching as fallback
        if (!httpFileRequest && httpFileRequestIdx < httpFileRequests.length) {
            httpFileRequest = httpFileRequests[httpFileRequestIdx];
        }
        
        // If we have more requests in log than in HTTP file, create a generic entry
        const requestName = httpFileRequest?.name || httpFileRequest?.title || `${method} ${url}`;
        
        // Merge retry information from log and HTTP file directives
        let finalRetryInfo: Partial<RetryInfo> = {};
        
        // Start with HTTP file directive if available
        if (httpFileRequest?.name && httpRetryDirectives[httpFileRequest.name]) {
            finalRetryInfo = { ...httpRetryDirectives[httpFileRequest.name] };
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Using HTTP file retry directive for ${httpFileRequest.name}: ${JSON.stringify(finalRetryInfo)}`);
        }
        
        // Override/merge with log-based retry info (TeaPie's actual behavior)
        if (Object.keys(currentRetryInfo).length > 0) {
            const httpDirective = httpFileRequest?.name ? httpRetryDirectives[httpFileRequest.name] : null;
            
            // If log shows retry configuration (even if no retries occurred)
            if (currentRetryInfo.maxAttempts) {
                finalRetryInfo.maxAttempts = currentRetryInfo.maxAttempts;
                finalRetryInfo.backoffType = currentRetryInfo.backoffType || finalRetryInfo.backoffType;
                finalRetryInfo.strategyName = currentRetryInfo.strategyName || finalRetryInfo.strategyName;
                finalRetryInfo.actualAttempts = currentRetryInfo.actualAttempts;
                finalRetryInfo.wasRetried = currentRetryInfo.wasRetried;
                
                // If HTTP file had different configuration, note the match or mismatch
                if (httpDirective?.maxAttempts) {
                    if (httpDirective.maxAttempts === currentRetryInfo.maxAttempts) {
                        finalRetryInfo.strategyName = `${currentRetryInfo.strategyName || 'Default'} (as configured)`;
                    } else {
                        finalRetryInfo.strategyName = `${currentRetryInfo.strategyName || 'Default'} (configured: ${httpDirective.maxAttempts}, used: ${currentRetryInfo.maxAttempts})`;
                    }
                }
                
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Merged retry info for ${httpFileRequest?.name}: log=${JSON.stringify(currentRetryInfo)}, final=${JSON.stringify(finalRetryInfo)}`);
            } else {
                // Normal case - merge without conflicts
                finalRetryInfo = { ...finalRetryInfo, ...currentRetryInfo };
            }
        } else if (Object.keys(finalRetryInfo).length > 0) {
            // HTTP file had retry directives but no retry info in log
            // This means TeaPie might have ignored the directives
            finalRetryInfo.strategyName = `${finalRetryInfo.strategyName || 'Configured'} (not detected in logs)`;
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] HTTP file had retry directives for ${httpFileRequest?.name} but TeaPie logs didn't show retry info`);
        }
        
        const request: InternalRequest = {
            method,
            url,
            requestHeaders: {},
            requestBody: httpFileRequest?.requestBody || undefined,
            responseStatus: undefined,
            responseStatusText: '',
            responseHeaders: {},
            responseBody: '',
            duration: '0ms',
            uniqueKey: requestKey,
            title: httpFileRequest?.title || null,
            name: requestName,
            templateUrl: httpFileRequest?.templateUrl || null,
            retryInfo: Object.keys(finalRetryInfo).length > 0 ? finalRetryInfo as RetryInfo : undefined
        };

        pendingRequests.set(requestKey, request);
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Started processing request: ${requestKey} (${requestName}) - matched with HTTP file request: ${httpFileRequest ? 'Yes' : 'No'}`);
        return true;
    }

    private static findMatchingHttpFileRequest(method: string, url: string, httpFileRequests: HttpFileRequest[]): HttpFileRequest | null {
        // First try exact method and URL path match
        for (const httpRequest of httpFileRequests) {
            if (httpRequest.method === method) {
                // Extract path from both URLs for comparison
                const logUrlPath = this.extractUrlPath(url);
                const httpUrlPath = this.extractUrlPath(httpRequest.url);
                
                if (logUrlPath === httpUrlPath) {
                    LogFileParser.outputChannel?.appendLine(`[LogFileParser] Exact match found: ${method} ${logUrlPath}`);
                    return httpRequest;
                }
            }
        }
        
        // Then try method match with partial URL match (for cases with variable substitution)
        for (const httpRequest of httpFileRequests) {
            if (httpRequest.method === method) {
                const logUrlPath = this.extractUrlPath(url);
                const httpUrlPath = this.extractUrlPath(httpRequest.url);
                
                // Check if URLs match after removing variable parts (like /cars/6 matching /cars/{{id}})
                if (this.urlPathsMatch(logUrlPath, httpUrlPath)) {
                    LogFileParser.outputChannel?.appendLine(`[LogFileParser] Pattern match found: ${method} ${logUrlPath} ~ ${httpUrlPath}`);
                    return httpRequest;
                }
            }
        }
        
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] No match found for: ${method} ${url}`);
        return null;
    }

    private static extractUrlPath(url: string): string {
        try {
            // Remove protocol and host, keep only path
            const urlObj = new URL(url);
            return urlObj.pathname;
        } catch {
            // If URL parsing fails, try to extract path manually
            const match = url.match(/^https?:\/\/[^\/]+(.*)$/);
            return match ? match[1] : url;
        }
    }

    private static urlPathsMatch(logPath: string, httpPath: string): boolean {
        // Simple pattern matching - replace variable patterns with wildcards
        const httpPattern = httpPath.replace(/\{\{[^}]+\}\}/g, '[^/]+');
        const regex = new RegExp(`^${httpPattern}$`);
        return regex.test(logPath);
    }

    private static processLogRequestBody(
        line: string,
        lines: string[],
        currentIndex: number,
        pendingRequests: Map<string, InternalRequest>
    ): void {
        // Extract request body from subsequent lines after body indicator
        const body = this.extractLogBody(lines, currentIndex);
        
        // Find the most recent pending request that doesn't have a request body yet
        const requests = Array.from(pendingRequests.values());
        let targetRequest = requests.find(req => !req.requestBody || req.requestBody.length === 0);
        
        // If no request without body found, fall back to most recent request
        if (!targetRequest && requests.length > 0) {
            targetRequest = requests[requests.length - 1];
        }
        
        if (targetRequest) {
            targetRequest.requestBody = body;
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Added request body to request: ${targetRequest.method} ${targetRequest.url}`);
        }
    }

    private static processLogResponse(line: string, pendingRequests: Map<string, InternalRequest>): void {
        // Try multiple patterns to extract response status
        let statusCode: number | undefined;
        let statusText = '';
        
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Processing response line: ${line}`);
        
        // Pattern 1: HTTP/1.1 200 OK
        const httpStatusMatch = line.match(/HTTP\/[\d.]+\s+(\d{3})\s*([^\r\n]*)/);
        if (httpStatusMatch) {
            statusCode = parseInt(httpStatusMatch[1], 10);
            statusText = httpStatusMatch[2].trim();
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found HTTP status pattern: ${statusCode} ${statusText}`);
        }
        
        // Pattern 2: TeaPie specific format "HTTP Response 201 (Created)" 
        if (!statusCode) {
            const teaPieMatch = line.match(/HTTP Response (\d{3}) \(([^)]+)\)/);
            if (teaPieMatch) {
                statusCode = parseInt(teaPieMatch[1], 10);
                statusText = teaPieMatch[2].trim();
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found TeaPie response pattern: ${statusCode} ${statusText}`);
                
                // Check if there's duration info in the same line
                const durationMatch = line.match(/([\d.]+)ms/);
                if (durationMatch) {
                    const duration = parseFloat(durationMatch[1]);
                    const requests = Array.from(pendingRequests.values());
                    if (requests.length > 0) {
                        const lastRequest = requests[requests.length - 1];
                        // Set duration if not already set by header pattern
                        if (lastRequest.duration === '0ms') {
                            lastRequest.duration = `${Math.round(duration)}ms`;
                            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Extracted duration from TeaPie pattern: ${lastRequest.duration}`);
                        }
                    }
                }
            }
        }
        
        // Pattern 3: "Received HTTP response headers after 166.1226ms - 201"
        if (!statusCode) {
            const headerMatch = line.match(/Received HTTP response headers.*?-\s*(\d{3})/);
            if (headerMatch) {
                statusCode = parseInt(headerMatch[1], 10);
                statusText = this.getDefaultStatusText(statusCode);
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found header response pattern: ${statusCode} ${statusText}`);
                
                // Extract total duration from this line if available
                const durationMatch = line.match(/after\s+([\d.]+)ms/);
                if (durationMatch) {
                    const duration = parseFloat(durationMatch[1]);
                    // This could be either TTFB or total - we'll use it as the main duration
                    const requests = Array.from(pendingRequests.values());
                    if (requests.length > 0) {
                        const lastRequest = requests[requests.length - 1];
                        // Use this as the main duration since it's often the most reliable timing
                        lastRequest.duration = `${Math.round(duration)}ms`;
                        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Extracted duration: ${lastRequest.duration}`);
                    }
                }
            }
        }
        
        // Extract headers from the response body if it contains header information
        this.extractHeadersFromResponseBody(line, pendingRequests);
        
        // Pattern 4: Status: 200, Code: 200, etc.
        if (!statusCode) {
            const statusMatch = line.match(/(?:status|code):\s*(\d{3})/i);
            if (statusMatch) {
                statusCode = parseInt(statusMatch[1], 10);
                // Try to extract status text from the same line
                const textMatch = line.match(/(?:status|code):\s*\d{3}\s+([^\r\n,;]+)/i);
                if (textMatch) {
                    statusText = textMatch[1].trim();
                }
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found status/code pattern: ${statusCode} ${statusText}`);
            }
        }
        
        // Pattern 5: Just a number followed by status text
        if (!statusCode) {
            const numberMatch = line.match(/\b(\d{3})\s+([A-Za-z][^\r\n,;]*)/);
            if (numberMatch) {
                const code = parseInt(numberMatch[1], 10);
                // Only accept if it's a valid HTTP status code
                if (code >= 100 && code < 600) {
                    statusCode = code;
                    statusText = numberMatch[2].trim();
                    LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found number pattern: ${statusCode} ${statusText}`);
                }
            }
        }
        
        // Pattern 6: Look for standalone status codes (like "201" on its own line)
        if (!statusCode) {
            const standaloneMatch = line.match(/^\s*(\d{3})\s*$/);
            if (standaloneMatch) {
                const code = parseInt(standaloneMatch[1], 10);
                if (code >= 100 && code < 600) {
                    statusCode = code;
                    statusText = this.getDefaultStatusText(code);
                    LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found standalone status: ${statusCode} ${statusText}`);
                }
            }
        }
        
        if (!statusCode) {
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Could not extract status from response line: ${line}`);
            return;
        }
        
        // Find the most recent pending request that doesn't have a response status yet
        const requests = Array.from(pendingRequests.values());
        let targetRequest = requests.find(req => req.responseStatus === undefined);
        
        // If no request without status found, fall back to most recent request
        if (!targetRequest && requests.length > 0) {
            targetRequest = requests[requests.length - 1];
        }
        
        if (targetRequest) {
            targetRequest.responseStatus = statusCode;
            targetRequest.responseStatusText = statusText || this.getDefaultStatusText(statusCode);
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Added response status: ${statusCode} ${targetRequest.responseStatusText} to request ${targetRequest.name}`);
        } else {
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] No pending request found for response: ${statusCode} ${statusText}`);
        }
    }

    private static getDefaultStatusText(statusCode: number): string {
        const statusTexts: { [key: number]: string } = {
            200: 'OK',
            201: 'Created',
            202: 'Accepted',
            204: 'No Content',
            400: 'Bad Request',
            401: 'Unauthorized',
            403: 'Forbidden',
            404: 'Not Found',
            405: 'Method Not Allowed',
            409: 'Conflict',
            422: 'Unprocessable Entity',
            500: 'Internal Server Error',
            502: 'Bad Gateway',
            503: 'Service Unavailable'
        };
        return statusTexts[statusCode] || 'Unknown';
    }

    private static processLogResponseBody(
        line: string,
        lines: string[],
        currentIndex: number,
        pendingRequests: Map<string, InternalRequest>
    ): void {
        // Extract response body from subsequent lines after body indicator
        const body = this.extractLogBody(lines, currentIndex);
        
        // Find the most recent pending request that has a response status but no body yet
        const requests = Array.from(pendingRequests.values());
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Processing response body for line: ${line.substring(0, 100)}`);
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found ${requests.length} pending requests`);
        
        // Look for a request that has a response status but no body yet (most likely candidate)
        let targetRequest = requests.find(req => req.responseStatus !== undefined && (!req.responseBody || req.responseBody.length === 0));
        
        // If no request with status found, fall back to most recent request
        if (!targetRequest && requests.length > 0) {
            targetRequest = requests[requests.length - 1];
        }
        
        if (targetRequest) {
            // Only set response body if it's not already set or if the new body is longer
            if (!targetRequest.responseBody || targetRequest.responseBody.length === 0 || body.length > targetRequest.responseBody.length) {
                targetRequest.responseBody = body;
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] ✅ Added response body to request: ${targetRequest.method} ${targetRequest.url}`);
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Response body content (first 200 chars): ${body.substring(0, 200)}`);
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Response body full length: ${body.length} characters`);
            } else {
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] ⚠️ Skipped response body assignment (already has body of length ${targetRequest.responseBody.length})`);
            }
        } else {
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] ❌ No pending requests found for response body`);
        }
    }

    private static processLogRequestEnd(
        line: string,
        pendingRequests: Map<string, InternalRequest>,
        requests: InternalRequest[]
    ): void {
        // Extract duration if available in this completion line
        const durationMatch = line.match(/(\d+(?:\.\d+)?)\s*ms/);
        
        // Move the most recent pending request to completed
        const pendingEntries = Array.from(pendingRequests.entries());
        if (pendingEntries.length > 0) {
            const [key, request] = pendingEntries[pendingEntries.length - 1];
            
            // Only update duration if we found one in this line AND no duration was previously set
            if (durationMatch && request.duration === '0ms') {
                const duration = parseFloat(durationMatch[1]);
                request.duration = `${Math.round(duration)}ms`;
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Updated duration from completion line: ${request.duration}`);
            }
            
            // Only set default status if no response status was captured
            if (request.responseStatus === undefined) {
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Request completed without status, assuming 200 OK`);
                request.responseStatus = 200;
                request.responseStatusText = 'OK';
            } else {
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Request completed with captured status: ${request.responseStatus} ${request.responseStatusText}`);
            }
            
            requests.push(request);
            pendingRequests.delete(key);
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Completed request: ${key} with final status ${request.responseStatus} and duration ${request.duration}`);
        }
    }

    private static extractLogConnectionError(line: string, lines: string[], currentIndex: number): string {
        // Extract connection error details from log
        let error = line;
        
        // Look at next few lines for more error details
        for (let i = currentIndex + 1; i < Math.min(currentIndex + 3, lines.length); i++) {
            const nextLine = lines[i].trim();
            if (nextLine && !this.hasLogTimestamp(nextLine)) {
                error += ' ' + nextLine;
            } else {
                break;
            }
        }
        
        return error;
    }

    private static extractLogBody(lines: string[], startIndex: number): string {
        const bodyLines: string[] = [];
        
        // First check if the body is inline on the same line (after ':' at the end)
        const startLine = lines[startIndex].trim();
        if (startLine.includes('):') && startLine.split('):').length > 1) {
            const inlineBody = startLine.split('):')[1].trim();
            if (inlineBody && (inlineBody.startsWith('{') || inlineBody.startsWith('['))) {
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Found inline body: ${inlineBody.substring(0, 100)}`);
                return inlineBody;
            }
        }
        
        // Otherwise, extract from subsequent lines
        let i = startIndex + 1;
        
        while (i < lines.length) {
            const line = lines[i].trim();
            
            // Stop if we hit another log entry or empty line pattern
            if (this.hasLogTimestamp(line) || 
                this.isLogRequestStartLine(line) ||
                this.isLogResponseLine(line)) {
                break;
            }
            
            if (line) {
                bodyLines.push(line);
            }
            i++;
        }
        
        const extractedBody = bodyLines.join('\n').trim();
        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Extracted body from lines: ${extractedBody.substring(0, 100)}`);
        return extractedBody;
    }

    private static hasLogTimestamp(line: string): boolean {
        // Check if line starts with timestamp pattern common in logs
        // TeaPie format: "2025-07-28 10:50:55.605 +02:00 [DBG]"
        return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+[+-]\d{2}:\d{2}\s+\[/.test(line) ||
               /^\[?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}/.test(line) ||
               /^\d{2}:\d{2}:\d{2}/.test(line) ||
               line.includes('trce:') || line.includes('dbug:') || 
               line.includes('info:') || line.includes('warn:') || 
               line.includes('fail:') || line.includes('crit:') ||
               // TeaPie log levels
               line.includes('[VRB]') || line.includes('[DBG]') || 
               line.includes('[INF]') || line.includes('[ERR]');
    }

    /**
     * Builds final HTTP request results by combining log file data with test results
     */
    static buildHttpRequestResults(
        fileName: string,
        filePath: string,
        logResult: CliParseResult,
        testResultsFromXml: Map<string, HttpTestResult[]>
    ): HttpRequestResults {
        const requests: HttpRequestResult[] = [];
        
        // Check if any HTTP requests were found
        if (!logResult.foundHttpRequest) {
            return {
                RequestGroups: {
                    RequestGroup: [{
                        Name: fileName,
                        FilePath: filePath,
                        Requests: [{
                            Name: 'No HTTP requests found',
                            Status: STATUS_FAILED,
                            Duration: '0ms',
                            ErrorMessage: 'No HTTP requests were processed - check if the file contains valid HTTP requests or if there are connection issues'
                        }],
                        Status: STATUS_FAILED,
                        Duration: '0s'
                    }]
                }
            };
        }

        // Handle connection errors
        if (logResult.connectionError && logResult.requests.length === 0) {
            return {
                RequestGroups: {
                    RequestGroup: [{
                        Name: fileName,
                        FilePath: filePath,
                        Requests: [{
                            Name: ERROR_HTTP_FAILED,
                            Status: STATUS_FAILED,
                            Duration: '0ms',
                            ErrorMessage: logResult.connectionError
                        }],
                        Status: STATUS_FAILED,
                        Duration: '0s'
                    }]
                }
            };
        }
        
        logResult.requests.forEach((internalRequest, index) => {
            const testResults = testResultsFromXml.get(internalRequest.name || `Request ${index + 1}`) || [];
            
            // Determine if HTTP response is successful (2xx or 3xx status codes)
            const httpSuccess = internalRequest.responseStatus && internalRequest.responseStatus >= 200 && internalRequest.responseStatus < 400;
            
            // Determine if all tests passed
            const allTestsPassed = testResults.length === 0 || testResults.every(test => test.Passed);
            
            // Request is successful only if both HTTP response is successful AND all tests passed
            const requestSuccess = httpSuccess && allTestsPassed;
            
            // Debug: Log the response body state before creating HttpRequestResult
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Converting request ${index + 1}: ${internalRequest.method} ${internalRequest.url}`);
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Has response status: ${internalRequest.responseStatus ? 'yes' : 'no'}`);
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Has response body: ${internalRequest.responseBody ? 'yes' : 'no'}, length: ${internalRequest.responseBody?.length || 0}`);
            if (internalRequest.responseBody) {
                LogFileParser.outputChannel?.appendLine(`[LogFileParser] Response body preview: ${internalRequest.responseBody.substring(0, 100)}`);
            }
            
            requests.push({
                Name: internalRequest.name || `Request ${index + 1}`,
                Status: requestSuccess ? STATUS_PASSED : STATUS_FAILED,
                Duration: internalRequest.duration || '0ms',
                Request: {
                    Method: internalRequest.method,
                    Url: internalRequest.url,
                    TemplateUrl: internalRequest.templateUrl || undefined,
                    Headers: internalRequest.requestHeaders,
                    Body: internalRequest.requestBody
                },
                Response: internalRequest.responseStatus ? {
                    StatusCode: internalRequest.responseStatus,
                    StatusText: internalRequest.responseStatusText || 'OK',
                    Headers: internalRequest.responseHeaders,
                    Body: internalRequest.responseBody,
                    Duration: internalRequest.duration || '0ms'
                } : undefined,
                ErrorMessage: internalRequest.ErrorMessage,
                Tests: testResults,
                RetryInfo: internalRequest.retryInfo
            });
        });

        // Add custom CSX tests as a separate request item if they exist
        const customTests = testResultsFromXml.get('_CUSTOM_CSX_TESTS');
        if (customTests?.length) {
            const allPassed = customTests.every(test => test.Passed);
            requests.push({
                Name: 'Custom CSX Tests',
                Status: allPassed ? STATUS_PASSED : STATUS_FAILED,
                Duration: '0ms',
                Tests: customTests
            });
        }

        return {
            RequestGroups: {
                RequestGroup: [{
                    Name: fileName,
                    FilePath: filePath,
                    Requests: requests,
                    Status: requests.every(r => r.Status === STATUS_PASSED) ? STATUS_PASSED : STATUS_FAILED,
                    Duration: '0s'
                }]
            }
        };
    }

    private static extractHeadersFromResponseBody(line: string, pendingRequests: Map<string, InternalRequest>): void {
        // Extract headers from TeaPie response body which contains the actual headers sent
        const requests = Array.from(pendingRequests.values());
        if (requests.length === 0) return;
        
        const lastRequest = requests[requests.length - 1];
        
        // Look for header patterns in the response body (TeaPie logs the original request headers in the response)
        const headerMatches = [
            line.match(/"Authorization":\s*"([^"]+)"/),
            line.match(/"User-Agent":\s*"([^"]+)"/),
            line.match(/"Content-Type":\s*"([^"]+)"/),
            line.match(/"Host":\s*"([^"]+)"/),
            line.match(/"Accept":\s*"([^"]+)"/),
            line.match(/"Content-Length":\s*"([^"]+)"/)
        ];
        
        headerMatches.forEach((match, index) => {
            if (match) {
                const headerNames = ['Authorization', 'User-Agent', 'Content-Type', 'Host', 'Accept', 'Content-Length'];
                const headerName = headerNames[index];
                if (headerName) {
                    lastRequest.requestHeaders[headerName] = match[1];
                    LogFileParser.outputChannel?.appendLine(`[LogFileParser] Extracted request header: ${headerName}: ${match[1]}`);
                }
            }
        });
    }

    private static processRetryStrategyInfo(line: string, currentRetryInfo: Partial<RetryInfo>): void {
        if (line.includes('retry strategy with name')) {
            const nameMatch = line.match(/retry strategy with name '([^']*)'/) || line.match(/retry strategy with name "([^"]*)"/);
            if (nameMatch) {
                currentRetryInfo.strategyName = nameMatch[1] || 'Default retry';
            }
        } else if (line.includes('Using altered default retry strategy')) {
            // This indicates TeaPie used custom retry settings
            currentRetryInfo.strategyName = 'Default (altered)';
        } else if (line.includes('Using default retry strategy')) {
            // This indicates TeaPie used unmodified default settings
            currentRetryInfo.strategyName = 'Default retry';
        } else if (line.includes('Maximal number of retry attempts')) {
            const attemptsMatch = line.match(/Maximal number of retry attempts:\s*(\d+)/);
            if (attemptsMatch) {
                currentRetryInfo.maxAttempts = parseInt(attemptsMatch[1], 10);
            }
        } else if (line.includes('Backoff type')) {
            const backoffMatch = line.match(/Backoff type:\s*'([^']+)'/);
            if (backoffMatch) {
                currentRetryInfo.backoffType = backoffMatch[1];
            }
        }
    }

    /**
     * Parse retry directives from HTTP file content to detect intended retry configuration
     */
    private static parseHttpFileRetryDirectives(httpFileContent: string): { [requestName: string]: Partial<RetryInfo> } {
        const directives: { [requestName: string]: Partial<RetryInfo> } = {};
        const lines = httpFileContent.split('\n');
        let currentRequestName = '';
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Look for request names
            const nameMatch = line.match(/^#\s*@name\s+(.+)$/);
            if (nameMatch) {
                currentRequestName = nameMatch[1].trim();
                continue;
            }
            
            // Look for retry directives
            if (currentRequestName && line.startsWith('## RETRY-')) {
                if (!directives[currentRequestName]) {
                    directives[currentRequestName] = {};
                }
                
                if (line.startsWith('## RETRY-STRATEGY:')) {
                    const strategyMatch = line.match(/## RETRY-STRATEGY:\s*(.+)$/);
                    if (strategyMatch) {
                        directives[currentRequestName].strategyName = strategyMatch[1].trim();
                    }
                } else if (line.startsWith('## RETRY-MAX-ATTEMPTS:')) {
                    const attemptsMatch = line.match(/## RETRY-MAX-ATTEMPTS:\s*(\d+)/);
                    if (attemptsMatch) {
                        directives[currentRequestName].maxAttempts = parseInt(attemptsMatch[1], 10);
                    }
                } else if (line.startsWith('## RETRY-BACKOFF-TYPE:')) {
                    const backoffMatch = line.match(/## RETRY-BACKOFF-TYPE:\s*(.+)$/);
                    if (backoffMatch) {
                        directives[currentRequestName].backoffType = backoffMatch[1].trim();
                    }
                }
            }
            
            // Reset on new request section
            if (line.startsWith('###')) {
                currentRequestName = '';
            }
        }
        
        return directives;
    }

    /**
     * For testing: inject mock retry data to demonstrate the retry UI
     */
    static injectMockRetryData(request: InternalRequest, scenario: 'multiple-failures' | 'connection-failures' | 'success-first'): void {
        if (!request.retryInfo) {
            request.retryInfo = {};
        }

        switch (scenario) {
            case 'multiple-failures':
                request.retryInfo = {
                    strategyName: 'RetryWithBackoff',
                    maxAttempts: 8,
                    actualAttempts: 8,
                    backoffType: 'Exponential',
                    wasRetried: true,
                    attempts: [
                        { attemptNumber: 1, statusCode: 500, statusText: 'Internal Server Error', success: false, timestamp: '14:23:01' },
                        { attemptNumber: 2, statusCode: 500, statusText: 'Internal Server Error', success: false, timestamp: '14:23:03' },
                        { attemptNumber: 3, statusCode: 500, statusText: 'Internal Server Error', success: false, timestamp: '14:23:07' },
                        { attemptNumber: 4, statusCode: 500, statusText: 'Internal Server Error', success: false, timestamp: '14:23:15' },
                        { attemptNumber: 5, statusCode: 500, statusText: 'Internal Server Error', success: false, timestamp: '14:23:31' },
                        { attemptNumber: 6, statusCode: 500, statusText: 'Internal Server Error', success: false, timestamp: '14:24:03' },
                        { attemptNumber: 7, statusCode: 500, statusText: 'Internal Server Error', success: false, timestamp: '14:24:07' },
                        { attemptNumber: 8, statusCode: 200, statusText: 'OK', success: true, timestamp: '14:24:15' }
                    ]
                };
                break;

            case 'connection-failures':
                request.retryInfo = {
                    strategyName: 'RetryWithBackoff',
                    maxAttempts: 3,
                    actualAttempts: 3,
                    backoffType: 'Linear',
                    wasRetried: true,
                    attempts: [
                        { attemptNumber: 1, errorMessage: 'Connection refused', success: false, timestamp: '14:25:01' },
                        { attemptNumber: 2, errorMessage: 'Connection timeout', success: false, timestamp: '14:25:06' },
                        { attemptNumber: 3, errorMessage: 'Connection refused', success: false, timestamp: '14:25:11' }
                    ]
                };
                break;

            case 'success-first':
                request.retryInfo = {
                    strategyName: 'RetryWithBackoff',
                    maxAttempts: 5,
                    actualAttempts: 1,
                    backoffType: 'Exponential',
                    wasRetried: false,
                    attempts: [
                        { attemptNumber: 1, statusCode: 200, statusText: 'OK', success: true, timestamp: '14:26:01' }
                    ]
                };
                break;
        }
    }
}
