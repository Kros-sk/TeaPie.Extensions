import { 
    InternalRequest, 
    CliParseResult, 
    HttpFileRequest, 
    HttpRequestResults, 
    HttpRequestResult, 
    HttpTestResult 
} from './HttpRequestTypes';
import { 
    CLI_PATTERNS, 
    CONTENT_PATTERNS, 
    ERROR_PATTERNS, 
    LOG_PATTERNS, 
    isTimeoutError, 
    hasLogTimestamp, 
    extractUrlFromError 
} from '../constants/cliPatterns';
import { HttpFileParser } from './HttpFileParser';
import { STATUS_PASSED, STATUS_FAILED, ERROR_HTTP_FAILED } from '../constants/httpResults';

/**
 * Parses TeaPie CLI output to extract HTTP request/response data
 */
export class CliOutputParser {

    static async parseCliOutput(stdout: string, filePath: string): Promise<CliParseResult> {
        const lines = stdout.split('\n');
        const requests: InternalRequest[] = [];
        const pendingRequests: Map<string, InternalRequest> = new Map();
        
        let connectionError: string | null = null;
        let requestCounter = 0;
        let isNextRequestRetry = false;
        let foundHttpRequest = false;
        
        const httpFileRequests = await HttpFileParser.parseHttpFileForNames(filePath);
        let httpFileRequestIdx = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (this.isRequestStartLine(line)) {
                // Skip authentication token requests completely
                if (line.includes('/auth/token') || line.includes('/token')) {
                    continue;
                }
                
                foundHttpRequest = true;
                this.processRequestStart(
                    line,
                    pendingRequests,
                    httpFileRequests,
                    httpFileRequestIdx,
                    requestCounter,
                    isNextRequestRetry
                );
                
                // Only increment the HTTP file request index for non-retry requests
                if (!isNextRequestRetry) {
                    httpFileRequestIdx++;
                }
                if (isNextRequestRetry) {
                    isNextRequestRetry = false;
                }
                requestCounter++;
            } else if (this.isRetryLine(line)) {
                isNextRequestRetry = true;
            } else if (this.isConnectionErrorLine(line)) {
                connectionError = this.extractConnectionError(line, lines, i);
            } else if (this.isRequestBodyLine(line)) {
                // Skip CLI body parsing - we get bodies directly from HTTP file
                continue;
            } else if (this.isResponseLine(line)) {
                this.processResponse(line, pendingRequests);
            } else if (this.isResponseBodyLine(line)) {
                this.processResponseBody(line, lines, i, pendingRequests);
            } else if (this.isRequestEndLine(line)) {
                this.processRequestEnd(line, pendingRequests, requests);
            }
        }

