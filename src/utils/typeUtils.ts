/**
 * Type guards and utility functions for better type safety
 */

import { HttpRequestResult } from '../modules/HttpRequestTypes';

// Type guards
export function isHttpRequestResult(obj: any): obj is HttpRequestResult {
    return obj && 
           typeof obj.Name === 'string' && 
           typeof obj.Status === 'string' && 
           typeof obj.Duration === 'string';
}

export function hasResponse(request: HttpRequestResult): request is HttpRequestResult & { Response: NonNullable<HttpRequestResult['Response']> } {
    return request.Response !== undefined && request.Response !== null;
}

export function hasRequest(request: HttpRequestResult): request is HttpRequestResult & { Request: NonNullable<HttpRequestResult['Request']> } {
    return request.Request !== undefined && request.Request !== null;
}

export function hasRetryInfo(request: HttpRequestResult): request is HttpRequestResult & { RetryInfo: NonNullable<HttpRequestResult['RetryInfo']> } {
    return request.RetryInfo !== undefined && request.RetryInfo !== null;
}

export function hasTests(request: HttpRequestResult): request is HttpRequestResult & { Tests: NonNullable<HttpRequestResult['Tests']> } {
    return request.Tests !== undefined && request.Tests !== null && request.Tests.length > 0;
}

// Utility functions
export function safeParseJson(jsonString: string): unknown | null {
    try {
        return JSON.parse(jsonString);
    } catch {
        return null;
    }
}

export function safeStringify(obj: unknown, indent = 0): string {
    try {
        return JSON.stringify(obj, null, indent);
    } catch {
        return String(obj);
    }
}

export function sanitizeHtml(input: string): string {
    if (!input) return '';
    return input.replace(/[&<>"'`]/g, (match) => {
        const escapeMap: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
            '`': '&#96;'
        };
        return escapeMap[match] || match;
    });
}

export function formatDuration(durationStr: string): string {
    if (!durationStr) return '0ms';
    
    // Handle various duration formats
    const match = durationStr.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
    if (!match) return durationStr;
    
    const [, value, unit] = match;
    const numValue = parseFloat(value);
    
    switch (unit) {
        case 'ms':
            return numValue < 1000 ? `${Math.round(numValue)}ms` : `${(numValue / 1000).toFixed(1)}s`;
        case 's':
            return numValue < 60 ? `${numValue}s` : `${Math.floor(numValue / 60)}m ${Math.round(numValue % 60)}s`;
        case 'm':
            return `${Math.floor(numValue)}m ${Math.round((numValue % 1) * 60)}s`;
        case 'h':
            return `${Math.floor(numValue)}h ${Math.floor((numValue % 1) * 60)}m`;
        default:
            return durationStr;
    }
}
