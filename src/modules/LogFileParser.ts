import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { 
    InternalRequest, 
    CliParseResult, 
    HttpFileRequest,
    HttpRequestResults,
    HttpRequestResult,
    HttpTestResult
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
            
            const httpFileRequests = await HttpFileParser.parseHttpFileForNames(httpFilePath);
            this.outputChannel?.appendLine(`[LogFileParser] Expected ${httpFileRequests.length} requests from HTTP file`);
            
            // Log the expected requests from HTTP file for debugging
            httpFileRequests.forEach((req, index) => {
                this.outputChannel?.appendLine(`[LogFileParser] HTTP File Request ${index}: ${req.method} ${req.url} (name: ${req.name})`);
            });
            
            // Track processed requests to avoid duplicates
            let processedRequestCount = 0;
            const maxRequests = httpFileRequests.length;
            const processedUrls = new Set<string>();

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Skip empty lines
                if (!line) continue;

                // Stop processing if we've found all expected requests and they match
                if (processedRequestCount >= maxRequests && maxRequests > 0) {
                    break;
                }

                // Look for HTTP request start indicators in log
                if (this.isLogRequestStartLine(line)) {
                    foundHttpRequest = true;
                    
                    // Extract method and URL to check for duplicates
                    const methodMatch = line.match(/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^\s]+)/);
                    if (methodMatch) {
                        const requestId = `${methodMatch[1]}_${methodMatch[2]}`;
                        
                        // Skip if we've already processed this exact request
                        if (processedUrls.has(requestId)) {
                            this.outputChannel?.appendLine(`[LogFileParser] Skipped duplicate request: ${requestId}`);
                            continue;
                        }
                        
                        processedUrls.add(requestId);
                    }
                    
                    const processed = this.processLogRequestStart(
                        line,
                        pendingRequests,
                        httpFileRequests,
                        processedRequestCount,
                        processedRequestCount
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
               line.includes('Request content:');
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

    private static isLogResponseBodyLine(line: string): boolean {
        // Look for response body indicators in logs - be more flexible
        return line.includes('Response Body:') || 
               line.includes('Response content:') ||
               line.includes('Body content:') ||
               line.includes('Response data:') ||
               line.includes('Body:') ||
               // Sometimes body comes right after status without explicit marker
               (line.trim().startsWith('{') && line.includes('"')) ||
               (line.trim().startsWith('[') && line.includes('"'));
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

    private static processLogRequestStart(
        line: string,
        pendingRequests: Map<string, InternalRequest>,
        httpFileRequests: HttpFileRequest[],
        httpFileRequestIdx: number,
        requestCounter: number
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
            templateUrl: httpFileRequest?.templateUrl || null
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
        
        // Find the most recent pending request to assign body to
        const requests = Array.from(pendingRequests.values());
        if (requests.length > 0) {
            const lastRequest = requests[requests.length - 1];
            lastRequest.requestBody = body;
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Added request body to request`);
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
                
                // Check if there's duration info in the same line or nearby
                const durationMatch = line.match(/([\d.]+)ms/);
                if (durationMatch) {
                    const duration = parseFloat(durationMatch[1]);
                    const requests = Array.from(pendingRequests.values());
                    if (requests.length > 0) {
                        const lastRequest = requests[requests.length - 1];
                        lastRequest.duration = `${Math.round(duration)}ms`;
                        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Extracted duration from TeaPie pattern: ${lastRequest.duration}`);
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
                
                // Also extract duration from this line
                const durationMatch = line.match(/after\s+([\d.]+)ms/);
                if (durationMatch) {
                    const duration = parseFloat(durationMatch[1]);
                    // Round to reasonable precision and assign to the most recent request
                    const requests = Array.from(pendingRequests.values());
                    if (requests.length > 0) {
                        const lastRequest = requests[requests.length - 1];
                        lastRequest.duration = `${Math.round(duration)}ms`;
                        LogFileParser.outputChannel?.appendLine(`[LogFileParser] Extracted duration: ${lastRequest.duration}`);
                    }
                }
            }
        }
        
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
        
        // Find the most recent pending request to assign response to
        const requests = Array.from(pendingRequests.values());
        if (requests.length > 0) {
            const lastRequest = requests[requests.length - 1];
            lastRequest.responseStatus = statusCode;
            lastRequest.responseStatusText = statusText || this.getDefaultStatusText(statusCode);
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Added response status: ${statusCode} ${lastRequest.responseStatusText} to request ${lastRequest.name}`);
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
        
        // Find the most recent pending request to assign body to
        const requests = Array.from(pendingRequests.values());
        if (requests.length > 0) {
            const lastRequest = requests[requests.length - 1];
            lastRequest.responseBody = body;
            LogFileParser.outputChannel?.appendLine(`[LogFileParser] Added response body to request`);
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
        
        return bodyLines.join('\n').trim();
    }

    private static hasLogTimestamp(line: string): boolean {
        // Check if line starts with timestamp pattern common in logs
        // Example patterns: [2024-01-01 10:00:00], 2024-01-01T10:00:00, etc.
        return /^\[?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}/.test(line) ||
               /^\d{2}:\d{2}:\d{2}/.test(line) ||
               line.includes('trce:') || line.includes('dbug:') || 
               line.includes('info:') || line.includes('warn:') || 
               line.includes('fail:') || line.includes('crit:');
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
                Tests: testResults
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
}
