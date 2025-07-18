/**
 * Constants for parsing TeaPie CLI output
 */

export const CLI_PATTERNS = {
    REQUEST_START: /Start processing HTTP request/,
    REQUEST_START_EXTRACT: /Start processing HTTP request (\w+)\s+(.+)/,
    RETRY_ATTEMPT: 'DBG] Retry attempt number',
    REQUEST_END: /End processing HTTP request after ([\d.]+)ms - (\d+)/,
} as const;

export const CONTENT_PATTERNS = {
    REQUEST_BODY: "Following HTTP request's body",
    RESPONSE: /HTTP Response (\d+) \(([^)]+)\) was received from '([^']+)'/,
    RESPONSE_BODY: "Response's body",
    HTTP_METHOD_URL: /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+http/
} as const;

export const ERROR_PATTERNS = {
    CONNECTION_REFUSED: 'No connection could be made because the target machine actively refused it',
    EXECUTION_ERROR: 'Exception was thrown during execution',
    DNS_ERROR: 'getaddrinfo',
    TIMEOUT: ['timeout', 'timed out'],
} as const;

export const LOG_PATTERNS = {
    TIMESTAMP: /^\[[\d:]+\s+\w+\]/,
    INFO_SENDING: 'INF] Sending HTTP request',
    INFO_END: 'INF] End processing',
    ERROR_LEVEL: 'ERR]',
} as const;

export const URL_PATTERNS = {
    URL_IN_PARENTHESES: /\(([^)]+)\)/,
} as const;

export function isTimeoutError(text: string): boolean {
    return ERROR_PATTERNS.TIMEOUT.some(pattern => text.includes(pattern));
}

export function hasLogTimestamp(line: string): boolean {
    return LOG_PATTERNS.TIMESTAMP.test(line.trim());
}

export function extractUrlFromError(text: string): string | null {
    const match = text.match(URL_PATTERNS.URL_IN_PARENTHESES);
    return match ? match[1] : null;
}

export const ERROR_CONNECTION_REFUSED = 'Connection refused - please ensure the server is running and accessible';
export const ERROR_HOST_NOT_FOUND = 'Host not found - please check the URL in your HTTP request';
export const ERROR_TIMEOUT = 'Request timed out - server may be unresponsive';
export const ERROR_EXECUTION_FAILED = 'HTTP request execution failed';
export const ERROR_NO_HTTP_FOUND = 'No HTTP requests found in the file';
