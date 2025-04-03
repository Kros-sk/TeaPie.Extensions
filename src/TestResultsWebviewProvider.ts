import * as path from 'path';
import * as vscode from 'vscode';

import { TestCase, TestSuite, TestSuites } from './TestResultsProvider';

export class TestResultsWebviewProvider {
    public static readonly viewType = 'teapie-extensions.testResults';

    private _view?: vscode.WebviewPanel;
    private _testResults: TestSuites | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public show(testResults: TestSuites) {
        this._testResults = testResults;

        if (this._view) {
            this._view.reveal(vscode.ViewColumn.One);
            this._updateWebview();
        } else {
            this._view = vscode.window.createWebviewPanel(
                TestResultsWebviewProvider.viewType,
                'Test Results',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [this._extensionUri]
                }
            );

            this._view.webview.html = this._getWebviewContent();

            this._view.onDidDispose(() => {
                this._view = undefined;
            });

            this._view.webview.onDidReceiveMessage(
                async message => {
                    switch (message.command) {
                        case 'showTestDetails':
                            this._showTestDetails(message.testCase);
                            break;
                    }
                },
                undefined,
                this._context.subscriptions
            );
        }
    }

    private _updateWebview() {
        if (this._view && this._testResults) {
            this._view.webview.postMessage({
                type: 'updateTestResults',
                testResults: this._testResults
            });
        }
    }

    private _showTestDetails(testCase: TestCase) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'showTestDetails',
                testCase: testCase
            });
        }
    }

    private _getWebviewContent() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Test Results</title>
            <style>
                body {
                    padding: 20px;
                    color: var(--vscode-editor-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .overview {
                    display: flex;
                    gap: 20px;
                    margin-bottom: 20px;
                }
                .stat-box {
                    padding: 15px;
                    border-radius: 5px;
                    text-align: center;
                    flex: 1;
                }
                .total { background-color: var(--vscode-editor-inactiveSelectionBackground); }
                .passed { background-color: var(--vscode-testing-iconPassed); }
                .failed { background-color: var(--vscode-testing-iconFailed); }
                .skipped { background-color: var(--vscode-testing-iconSkipped); }
                .test-details {
                    display: none;
                    margin-top: 20px;
                    padding: 15px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 5px;
                }
                .test-details.visible {
                    display: block;
                }
                .failure-message {
                    color: var(--vscode-testing-iconFailed);
                    white-space: pre-wrap;
                }
            </style>
        </head>
        <body>
            <div class="overview">
                <div class="stat-box total">
                    <h3>Total Tests</h3>
                    <div id="totalTests">0</div>
                </div>
                <div class="stat-box passed">
                    <h3>Passed</h3>
                    <div id="passedTests">0</div>
                </div>
                <div class="stat-box failed">
                    <h3>Failed</h3>
                    <div id="failedTests">0</div>
                </div>
                <div class="stat-box skipped">
                    <h3>Skipped</h3>
                    <div id="skippedTests">0</div>
                </div>
            </div>
            <div id="testDetails" class="test-details">
                <h3>Test Details</h3>
                <div id="testName"></div>
                <div id="testStatus"></div>
                <div id="failureMessage" class="failure-message"></div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'updateTestResults':
                            updateOverview(message.testResults);
                            break;
                        case 'showTestDetails':
                            showTestDetails(message.testCase);
                            break;
                    }
                });

                function updateOverview(testResults) {
                    document.getElementById('totalTests').textContent = testResults.tests;
                    document.getElementById('passedTests').textContent = testResults.tests - testResults.failures - testResults.skipped;
                    document.getElementById('failedTests').textContent = testResults.failures;
                    document.getElementById('skippedTests').textContent = testResults.skipped;
                }

                function showTestDetails(testCase) {
                    const details = document.getElementById('testDetails');
                    const name = document.getElementById('testName');
                    const status = document.getElementById('testStatus');
                    const failureMessage = document.getElementById('failureMessage');

                    name.textContent = testCase.name;
                    status.textContent = testCase.failure ? 'Failed' : testCase.skipped ? 'Skipped' : 'Passed';
                    failureMessage.textContent = testCase.failure ? testCase.failure.message : '';
                    
                    details.classList.add('visible');
                }
            </script>
        </body>
        </html>`;
    }

    public showTestDetails(item: { testCase?: TestCase; testSuite?: TestSuite }) {
        if (item.testCase) {
            this.showWebview('Test Case Details', this._getTestDetailsHtml(item.testCase));
        } else if (item.testSuite) {
            this.showWebview('Test Suite Details', this._getTestSuiteHtml(item.testSuite));
        }
    }

    public showSummary(testResults: TestSuites) {
        this.showWebview('Test Run Summary', this._getSummaryHtml(testResults));
    }

    private showWebview(title: string, content: string) {
        if (this._view) {
            this._view.title = title;
            this._view.webview.html = content;
            this._view.reveal();
        } else {
            this._view = vscode.window.createWebviewPanel(
                TestResultsWebviewProvider.viewType,
                title,
                vscode.ViewColumn.Two,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this._view.webview.html = content;

            this._view.onDidDispose(() => {
                this._view = undefined;
            });
        }
    }

    private _getTestDetailsHtml(testCase: TestCase): string {
        const status = testCase.failure ? 'Failed' : testCase.skipped !== undefined ? 'Skipped' : 'Passed';
        const statusClass = status.toLowerCase();

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body {
                    padding: 20px;
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                }
                .status {
                    padding: 5px 10px;
                    border-radius: 3px;
                    display: inline-block;
                    margin-bottom: 10px;
                }
                .passed { background-color: var(--vscode-testing-iconPassed); }
                .failed { background-color: var(--vscode-testing-iconFailed); }
                .skipped { background-color: var(--vscode-testing-iconSkipped); }
                .details {
                    margin-top: 20px;
                    padding: 15px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 5px;
                }
                .failure-message {
                    color: var(--vscode-testing-message-error-decorationForeground);
                    white-space: pre-wrap;
                    font-family: var(--vscode-editor-font-family);
                }
                .metadata {
                    margin-top: 10px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <h2>${testCase.name}</h2>
            <div class="status ${statusClass}">${status}</div>
            <div class="metadata">
                <div>Class: ${testCase.classname}</div>
                <div>Duration: ${Number(testCase.time).toFixed(2)}s</div>
            </div>
            ${testCase.failure ? `
                <div class="details">
                    <h3>Failure Details</h3>
                    <div class="failure-message">${testCase.failure.message}</div>
                    <div class="failure-message">${testCase.failure._}</div>
                </div>
            ` : ''}
        </body>
        </html>`;
    }

    private _getTestSuiteHtml(testSuite: TestSuite): string {
        const totalTests = Number(testSuite.tests);
        const failedTests = Number(testSuite.failures);
        const skippedTests = Number(testSuite.skipped);
        const passedTests = totalTests - failedTests - skippedTests;
        const duration = Number(testSuite.time).toFixed(2);

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body {
                    padding: 20px;
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                }
                .summary {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 15px;
                    margin-bottom: 30px;
                }
                .stat-box {
                    padding: 15px;
                    border-radius: 5px;
                    text-align: center;
                }
                .total { background-color: var(--vscode-editor-inactiveSelectionBackground); }
                .passed { background-color: var(--vscode-testing-iconPassed); }
                .failed { background-color: var(--vscode-testing-iconFailed); }
                .skipped { background-color: var(--vscode-testing-iconSkipped); }
                .test-list {
                    margin-top: 20px;
                }
                .test-item {
                    padding: 10px;
                    margin: 5px 0;
                    border-radius: 3px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                }
                .test-item.failed { border-left: 4px solid var(--vscode-testing-iconFailed); }
                .test-item.passed { border-left: 4px solid var(--vscode-testing-iconPassed); }
                .test-item.skipped { border-left: 4px solid var(--vscode-testing-iconSkipped); }
                .duration {
                    float: right;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <h2>${testSuite.name}</h2>
            <div class="metadata">
                <div>Duration: ${duration}s</div>
            </div>
            <div class="summary">
                <div class="stat-box total">
                    <h3>Total Tests</h3>
                    <div>${totalTests}</div>
                </div>
                <div class="stat-box passed">
                    <h3>Passed</h3>
                    <div>${passedTests}</div>
                </div>
                <div class="stat-box failed">
                    <h3>Failed</h3>
                    <div>${failedTests}</div>
                </div>
                <div class="stat-box skipped">
                    <h3>Skipped</h3>
                    <div>${skippedTests}</div>
                </div>
            </div>
            <div class="test-list">
                ${Array.isArray(testSuite.testcase) ? testSuite.testcase.map(testCase => `
                    <div class="test-item ${testCase.failure ? 'failed' : testCase.skipped ? 'skipped' : 'passed'}">
                        ${testCase.name}
                        <span class="duration">${Number(testCase.time).toFixed(2)}s</span>
                    </div>
                `).join('') : ''}
            </div>
        </body>
        </html>`;
    }

    private _getSummaryHtml(testResults: TestSuites): string {
        const totalTests = Number(testResults.tests);
        const failedTests = Number(testResults.failures);
        const skippedTests = Number(testResults.skipped);
        const passedTests = totalTests - failedTests - skippedTests;
        const duration = Number(testResults.time).toFixed(2);

        const suites = Array.isArray(testResults.testsuite) 
            ? testResults.testsuite 
            : [testResults.testsuite];

        return `<!DOCTYPE html>
        <html>
        <head>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            <style>
                body {
                    padding: 20px;
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    line-height: 1.6;
                }
                h2 {
                    margin-bottom: 30px;
                    font-size: 24px;
                }
                .metadata {
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 40px;
                    font-size: 14px;
                }
                .duration {
                    font-size: 20px;
                    font-weight: bold;
                    color: var(--vscode-testing-iconPassed);
                    margin-top: 15px;
                    display: block;
                }
                .summary {
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 20px;
                    margin: 40px 0;
                }
                .stat-box {
                    padding: 20px;
                    border-radius: 8px;
                    text-align: center;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    min-height: 100px;
                }
                .stat-box h3 {
                    margin: 0 0 10px 0;
                    font-size: 16px;
                }
                .stat-box div {
                    font-size: 24px;
                    font-weight: bold;
                }
                .total { 
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    color: var(--vscode-editor-foreground);
                }
                .passed { 
                    background-color: var(--vscode-testing-iconPassed);
                    color: var(--vscode-editor-background);
                }
                .failed { 
                    background-color: var(--vscode-testing-iconFailed);
                    color: white;
                }
                .skipped { 
                    background-color: var(--vscode-testing-iconSkipped);
                    color: white;
                }
                .chart-container {
                    margin: 40px 0;
                    height: 300px;
                }
                .suite {
                    margin: 15px 0;
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 8px;
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }
                .suite:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .suite-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .suite-header h4 {
                    margin: 0;
                    font-size: 16px;
                }
                .suite-metadata {
                    color: var(--vscode-descriptionForeground);
                    font-size: 13px;
                }
                .section-title {
                    margin: 40px 0 20px 0;
                    font-size: 18px;
                    font-weight: bold;
                }
            </style>
        </head>
        <body>
            <h2>Test Run Summary</h2>
            <div class="metadata">
                <div>Run at: ${testResults.timestamp}</div>
                <div class="duration">Total duration: ${duration}s</div>
            </div>
            <div class="summary">
                <div class="stat-box total">
                    <h3>Total Tests</h3>
                    <div>${totalTests}</div>
                </div>
                <div class="stat-box passed">
                    <h3>Passed</h3>
                    <div>${passedTests}</div>
                </div>
                <div class="stat-box failed">
                    <h3>Failed</h3>
                    <div>${failedTests}</div>
                </div>
                <div class="stat-box skipped">
                    <h3>Skipped</h3>
                    <div>${skippedTests}</div>
                </div>
            </div>
            <div class="chart-container">
                <canvas id="testResultsChart"></canvas>
            </div>
            <h3 class="section-title">Test Suites</h3>
            ${suites.map(suite => `
                <div class="suite" onclick="showSuiteDetails('${suite.name}')">
                    <div class="suite-header">
                        <h4>${suite.name}</h4>
                        <div class="suite-metadata">
                            ${suite.tests} tests, ${suite.failures} failed, ${suite.skipped} skipped
                            (${Number(suite.time).toFixed(2)}s)
                        </div>
                    </div>
                </div>
            `).join('')}
            <script>
                const ctx = document.getElementById('testResultsChart').getContext('2d');
                new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Passed', 'Failed', 'Skipped'],
                        datasets: [{
                            data: [${passedTests}, ${failedTests}, ${skippedTests}],
                            backgroundColor: [
                                getComputedStyle(document.documentElement).getPropertyValue('--vscode-testing-iconPassed'),
                                getComputedStyle(document.documentElement).getPropertyValue('--vscode-testing-iconFailed'),
                                getComputedStyle(document.documentElement).getPropertyValue('--vscode-testing-iconSkipped')
                            ]
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: {
                                    color: getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-foreground')
                                }
                            }
                        }
                    }
                });

                function showSuiteDetails(suiteName) {
                    vscode.postMessage({
                        command: 'showSuiteDetails',
                        suiteName: suiteName
                    });
                }
            </script>
        </body>
        </html>`;
    }
} 