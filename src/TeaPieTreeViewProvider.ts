import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface TestCase {
    name: string;
    files: {
        init?: string;
        request?: string;
        test?: string;
    };
    directory: string;
}

export class TeaPieTreeViewProvider implements vscode.TreeDataProvider<TeaPieTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TeaPieTreeItem | undefined | null | void> = new vscode.EventEmitter<TeaPieTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TeaPieTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private workspaceRoot: string | undefined) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    async reveal(uri: vscode.Uri): Promise<void> {
        // Get the relative path from workspace root
        const relativePath = path.relative(this.workspaceRoot || '', uri.fsPath);
        const segments = relativePath.split(path.sep).filter(Boolean);

        // Start from root and traverse down
        let currentPath = this.workspaceRoot || '';
        let currentItems = await this.getRootItems();

        for (const segment of segments) {
            currentPath = path.join(currentPath, segment);
            const targetUri = vscode.Uri.file(currentPath);
            
            // Find the matching item
            const matchingItem = currentItems.find(item => 
                item.resourceUri && item.resourceUri.fsPath === targetUri.fsPath
            );

            if (matchingItem) {
                // If this is a directory, expand it
                if (matchingItem.isDirectory) {
                    currentItems = await this.getChildren(matchingItem);
                }
            } else {
                // If we can't find the item, refresh the tree to ensure it's loaded
                this.refresh();
                currentItems = await this.getChildren();
            }
        }
    }

    getTreeItem(element: TeaPieTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TeaPieTreeItem): Promise<TeaPieTreeItem[]> {
        if (!this.workspaceRoot) {
            vscode.window.showInformationMessage('No workspace folder found');
            return [];
        }

        if (!element) {
            return this.getRootItems();
        }

        if (element.contextValue === 'testCase') {
            return this.getTestCaseFiles(element);
        }

        if (!element.resourceUri) {
            console.error('TreeItem has no resourceUri:', element);
            return [];
        }

        return this.getDirectoryItems(element.resourceUri.fsPath);
    }

    private async getRootItems(): Promise<TeaPieTreeItem[]> {
        if (!this.workspaceRoot) {
            return [];
        }

        const items = await this.getDirectoryItems(this.workspaceRoot);
        return items;
    }

    private formatPascalCase(text: string): string {
        // Replace PascalCase with spaces, but keep acronyms together
        return text.replace(/([A-Z])([A-Z])([a-z])|([a-z])([A-Z])/g, '$1$4 $2$3$5');
    }

    private async getDirectoryItems(dirPath: string): Promise<TeaPieTreeItem[]> {
        try {
            console.log('Getting directory items for:', dirPath);
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const items: TeaPieTreeItem[] = [];

            // First, collect all test cases in this directory
            const testCases = new Map<string, TestCase>();

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                // Skip hidden files and directories
                if (entry.name.startsWith('.')) {
                    continue;
                }

                if (entry.isDirectory()) {
                    // Check if directory contains test files
                    const hasTestFiles = await this.hasTestFiles(fullPath);
                    if (hasTestFiles) {
                        const uri = vscode.Uri.file(fullPath);
                        items.push(new TeaPieTreeItem(
                            entry.name,
                            uri,
                            vscode.TreeItemCollapsibleState.Collapsed
                        ));
                    }
                } else if (this.isTestFile(entry.name)) {
                    // Extract test case name and type
                    const match = entry.name.match(/^(.+?)-(init|req|test)\.(csx|http)$/);
                    if (match) {
                        const [, name, type] = match;
                        if (!testCases.has(name)) {
                            testCases.set(name, {
                                name,
                                files: {},
                                directory: dirPath
                            });
                        }
                        const testCase = testCases.get(name)!;
                        switch (type) {
                            case 'init':
                                testCase.files.init = fullPath;
                                break;
                            case 'req':
                                testCase.files.request = fullPath;
                                break;
                            case 'test':
                                testCase.files.test = fullPath;
                                break;
                        }
                    }
                }
            }

            // Create test case items
            for (const [name, testCase] of testCases) {
                const item = new TeaPieTreeItem(
                    this.formatPascalCase(name),  // Format the display name
                    vscode.Uri.file(testCase.directory),
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'testCase'
                );
                item.testCase = testCase;
                items.push(item);
            }

            return items.sort((a, b) => {
                // Directories first, then test cases
                if (a.contextValue === 'testCase' && b.contextValue !== 'testCase') return 1;
                if (a.contextValue !== 'testCase' && b.contextValue === 'testCase') return -1;
                return a.label.localeCompare(b.label);
            });
        } catch (error) {
            console.error('Error reading directory:', error);
            return [];
        }
    }

    private async getTestCaseFiles(element: TeaPieTreeItem): Promise<TeaPieTreeItem[]> {
        if (!element.testCase) {
            return [];
        }

        const items: TeaPieTreeItem[] = [];
        const { files } = element.testCase;

        if (files.init) {
            const uri = vscode.Uri.file(files.init);
            items.push(new TeaPieTreeItem(
                'Initialize',
                uri,
                vscode.TreeItemCollapsibleState.None
            ));
        }

        if (files.request) {
            const uri = vscode.Uri.file(files.request);
            items.push(new TeaPieTreeItem(
                'Request',
                uri,
                vscode.TreeItemCollapsibleState.None
            ));
        }

        if (files.test) {
            const uri = vscode.Uri.file(files.test);
            items.push(new TeaPieTreeItem(
                'Test',
                uri,
                vscode.TreeItemCollapsibleState.None
            ));
        }

        return items;
    }

    private async hasTestFiles(dirPath: string): Promise<boolean> {
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const hasTestFiles = await this.hasTestFiles(path.join(dirPath, entry.name));
                    if (hasTestFiles) {
                        return true;
                    }
                } else if (this.isTestFile(entry.name)) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error('Error checking for test files:', error);
            return false;
        }
    }

    private isTestFile(fileName: string): boolean {
        return fileName.endsWith('-init.csx') ||
            fileName.endsWith('-req.http') ||
            fileName.endsWith('-test.csx');
    }
}

