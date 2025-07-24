import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { HttpTestResult } from './HttpRequestTypes';

/**
 * Parses XML test reports from TeaPie execution
 */
export class XmlTestParser {
    private static outputChannel: vscode.OutputChannel;

    static setOutputChannel(channel: vscode.OutputChannel) {
        this.outputChannel = channel;
    }

    static async parseTestResultsFromXml(workspacePath: string, filePath: string): Promise<Map<string, HttpTestResult[]>> {
        const testResults = new Map<string, HttpTestResult[]>();
        
        try {
            // Look for the most recent test report file
            const reportsDir = `${workspacePath}/.teapie/reports`;
            
            let reportPath: string;
            try {
                // First try the expected last-run-report.xml
                reportPath = `${reportsDir}/last-run-report.xml`;
                await fs.access(reportPath);
                this.outputChannel?.appendLine(`[XmlTestParser] Found last-run-report.xml`);
            } catch {
                // If not found, look for the most recent timestamped report
                try {
                    const files = await fs.readdir(reportsDir);
                    const reportFiles = files.filter((f: string) => f.startsWith('run-') && f.endsWith('-report.xml'));
                    
                    if (reportFiles.length === 0) {
                        this.outputChannel?.appendLine(`[XmlTestParser] No test report files found in ${reportsDir}`);
                        return testResults;
                    }
                    
                    // Sort by timestamp (newest first) and take the most recent
                    reportFiles.sort((a: string, b: string) => {
                        const timestampA = parseInt(a.match(/run-(\d+)-report\.xml/)?.[1] || '0');
                        const timestampB = parseInt(b.match(/run-(\d+)-report\.xml/)?.[1] || '0');
                        return timestampB - timestampA;
                    });
                    
                    reportPath = `${reportsDir}/${reportFiles[0]}`;
                    this.outputChannel?.appendLine(`[XmlTestParser] Using most recent report: ${reportFiles[0]}`);
                } catch (dirError) {
                    this.outputChannel?.appendLine(`[XmlTestParser] Failed to read reports directory: ${dirError}`);
                    return testResults;
                }
            }
            
            const xmlContent = await fs.readFile(reportPath, 'utf8');
            this.outputChannel?.appendLine(`[XmlTestParser] Successfully read XML report file: ${reportPath}`);
            
            const testSuiteRegex = /<testsuite[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/testsuite>/gs;
            const testCaseRegex = /<testcase[^>]*?name="([^"]*?)"[^>]*?(?:\s*\/\s*>|>([\s\S]*?)<\/testcase>)/g;
            const failureRegex = /<failure[^>]*message="([^"]*)"[^>]*(?:type="([^"]*)")?[^>]*>([\s\S]*?)<\/failure>/s;
            
            // Get all HTTP requests from the file
            const allTestsByRequest = new Map<string, HttpTestResult[]>();
            
            let testSuiteMatch;
            while ((testSuiteMatch = testSuiteRegex.exec(xmlContent)) !== null) {
                const suiteName = this.decodeXmlEntities(testSuiteMatch[1]);
                const suiteContent = testSuiteMatch[2];
                const allTests: HttpTestResult[] = [];
                
                let testCaseMatch;
                testCaseRegex.lastIndex = 0;
                while ((testCaseMatch = testCaseRegex.exec(suiteContent)) !== null) {
                    const testName = this.decodeXmlEntities(testCaseMatch[1]);
                    const testContent = testCaseMatch[2] || '';
                    
                    let passed = true;
                    let message: string | undefined = undefined;
                    
                    const failureMatch = failureRegex.exec(testContent);
                    if (failureMatch) {
                        passed = false;
                        message = this.decodeXmlEntities(failureMatch[1]);
                    }
                    
                    const testResult: HttpTestResult = {
                        Name: testName,
                        Passed: passed,
                        Message: message
                    };
                    
                    allTests.push(testResult);
                }
                
                if (allTests.length) {
                    if (suiteName.includes('Custom CSX Tests')) {
                        // Group all custom CSX tests under a special key
                        const existingCustomTests = allTestsByRequest.get('_CUSTOM_CSX_TESTS') || [];
                        allTestsByRequest.set('_CUSTOM_CSX_TESTS', [...existingCustomTests, ...allTests]);
                    } else {
                        // Distribute tests based on test directive counts in the HTTP file
                        const httpFileRequests = await import('./HttpFileParser').then(m => m.HttpFileParser.parseHttpFileForNames(filePath));
                        
                        if (httpFileRequests.some(req => req.hasTestDirectives)) {
                            // Calculate total expected inline tests (excluding custom CSX tests)
                            const totalInlineTests = httpFileRequests.reduce((sum, req) => sum + (req.testDirectiveCount || 0), 0);
                            
                            // Use order-based approach: inline tests come first, then CSX tests
                            const inlineTests = allTests.slice(0, totalInlineTests);
                            const csxTests = allTests.slice(totalInlineTests);
                            
                            // Distribute inline tests to their corresponding requests
                            let testIndex = 0;
                            for (const req of httpFileRequests) {
                                if (req.testDirectiveCount && req.testDirectiveCount > 0) {
                                    const requestName = req.name || req.title || `${req.method} ${req.url}`;
                                    const requestTests = inlineTests.slice(testIndex, testIndex + req.testDirectiveCount);
                                    if (requestTests.length) {
                                        allTestsByRequest.set(requestName, requestTests);
                                    }
                                    testIndex += req.testDirectiveCount;
                                }
                            }
                            
                            // Any remaining CSX tests go to the special group
                            if (csxTests.length) {
                                const existingCustomTests = allTestsByRequest.get('_CUSTOM_CSX_TESTS') || [];
                                allTestsByRequest.set('_CUSTOM_CSX_TESTS', [...existingCustomTests, ...csxTests]);
                            }
                        } else {
                            // Fallback: if no request has test directives, treat all tests as custom tests
                            const existingCustomTests = allTestsByRequest.get('_CUSTOM_CSX_TESTS') || [];
                            allTestsByRequest.set('_CUSTOM_CSX_TESTS', [...existingCustomTests, ...allTests]);
                        }
                        
                        // Also store under suite name for fallback
                        testResults.set(suiteName, allTests);
                    }
                }
            }
            
            // Store results in the main testResults map
            for (const [requestName, tests] of allTestsByRequest.entries()) {
                testResults.set(requestName, tests);
            }
            
        } catch (error) {
            this.outputChannel?.appendLine(`Warning: Could not parse test results from XML: ${error}`);
        }
        
        return testResults;
    }

    /**
     * Decodes XML entities in strings
     */
    private static decodeXmlEntities(str: string): string {
        return str
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
    }

    /**
     * Waits for XML report file to be updated
     */
    static async waitForXmlReportUpdate(reportPath: string, beforeTimestamp: number): Promise<void> {
        const maxWaitTime = 10000; // 10 seconds maximum wait
        const pollInterval = 100; // Check every 100ms 
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitTime) {
            try {
                const stats = await fs.stat(reportPath);
                const currentTimestamp = stats.mtime.getTime();
                
                if (currentTimestamp > beforeTimestamp) {
                    // Give it a small extra delay to ensure the file is completely written
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return;
                }
            } catch {
                // File access failed (doesn't exist yet), continue polling
            }
            
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
        
        this.outputChannel?.appendLine(`Warning: XML report file was not updated within ${maxWaitTime}ms. This might indicate an issue with TeaPie test execution.`);
    }
}
