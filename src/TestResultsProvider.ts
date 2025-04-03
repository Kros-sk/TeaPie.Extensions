import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as xml2js from 'xml2js';

export interface TestCase {
    name: string;
    time: string;
    classname: string;
    failure?: {
        _: string;
        message: string;
        type: string;
    };
    skipped?: string;
}

export interface TestSuite {
    name: string;
    tests: string;
    skipped: string;
    failures: string;
    time: string;
    testcase: TestCase | TestCase[];
}

export interface TestSuites {
    name: string;
    tests: string;
    skipped: string;
    failures: string;
    time: string;
    timestamp: string;
    testsuite: TestSuite | TestSuite[];
}

export class TestResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly testCase?: TestCase,
        public readonly testSuite?: TestSuite,
        public readonly isSummary: boolean = false,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
        this.tooltip = this.getTooltip();
        this.iconPath = this.getIconPath();
        this.contextValue = this.getContextValue();
        
        // Set command based on item type
        if (this.isSummary) {
            this.command = {
                command: 'teapie-extensions.showSummary',
                title: 'Show Summary',
                arguments: []
            };
        } else if (this.testCase) {
            this.command = {
                command: 'teapie-extensions.showTestDetails',
                title: 'Show Test Details',
                arguments: [this]
            };
        } else if (this.testSuite) {
            this.command = {
                command: 'teapie-extensions.showTestDetails',
                title: 'Show Test Details',
                arguments: [this]
            };
        }
    }

    private getTooltip(): string {
        if (this.isSummary) {
            return 'Test Run Summary';
        }
        if (this.testCase) {
            if (this.testCase.failure) {
                return `Failed: ${this.testCase.failure.message}`;
            } else if (this.testCase.skipped !== undefined) {
                return 'Skipped';
            }
            return `Passed (${this.testCase.time}s)`;
        }
        if (this.testSuite) {
            return `${this.testSuite.tests} tests, ${this.testSuite.failures} failures, ${this.testSuite.skipped} skipped`;
        }
        return this.label;
    }

    private getIconPath(): vscode.ThemeIcon | undefined {
        if (this.isSummary) {
            return new vscode.ThemeIcon('graph');
        }
        if (this.testCase) {
            if (this.testCase.failure) {
                return new vscode.ThemeIcon('error');
            } else if (this.testCase.skipped !== undefined) {
                return new vscode.ThemeIcon('symbol-misc');
            }
            return new vscode.ThemeIcon('pass');
        }
        return new vscode.ThemeIcon('beaker');
    }

    private getContextValue(): string {
        if (this.isSummary) {
            return 'summary';
        }
        if (this.testCase) {
            return 'testcase';
        }
        if (this.testSuite) {
            return 'testsuite';
        }
        return '';
    }
}

export class TestResultsProvider implements vscode.TreeDataProvider<TestResultItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TestResultItem | undefined | null | void> = new vscode.EventEmitter<TestResultItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TestResultItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private testResults?: TestSuites;
    private outputChannel: vscode.OutputChannel;

    constructor(private context?: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('TeaPie Test Results');
        this.loadTestResults();
    }

    public getTestResults(): TestSuites | undefined {
        return this.testResults;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    async loadTestResults(): Promise<void> {
        this.outputChannel.appendLine('Loading test results...');
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.outputChannel.appendLine('No workspace folders found');
            return;
        }

        const reportPath = path.join(workspaceFolders[0].uri.fsPath, '.teapie', 'reports', 'last-run-report.xml');
        this.outputChannel.appendLine(`Looking for report at: ${reportPath}`);
        
        if (!fs.existsSync(reportPath)) {
            this.outputChannel.appendLine('Report file not found');
            return;
        }

        try {
            const xmlContent = fs.readFileSync(reportPath, 'utf8');
            this.outputChannel.appendLine('XML content loaded, parsing...');

            const parser = new xml2js.Parser({
                explicitArray: false,
                mergeAttrs: true
            });
            
            const result = await parser.parseStringPromise(xmlContent);
            this.outputChannel.appendLine('XML parsed successfully');
            this.outputChannel.appendLine(`Parsed result structure: ${JSON.stringify(result, null, 2)}`);

            this.testResults = result.testsuites;
            this.outputChannel.appendLine(`Test results structure: ${JSON.stringify(this.testResults, null, 2)}`);
            
            this.refresh();
        } catch (error) {
            this.outputChannel.appendLine(`Error parsing test results: ${error}`);
            vscode.window.showErrorMessage(`Failed to parse test results: ${error}`);
        }
    }

    getTreeItem(element: TestResultItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TestResultItem): Promise<TestResultItem[]> {
        this.outputChannel.appendLine('Getting children...');
        
        if (!this.testResults) {
            this.outputChannel.appendLine('No test results available');
            return [];
        }

        if (!element) {
            // Root level - show summary and test suites
            const items: TestResultItem[] = [];
            
            // Add summary item
            items.push(new TestResultItem(
                'Test Run Summary',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                undefined,
                true,
                {
                    command: 'teapie-extensions.showSummary',
                    title: 'Show Summary',
                    arguments: [this.testResults]
                }
            ));

            // Add test suites
            const suites = Array.isArray(this.testResults.testsuite) 
                ? this.testResults.testsuite 
                : [this.testResults.testsuite];
            
            this.outputChannel.appendLine(`Found ${suites.length} test suites`);
            
            items.push(...suites.map(suite => {
                const name = suite.name || 'Unknown Suite';
                this.outputChannel.appendLine(`Creating tree item for suite: ${name}`);
                
                const item = new TestResultItem(
                    name,
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    suite
                );
                
                // Add description showing test counts
                item.description = `(${suite.tests} tests, ${suite.failures || 0} failed, ${suite.skipped || 0} skipped)`;
                
                return item;
            }));

            return items;
        }

        if (element.testSuite) {
            // Show test cases for a suite
            const suiteName = element.testSuite.name || 'Unknown Suite';
            this.outputChannel.appendLine(`Getting test cases for suite: ${suiteName}`);
            
            // Handle both single testcase and array of testcases
            const cases = Array.isArray(element.testSuite.testcase) 
                ? element.testSuite.testcase 
                : element.testSuite.testcase ? [element.testSuite.testcase] : [];
            
            this.outputChannel.appendLine(`Found ${cases.length} test cases`);
            
            return cases.map(testCase => {
                const name = testCase.name || 'Unknown Test';
                this.outputChannel.appendLine(`Creating tree item for test case: ${name}`);
                
                const item = new TestResultItem(
                    name,
                    vscode.TreeItemCollapsibleState.None,
                    testCase,
                    undefined,
                    false,
                    {
                        command: 'teapie-extensions.showTestDetails',
                        title: 'Show Test Details',
                        arguments: [testCase]
                    }
                );

                // Add execution time and status to description
                const status = testCase.failure ? 'Failed' : testCase.skipped !== undefined ? 'Skipped' : 'Passed';
                item.description = `${status} (${Number(testCase.time).toFixed(2)}s)`;
                
                return item;
            });
        }

        return [];
    }
} 