        return {
            requests,
            connectionError,
            foundHttpRequest
        };
    }

    private static isRequestStartLine(line: string): boolean {
        return CLI_PATTERNS.REQUEST_START.test(line);
    }

    private static isRetryLine(line: string): boolean {
        return line.includes(CLI_PATTERNS.RETRY_ATTEMPT);
    }

    private static isConnectionErrorLine(line: string): boolean {
        return line.includes(ERROR_PATTERNS.CONNECTION_REFUSED) ||
               (line.includes('[') && line.includes(LOG_PATTERNS.ERROR_LEVEL) && line.includes(ERROR_PATTERNS.EXECUTION_ERROR));
    }

    private static isRequestBodyLine(line: string): boolean {
        return line.includes(CONTENT_PATTERNS.REQUEST_BODY);
    }

    private static isResponseLine(line: string): boolean {
        return CONTENT_PATTERNS.RESPONSE.test(line);
    }

    private static isResponseBodyLine(line: string): boolean {
        return line.includes(CONTENT_PATTERNS.RESPONSE_BODY);
    }

    private static isRequestEndLine(line: string): boolean {
        return CLI_PATTERNS.REQUEST_END.test(line);
    }

    private static processRequestStart(
        line: string,
        pendingRequests: Map<string, InternalRequest>,
        httpFileRequests: HttpFileRequest[],
        httpFileRequestIdx: number,
        requestCounter: number,
        isNextRequestRetry: boolean
    ): void {
        const startMatch = line.match(CLI_PATTERNS.REQUEST_START_EXTRACT);
        if (!startMatch) return;

        const method = startMatch[1];
        const url = startMatch[2];
        let name: string | null = null;
        let title: string | null = null;
        let templateUrl: string | null = null;
        let requestBody: string | null = null;

        // Get request info from HTTP file for non-retry requests
        if (!isNextRequestRetry && httpFileRequestIdx < httpFileRequests.length) {
            const reqInfo = httpFileRequests[httpFileRequestIdx];
            name = reqInfo.name || null;
            title = reqInfo.title || null;
            templateUrl = reqInfo.templateUrl || null;
            requestBody = reqInfo.requestBody || null; // Get the body directly from HTTP file
        }

        if (isNextRequestRetry) {
            // For retries, find the original request with the same method and URL
            for (const [key, req] of pendingRequests.entries()) {
                if (req.method === method && req.url === url) {
                    // Found the original request, don't create a new one for retries
                    return;
                }
            }
            // Original request already completed, don't create a new entry
            return;
        } else {
            // This is a new request (not a retry)
            const requestKey = `req_${requestCounter + 1}_${method}_${url}`;
            
            pendingRequests.set(requestKey, {
                method, 
                url, 
                requestHeaders: {}, 
                responseHeaders: {}, 
                uniqueKey: requestKey, 
                title, 
                name, 
                templateUrl,
                requestBody: requestBody || undefined
            });
        }
    }

    private static extractConnectionError(line: string, lines: string[], currentIndex: number): string {
        if (line.includes(ERROR_PATTERNS.CONNECTION_REFUSED)) {
            const url = extractUrlFromError(line) || 'unknown host';
            return `Connection refused to ${url} - please ensure the server is running and accessible`;
        }

        if (line.includes('[') && line.includes(LOG_PATTERNS.ERROR_LEVEL) && line.includes(ERROR_PATTERNS.EXECUTION_ERROR)) {
            for (let j = currentIndex + 1; j < Math.min(currentIndex + 5, lines.length); j++) {
                const errorLine = lines[j].trim();
                if (errorLine.includes(ERROR_PATTERNS.CONNECTION_REFUSED)) {
                    const url = extractUrlFromError(errorLine) || 'unknown host';
                    return `Connection refused to ${url} - please ensure the server is running and accessible`;
                } else if (errorLine.includes(ERROR_PATTERNS.DNS_ERROR)) {
                    return 'Host not found - please check the URL in your HTTP request';
                } else if (isTimeoutError(errorLine)) {
                    return 'Request timed out - server may be unresponsive';
                }
            }
            return 'HTTP request execution failed';
        }

        return 'Unknown connection error';
    }

    private static processResponse(line: string, pendingRequests: Map<string, InternalRequest>): void {
        const responseMatch = line.match(CONTENT_PATTERNS.RESPONSE);
        if (!responseMatch) return;

        const statusCode = parseInt(responseMatch[1]);
        const statusText = responseMatch[2];
        const responseUrl = responseMatch[3];

        for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
            if (request.url === responseUrl && !request.responseStatus) {
                request.responseStatus = statusCode;
                request.responseStatusText = statusText;
                break;
            }
        }
    }

    private static processResponseBody(
        line: string,
        lines: string[],
        currentIndex: number,
        pendingRequests: Map<string, InternalRequest>
    ): void {
        const responseBody = this.extractBody(lines, currentIndex);
        
        for (let j = currentIndex - 1; j >= 0; j--) {
            const backLine = lines[j].trim();
            const backResponseMatch = backLine.match(CONTENT_PATTERNS.RESPONSE);
            if (backResponseMatch) {
                const responseUrl = backResponseMatch[3];
                const responseStatus = parseInt(backResponseMatch[1]);
                
                for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                    if (request.url === responseUrl && 
                        request.responseStatus === responseStatus && 
                        !request.responseBody) {
                        request.responseBody = responseBody;
                        return;
                    }
                }
            }
        }
    }

    private static processRequestEnd(
        line: string,
        pendingRequests: Map<string, InternalRequest>,
        requests: InternalRequest[]
    ): void {
        const endMatch = line.match(CLI_PATTERNS.REQUEST_END);
        if (!endMatch) return;

        const statusCode = parseInt(endMatch[2]);
        const duration = endMatch[1] + 'ms';
        let foundRequest = null;
        let foundKey = null;

        // Find the most recent request with this status code that doesn't have a duration yet
        for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
            if (request.responseStatus === statusCode && !request.duration) {
                foundRequest = request;
                foundKey = key;
                break;
            }
        }

        // If we didn't find by status code, find the most recent request without duration
        if (!foundRequest) {
            for (const [key, request] of Array.from(pendingRequests.entries()).reverse()) {
                if (!request.duration) {
                    foundRequest = request;
                    foundKey = key;
                    foundRequest.responseStatus = statusCode;
                    break;
                }
            }
        }

        if (foundRequest && foundKey) {
            foundRequest.duration = duration;
            
            // Always move completed requests to the final requests array
            // Retries will update the same request object
            requests.push(foundRequest);
            pendingRequests.delete(foundKey);
        }
    }

    private static extractBody(lines: string[], startIndex: number): string {
        const bodyLines: string[] = [];
        let i = startIndex + 1;
        
        while (i < lines.length) {
            const line = lines[i];
            if (hasLogTimestamp(line) || 
                line.includes(LOG_PATTERNS.INFO_SENDING) || 
                line.includes(LOG_PATTERNS.INFO_END)) {
                break;
            }
            bodyLines.push(line);
            i++;
        }
        
        return bodyLines.join('\n').trim();
    }

    /**
     * Builds final HTTP request results by combining CLI data with test results
     */
    public static buildHttpRequestResults(
        fileName: string,
        filePath: string,
        cliResult: CliParseResult,
        testResultsFromXml: Map<string, HttpTestResult[]>
    ): HttpRequestResults {
        const requests: HttpRequestResult[] = [];
        
        // Check if any HTTP requests were found
        if (!cliResult.foundHttpRequest) {
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
        if (cliResult.connectionError && cliResult.requests.length === 0) {
            return {
                RequestGroups: {
                    RequestGroup: [{
                        Name: fileName,
                        FilePath: filePath,
                        Requests: [{
                            Name: ERROR_HTTP_FAILED,
                            Status: STATUS_FAILED,
                            Duration: '0ms',
                            ErrorMessage: cliResult.connectionError
                        }],
                        Status: STATUS_FAILED,
                        Duration: '0s'
                    }]
                }
            };
        }
        
        cliResult.requests.forEach((internalRequest, index) => {
            const testResults = testResultsFromXml.get(internalRequest.name || `Request ${index + 1}`) || [];
            
            requests.push({
                Name: internalRequest.name || `Request ${index + 1}`,
                Status: internalRequest.responseStatus && internalRequest.responseStatus >= 200 && internalRequest.responseStatus < 400 ? STATUS_PASSED : STATUS_FAILED,
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
