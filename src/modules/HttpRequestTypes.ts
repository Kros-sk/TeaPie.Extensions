/**
 * Type definitions for HTTP request processing
 */

export interface CliParseResult {
    requests: InternalRequest[];
    connectionError: string | null;
    foundHttpRequest: boolean;
}

export interface HttpRequestResults {
    RequestGroups: {
        RequestGroup: HttpRequestGroup[];
    };
}

export interface HttpRequestGroup {
    Name: string;
    FilePath: string;
    Requests: HttpRequestResult[];
    Status: string;
    Duration: string;
}

export interface HttpTestResult {
    Name: string;
    Passed: boolean;
    Message?: string;
}

export interface InternalRequest {
    method: string;
    url: string;
    requestHeaders: { [key: string]: string };
    responseHeaders: { [key: string]: string };
    uniqueKey?: string;
    title?: string | null;
    name?: string | null;
    templateUrl?: string | null;
    requestBody?: string;
    responseStatus?: number;
    responseStatusText?: string;
    responseBody?: string;
    duration?: string;
    ErrorMessage?: string;
}

export interface HttpRequestResult {
    Name: string;
    Status: string;
    Duration: string;
    Request?: {
        Method: string;
        Url: string;
        TemplateUrl?: string;
        Headers: { [key: string]: string };
        Body?: string;
    };
    Response?: {
        StatusCode: number;
        StatusText: string;
        Headers: { [key: string]: string };
        Body?: string;
        Duration: string;
    };
    ErrorMessage?: string;
    Tests?: HttpTestResult[];
}

export interface HttpFileRequest {
    name?: string;
    title?: string;
    method: string;
    url: string;
    templateUrl?: string;
    requestBody?: string;
    hasTestDirectives?: boolean;
    testDirectiveCount?: number;
}