export class TeaPieTreeItem extends vscode.TreeItem {
    public testCase?: TestCase;

    constructor(
        public readonly label: string,
        resourceUri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType?: 'directory' | 'testCase' | 'initFile' | 'httpFile' | 'testFile'
    ) {
        super(resourceUri, collapsibleState);
        
        this.tooltip = this.label;
        this.description = this.getDescription();
        this.contextValue = itemType || this.getContextValue();
        this.iconPath = this.getIconPath();
        
        // Set up commands based on item type
        if (!this.isDirectory) {
            this.command = {
                command: 'teapie-extensions.openFile',
                title: 'Open File',
                arguments: [this]
            };
        }
    }

    get isDirectory(): boolean {
        return this.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed && this.contextValue !== 'testCase';
    }

    get httpFileUri(): vscode.Uri | undefined {
        if (this.contextValue === 'httpFile') {
            return this.resourceUri;
        }
        if (this.contextValue === 'testCase' && this.testCase?.files.request) {
            return vscode.Uri.file(this.testCase.files.request);
        }
        return undefined;
    }

    private getDescription(): string | undefined {
        if (this.contextValue === 'testCase') {
            return 'Test Case';
        }
        if (this.label === 'Initialize') return 'Init';
        if (this.label === 'Request') return 'Request';
        if (this.label === 'Test') return 'Test';
        return undefined;
    }

    private getIconPath(): vscode.ThemeIcon {
        if (this.isDirectory) {
            return new vscode.ThemeIcon('folder');
        }
        if (this.contextValue === 'testCase') {
            return new vscode.ThemeIcon('beaker', new vscode.ThemeColor('testing.iconPassed'));
        }
        if (this.label === 'Initialize') {
            return new vscode.ThemeIcon('debug-start');
        }
        if (this.label === 'Request') {
            return new vscode.ThemeIcon('arrow-right');
        }
        if (this.label === 'Test') {
            return new vscode.ThemeIcon('check');
        }
        return new vscode.ThemeIcon('file');
    }

    private getContextValue(): string {
        if (this.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed) return 'directory';
        if (this.label === 'Initialize') return 'initFile';
        if (this.label === 'Request') return 'httpFile';
        if (this.label === 'Test') return 'testFile';
        return 'file';
    }
} 