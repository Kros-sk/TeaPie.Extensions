import * as fs from 'fs/promises';
import { HttpFileRequest } from './HttpRequestTypes';

/**
 * Parses HTTP files to extract request metadata
 */
export class HttpFileParser {
    
    static async parseHttpFileForNames(filePath: string): Promise<HttpFileRequest[]> {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const result: HttpFileRequest[] = [];
        let lastName: string | undefined = undefined;
        let lastTitle: string | undefined = undefined;
        let testDirectiveCount = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Check for test directives
            if (line.match(/^##\s*TEST-/)) {
                testDirectiveCount++;
                continue;
            }
            
            const nameMatch = line.match(/^#\s*@name\s+(.+)/);
            if (nameMatch) {
                lastName = nameMatch[1].trim();
                continue;
            }
            
            const titleMatch = line.match(/^###\s+(.+)/);
            if (titleMatch) {
                lastTitle = titleMatch[1].trim();
                continue;
            }
            
            const methodMatch = line.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(.+)/i);
            if (methodMatch) {
                const templateUrl = methodMatch[2].trim();
                
                // Extract request body for POST/PUT/PATCH requests
                let requestBody: string | undefined = undefined;
                const method = methodMatch[1].toUpperCase();
                
                if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
                    requestBody = this.extractRequestBodyFromLines(lines, i);
                }
                
                result.push({
                    name: lastName,
                    title: lastTitle,
                    method: method,
                    url: templateUrl,
                    templateUrl: templateUrl,
                    requestBody: requestBody,
                    hasTestDirectives: testDirectiveCount > 0,
                    testDirectiveCount: testDirectiveCount
                });
                lastName = undefined;
                lastTitle = undefined;
                testDirectiveCount = 0;
            }
        }
        return result;
    }
    
    /**
     * Extracts the request body from lines starting after the HTTP method line
     */
    private static extractRequestBodyFromLines(lines: string[], methodLineIndex: number): string | undefined {
        let bodyLines: string[] = [];
        let foundEmptyLine = false;
        let inBody = false;
        
        // Start looking after the method line
        for (let i = methodLineIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            
            // Stop at next request (starts with ### or HTTP method)
            if (line.trim().startsWith('###') || 
                line.trim().match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+/i)) {
                break;
            }
            
            // Headers section - look for empty line that signals start of body
            if (!inBody) {
                if (line.trim() === '') {
                    foundEmptyLine = true;
                    continue;
                }
                
                // If we found empty line and now have content, this is the body
                if (foundEmptyLine && line.trim() !== '') {
                    inBody = true;
                    bodyLines.push(line);
                }
                continue;
            }
            
            // We're in the body section - collect lines until we hit a comment or new section
            if (inBody) {
                if (line.trim().startsWith('//') || line.trim().startsWith('#')) {
                    // Skip comments but don't stop collecting body
                    continue;
                }
                bodyLines.push(line);
            }
        }
        
        const body = bodyLines.join('\n').trim();
        return body || undefined;
    }
}
