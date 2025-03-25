import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class TeaPieTreeViewProvider implements vscode.TreeDataProvider<TeaPieTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TeaPieTreeItem | undefined | null | void> = new vscode.EventEmitter<TeaPieTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TeaPieTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private workspaceRoot: string | undefined) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
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

    private async getDirectoryItems(dirPath: string): Promise<TeaPieTreeItem[]> {
        try {
            console.log('Getting directory items for:', dirPath);
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const items: TeaPieTreeItem[] = [];

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
                        console.log('Creating directory item:', {
                            name: entry.name,
                            path: fullPath
                        });
                        const uri = vscode.Uri.file(fullPath);
                        console.log('Created Uri for directory:', {
                            scheme: uri.scheme,
                            path: uri.fsPath,
                            uri: uri.toString()
                        });
                        const item = new TeaPieTreeItem(
                            entry.name,
                            uri,
                            vscode.TreeItemCollapsibleState.Collapsed
                        );
                        console.log('Created directory TreeItem:', {
                            label: item.label,
                            resourceUri: item.resourceUri instanceof vscode.Uri ? {
                                scheme: item.resourceUri.scheme,
                                path: item.resourceUri.fsPath,
                                uri: item.resourceUri.toString()
                            } : 'Not a Uri',
                            collapsibleState: item.collapsibleState
                        });
                        items.push(item);
                    }
                } else if (this.isTestFile(entry.name)) {
                    console.log('Creating file item:', {
                        name: entry.name,
                        path: fullPath
                    });
                    const uri = vscode.Uri.file(fullPath);
                    console.log('Created Uri for file:', {
                        scheme: uri.scheme,
                        path: uri.fsPath,
                        uri: uri.toString()
                    });
                    const item = new TeaPieTreeItem(
                        entry.name,
                        uri,
                        vscode.TreeItemCollapsibleState.None
                    );
                    console.log('Created file TreeItem:', {
                        label: item.label,
                        resourceUri: item.resourceUri instanceof vscode.Uri ? {
                            scheme: item.resourceUri.scheme,
                            path: item.resourceUri.fsPath,
                            uri: item.resourceUri.toString()
                        } : 'Not a Uri',
                        collapsibleState: item.collapsibleState,
                        command: item.command
                    });
                    items.push(item);
                }
            }

            return items.sort((a, b) => {
                // Directories first, then files
                if (a.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed && 
                    b.collapsibleState === vscode.TreeItemCollapsibleState.None) return -1;
                if (a.collapsibleState === vscode.TreeItemCollapsibleState.None && 
                    b.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed) return 1;
                return a.label.localeCompare(b.label);
            });
        } catch (error) {
            console.error('Error reading directory:', error);
            return [];
        }
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
    constructor(
        public readonly label: string,
        resourceUri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(resourceUri, collapsibleState);
        
        console.log('Creating TreeItem:', {
            label,
            resourceUri: resourceUri instanceof vscode.Uri ? {
                scheme: resourceUri.scheme,
                path: resourceUri.fsPath,
                uri: resourceUri.toString()
            } : 'Not a Uri',
            collapsibleState
        });
        
        this.label = label;
        this.tooltip = this.label;
        this.description = this.getDescription();
        this.iconPath = this.getIconPath();
        this.contextValue = this.getContextValue();
        
        if (!this.isDirectory) {
            console.log('Setting up command for file:', {
                uri: resourceUri instanceof vscode.Uri ? resourceUri.toString() : 'Not a Uri'
            });
            this.command = {
                command: 'teapie-extensions.openFile',
                title: 'Open File',
                arguments: [resourceUri]
            };
        }
    }

    get isDirectory(): boolean {
        return this.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed;
    }

    private getDescription(): string {
        if (this.isDirectory) {
            return '';
        }
        const ext = path.extname(this.label);
        switch (ext) {
            case '.csx':
                return this.label.includes('-init') ? 'Initialization' : 'Test';
            case '.http':
                return 'Request';
            default:
                return '';
        }
    }

    private getIconPath(): vscode.ThemeIcon | undefined {
        if (this.isDirectory) {
            return new vscode.ThemeIcon('folder');
        }

        const ext = path.extname(this.label);
        switch (ext) {
            case '.csx':
                return new vscode.ThemeIcon('symbol-misc');
            case '.http':
                return new vscode.ThemeIcon('symbol-interface');
            default:
                return undefined;
        }
    }

    private getContextValue(): string {
        if (this.isDirectory) {
            return 'directory';
        }
        const ext = path.extname(this.label);
        switch (ext) {
            case '.csx':
                return this.label.includes('-init') ? 'initFile' : 'testFile';
            case '.http':
                return 'httpFile';
            default:
                return 'file';
        }
    }
} 