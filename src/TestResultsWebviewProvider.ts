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
                    padding: 30px;
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    line-height: 1.6;
                    max-width: 1200px;
                    margin: 0 auto;
                }
                .header {
                    margin-bottom: 40px;
                }
                h2 {
                    font-size: 24px;
                    margin: 0 0 20px 0;
                }
                .status-container {
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    margin-bottom: 30px;
                }
                .status {
                    padding: 8px 16px;
                    border-radius: 20px;
                    font-weight: bold;
                    font-size: 14px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
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
                .duration-badge {
                    display: inline-flex;
                    align-items: center;
                    padding: 4px 8px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border-radius: 4px;
                    font-size: 12px;
                }
                .info-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 40px;
                    background: var(--vscode-editor-background);
                    padding: 20px;
                    border-radius: 8px;
                    border: 1px solid var(--vscode-panel-border);
                }
                .info-item {
                    padding: 15px;
                }
                .info-label {
                    font-size: 12px;
                    text-transform: uppercase;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 5px;
                    letter-spacing: 0.5px;
                }
                .info-value {
                    font-size: 16px;
                    font-weight: 500;
                }
                .details {
                    background: var(--vscode-editor-background);
                    padding: 20px;
                    border-radius: 8px;
                    border: 1px solid var(--vscode-panel-border);
                }
                .details h3 {
                    margin: 0 0 15px 0;
                    font-size: 18px;
                    color: var(--vscode-testing-iconFailed);
                }
                .failure-message {
                    color: var(--vscode-testing-message-error-decorationForeground);
                    white-space: pre-wrap;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 14px;
                    background: var(--vscode-editor-background);
                    padding: 15px;
                    border-radius: 4px;
                    border-left: 4px solid var(--vscode-testing-iconFailed);
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>${testCase.name}</h2>
                <div class="status-container">
                    <div class="status ${statusClass}">${status}</div>
                    <div class="duration-badge">
                        Duration: ${Number(testCase.time).toFixed(3)}s
                    </div>
                </div>
            </div>
            
            <div class="info-grid">
                <div class="info-item">
                    <div class="info-label">Class</div>
                    <div class="info-value">${testCase.classname}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Test Name</div>
                    <div class="info-value">${testCase.name}</div>
                </div>
            </div>

            ${testCase.failure ? `
                <div class="details">
                    <h3>Failure Details</h3>
                    <div class="failure-message">${testCase.failure.message || ''}
${testCase.failure._ || ''}</div>
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
                    padding: 30px;
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    line-height: 1.6;
                    max-width: 1200px;
                    margin: 0 auto;
                }
                .header {
                    margin-bottom: 40px;
                }
                h2 {
                    font-size: 24px;
                    margin: 0 0 20px 0;
                }
                .status-container {
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    margin-bottom: 30px;
                }
                .duration-badge {
                    display: inline-flex;
                    align-items: center;
                    padding: 4px 8px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border-radius: 4px;
                    font-size: 12px;
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
                .test-list {
                    margin-top: 20px;
                }
                .test-item {
                    padding: 15px;
                    margin: 8px 0;
                    border-radius: 4px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    position: relative;
                    padding-left: 20px;
                }
                .test-item::before {
                    content: '';
                    position: absolute;
                    left: 0;
                    top: 0;
                    bottom: 0;
                    width: 4px;
                    border-top-left-radius: 4px;
                    border-bottom-left-radius: 4px;
                }
                .test-item.failed::before { 
                    background-color: var(--vscode-testing-iconFailed);
                }
                .test-item.passed::before { 
                    background-color: var(--vscode-testing-iconPassed);
                }
                .test-item.skipped::before { 
                    background-color: var(--vscode-testing-iconSkipped);
                }
                .test-item .test-name {
                    font-size: 14px;
                    color: var(--vscode-editor-foreground);
                    flex: 1;
                    margin-right: 10px;
                }
                .test-item .duration-badge {
                    flex-shrink: 0;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>${testSuite.name}</h2>
                <div class="status-container">
                    <div class="duration-badge">
                        Duration: ${duration}s
                    </div>
                </div>
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
                ${Array.isArray(testSuite.testcase) ? testSuite.testcase.map(testCase => {
                    const isSkipped = testCase.skipped !== undefined || testCase.time === '0.00' || testCase.time === '0';
                    const status = testCase.failure ? 'failed' : isSkipped ? 'skipped' : 'passed';
                    return `
                    <div class="test-item ${status}">
                        <div class="test-name">${testCase.name}</div>
                        <div class="duration-badge">Duration: ${Number(testCase.time).toFixed(3)}s</div>
                    </div>
                `}).join('') : ''}
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
                    padding: 30px;
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    line-height: 1.6;
                    max-width: 1200px;
                    margin: 0 auto;
                }
                .header {
                    margin-bottom: 40px;
                }
                h2 {
                    font-size: 24px;
                    margin: 0 0 20px 0;
                }
                .status-container {
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    margin-bottom: 30px;
                }
                .duration-badge {
                    display: inline-flex;
                    align-items: center;
                    padding: 4px 8px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border-radius: 4px;
                    font-size: 12px;
                }
                .metadata {
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 40px;
                    font-size: 14px;
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
            <div class="header">
                <h2>Test Run Summary</h2>
                <div class="status-container">
                    <div class="duration-badge">
                        Duration: ${duration}s
                    </div>
                </div>
            </div>
            <div class="metadata">
                <div>Run at: ${testResults.timestamp}</div>
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
                            <span class="duration-badge" style="margin-left: 10px">
                                Duration: ${Number(suite.time).toFixed(2)}s
                            </span>
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