/**
 * Constants for parsing TeaPie CLI output
 * 
 * WARNING: These patterns are tightly coupled to TeaPie's CLI output format.
 * If TeaPie changes their logging format, these patterns will need to be updated.
 * 
 * Last verified with TeaPie version: [UPDATE_WITH_TEAPIE_VERSION]
 */

// =================== Request Lifecycle Patterns ===================

export const CLI_PATTERNS = {
    /** Detects the start of HTTP request processing */
    REQUEST_START: /Start processing HTTP request/,
    
    /** Extracts method and URL from request start line */
    REQUEST_START_EXTRACT: /Start processing HTTP request (\w+)\s+(.+)/,
    
    /** Detects retry attempts */
    RETRY_ATTEMPT: 'DBG] Retry attempt number',
    
    /** Detects the end of HTTP request processing with timing */
    REQUEST_END: /End processing HTTP request after ([\d.]+)ms - (\d+)/,
} as const;

// =================== Request/Response Content Patterns ===================

export const CONTENT_PATTERNS = {
    /** Detects HTTP request body section */
    REQUEST_BODY: "Following HTTP request's body",
    
    /** Detects HTTP response section */
    RESPONSE: /HTTP Response (\d+) \(([^)]+)\) was received from '([^']+)'/,
    
    /** Detects HTTP response body section */
    RESPONSE_BODY: "Response's body",
    
    /** Detects if a request name is just method + URL vs custom title */
    HTTP_METHOD_URL: /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+http/
} as const;

// =================== Error Detection Patterns ===================

export const ERROR_PATTERNS = {
    /** Detects connection refused errors */
    CONNECTION_REFUSED: 'No connection could be made because the target machine actively refused it',
    
    /** Detects general execution errors */
    EXECUTION_ERROR: 'Exception was thrown during execution',
    
    /** Detects DNS resolution errors */
    DNS_ERROR: 'getaddrinfo',
    
    /** Detects timeout errors */
    TIMEOUT: ['timeout', 'timed out'],
} as const;

// =================== Log Format Patterns ===================

export const LOG_PATTERNS = {
    /** Detects timestamped log entries */
    TIMESTAMP: /^\[[\d:]+\s+\w+\]/,
    
    /** Detects INFO level logs */
    INFO_SENDING: 'INF] Sending HTTP request',
    
    /** Detects INFO level end processing */
    INFO_END: 'INF] End processing',
    
    /** Detects ERROR level logs */
    ERROR_LEVEL: 'ERR]',
} as const;

// =================== URL Extraction Patterns ===================

export const URL_PATTERNS = {
    /** Extracts URL from parentheses in error messages */
    URL_IN_PARENTHESES: /\(([^)]+)\)/,
} as const;

// =================== Helper Functions ===================

/**
 * Checks if a string contains any of the timeout indicators
 */
export function isTimeoutError(text: string): boolean {
    return ERROR_PATTERNS.TIMEOUT.some(pattern => text.includes(pattern));
}

/**
 * Checks if a line matches the log timestamp format
 */
export function hasLogTimestamp(line: string): boolean {
    return LOG_PATTERNS.TIMESTAMP.test(line.trim());
}

/**
 * Extracts URL from error message parentheses
 */
export function extractUrlFromError(text: string): string | null {
    const match = text.match(URL_PATTERNS.URL_IN_PARENTHESES);
    return match ? match[1] : null;
}
