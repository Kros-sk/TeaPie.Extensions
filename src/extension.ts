import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { TeaPieTreeItem, TeaPieTreeViewProvider } from './TeaPieTreeViewProvider';

import { HttpCompletionProvider } from './HttpCompletionProvider';
import { HttpHoverProvider } from './HttpHoverProvider';
import { HttpPreviewProvider } from './HttpPreviewProvider';
import { TeaPieInitializer } from './utils/TeaPieInitializer';
import { TeaPieLanguageServer } from './TeaPieLanguageServer';
import { TestRenameProvider } from './TestRenameProvider';
import { VariablesProvider } from './VariablesProvider';
import { VisualTestEditorProvider } from './VisualTestEditorProvider';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Create output channel for logging
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel('TeaPie Extensions');
    outputChannel.show(true);

    outputChannel.appendLine('Activating TeaPie extension...');

    // Initialize TeaPie folder structure
    const initializer = new TeaPieInitializer(outputChannel);
    await initializer.initialize();

    // Initialize the TeaPie language server
    const server = TeaPieLanguageServer.getInstance(context);
    server.initialize().then(() => {
        outputChannel.appendLine('TeaPie language server initialized successfully');
    }).catch(error => {
        outputChannel.appendLine(`Failed to initialize TeaPie language server: ${error}`);
    });

    // Initialize TestRenameProvider
    const testRenameProvider = new TestRenameProvider(context);

    // Load variables for HTTP files
    const loadVariablesForFile = async (document: vscode.TextDocument, forceReload: boolean = false) => {
        if (document.languageId === 'http') {
            const variablesProvider = VariablesProvider.getInstance();
            await variablesProvider.loadVariables(path.dirname(document.uri.fsPath), forceReload);
        }
    };

    // Load variables when a file is opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => loadVariablesForFile(doc, false))
    );

    // Load variables when a file is changed - force reload to get fresh values
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => loadVariablesForFile(doc, true))
    );

    // Load variables when switching between files
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (editor?.document) {
                await loadVariablesForFile(editor.document, false);
            }
        })
    );

    // Load variables for the currently open file if it's an HTTP file
    if (vscode.window.activeTextEditor?.document.languageId === 'http') {
        loadVariablesForFile(vscode.window.activeTextEditor.document, false);
    }

    // Register a command to reload XML documentation
    context.subscriptions.push(
        vscode.commands.registerCommand('teapie.reloadDocs', async () => {
            await server.loadXmlDocumentation();
            vscode.window.showInformationMessage('TeaPie documentation reloaded');
        })
    );

    // Register command to set up OmniSharp for CSX files
    context.subscriptions.push(
        vscode.commands.registerCommand('teapie.setupCsxSupport', async () => {
            await setupCsxSupport();
            vscode.window.showInformationMessage('CSX support configured successfully');
        })
    );

    // Register Tree View Provider
    const treeViewProvider = new TeaPieTreeViewProvider(vscode.workspace.workspaceFolders?.[0].uri.fsPath);
    const treeView = vscode.window.createTreeView('teapieExplorer', {
        treeDataProvider: treeViewProvider,
        showCollapseAll: true
    });

    // Handle tree view selection
    treeView.onDidChangeSelection(async event => {
        outputChannel.appendLine('Selection changed: ' + JSON.stringify(event.selection));
        const item = event.selection[0] as TeaPieTreeItem;
        outputChannel.appendLine('Selected item: ' + JSON.stringify({
            label: item?.label,
            resourceUri: item?.resourceUri,
            isDirectory: item?.isDirectory,
            collapsibleState: item?.collapsibleState,
            description: item?.description,
            tooltip: item?.tooltip
        }));

        if (item && !item.isDirectory && item.resourceUri) {
            try {
                outputChannel.appendLine('Attempting to open file: ' + JSON.stringify({
                    fsPath: item.resourceUri.fsPath,
                    path: item.resourceUri.path,
                    scheme: item.resourceUri.scheme,
                    authority: item.resourceUri.authority
                }));

                const document = await vscode.workspace.openTextDocument(item.resourceUri);
                outputChannel.appendLine('Document opened: ' + document.uri.fsPath);

                await vscode.window.showTextDocument(document, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.Active
                });
                outputChannel.appendLine('Document shown in editor');
            } catch (error) {
                outputChannel.appendLine(`Failed to open file: ${error}`);
                vscode.window.showErrorMessage(`Failed to open file: ${error}`);
            }
        } else {
            outputChannel.appendLine('Item is either null, a directory, or has no resourceUri');
        }
    });

    // Add refresh command
    let refreshDisposable = vscode.commands.registerCommand('teapie-extensions.refreshExplorer', () => {
        treeViewProvider.refresh();
    });

    // Add file open command
    let openFileDisposable = vscode.commands.registerCommand('teapie-extensions.openFile', async (item: TeaPieTreeItem) => {
        try {
            if (!item?.resourceUri) {
                throw new Error('No resourceUri in item');
            }

            // For test cases, open the request file
            // For other items, open their own file
            const uri = item.contextValue === 'testCase' ? item.httpFileUri : item.resourceUri;
            if (!uri) {
                throw new Error('No file URI available');
            }

            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, {
                preview: false,
                viewColumn: vscode.ViewColumn.Active
            });
        } catch (error) {
            outputChannel.appendLine(`Failed to open file: ${error}`);
            vscode.window.showErrorMessage(`Failed to open file: ${error}`);
        }
    });

    let disposable = vscode.commands.registerCommand('teapie-extensions.runDirectory', async (item: TeaPieTreeItem | vscode.Uri) => {
        try {
            let targetPath: string;
            if (item instanceof vscode.Uri) {
                targetPath = item.fsPath;
            } else if (item?.resourceUri) {
                targetPath = item.resourceUri.fsPath;
            } else {
                throw new Error('No resourceUri in item');
            }
            await runTeaPieCommand('test', targetPath);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to run TeaPie tests: ${error}`);
        }
    });

    let runFileDisposable = vscode.commands.registerCommand('teapie-extensions.runFile', async (item?: TeaPieTreeItem | vscode.Uri) => {
        try {
            let targetPath: string;

            // If no item provided, try to get from active editor
            if (!item) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    throw new Error('No active editor');
                }
                item = editor.document.uri;
            }

            if (item instanceof vscode.Uri) {
                const filePath = item.fsPath;
                if (filePath.endsWith('-test.csx')) {
                    // If it's a test file, find the corresponding HTTP file
                    const httpFile = filePath.replace('-test.csx', '-req.http');
                    if (fs.existsSync(httpFile)) {
                        targetPath = httpFile;
                    } else {
                        throw new Error('No corresponding HTTP file found for this test file');
                    }
                } else if (filePath.endsWith('-req.http')) {
                    targetPath = filePath;
                } else {
                    throw new Error('Not a TeaPie test file');
                }
            } else if (item?.httpFileUri) {
                targetPath = item.httpFileUri.fsPath;
            } else {
                throw new Error('No HTTP file available');
            }
            await runTeaPieCommand('test', targetPath);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to run TeaPie test: ${error}`);
        }
    });

    let runToFileDisposable = vscode.commands.registerCommand('teapie-extensions.runToFile', async (item?: TeaPieTreeItem | vscode.Uri) => {
        try {
            let targetPath: string;

            // If no item provided, try to get from active editor
            if (!item) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    throw new Error('No active editor');
                }
                item = editor.document.uri;
            }

            if (item instanceof vscode.Uri) {
                const filePath = item.fsPath;
                if (filePath.endsWith('-test.csx')) {
                    // If it's a test file, find the corresponding HTTP file
                    const httpFile = filePath.replace('-test.csx', '-req.http');
                    if (fs.existsSync(httpFile)) {
                        targetPath = httpFile;
                    } else {
                        throw new Error('No corresponding HTTP file found for this test file');
                    }
                } else if (filePath.endsWith('-req.http')) {
                    targetPath = filePath;
                } else {
                    throw new Error('Not a TeaPie test file');
                }
            } else if (item?.httpFileUri) {
                targetPath = item.httpFileUri.fsPath;
            } else {
                throw new Error('No HTTP file available');
            }
            await runTeaPieCommand('test-to', targetPath);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to run TeaPie tests up to file: ${error}`);
        }
    });

    let cycleTestFilesDisposable = vscode.commands.registerCommand('teapie-extensions.cycleTestFiles', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const currentFile = editor.document.uri.fsPath;
        const nextFile = findNextTestFile(currentFile);

        if (nextFile) {
            try {
                const document = await vscode.workspace.openTextDocument(nextFile);
                await vscode.window.showTextDocument(document);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open file: ${error}`);
            }
        } else {
            vscode.window.showInformationMessage('No other test files found in the sequence');
        }
    });

    let nextTestCaseDisposable = vscode.commands.registerCommand('teapie-extensions.nextTestCase', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const currentFile = editor.document.uri.fsPath;
        const nextTestCase = await findNextTestCase(currentFile, false);

        if (nextTestCase) {
            try {
                const document = await vscode.workspace.openTextDocument(nextTestCase);
                await vscode.window.showTextDocument(document);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open file: ${error}`);
            }
        } else {
            vscode.window.showInformationMessage('No next test case found in the current directory');
        }
    });

    let nextTestCaseWithSubdirsDisposable = vscode.commands.registerCommand('teapie-extensions.nextTestCaseWithSubdirs', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const currentFile = editor.document.uri.fsPath;
        const nextTestCase = await findNextTestCase(currentFile, true);

        if (nextTestCase) {
            try {
                const document = await vscode.workspace.openTextDocument(nextTestCase);
                await vscode.window.showTextDocument(document);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open file: ${error}`);
            }
        } else {
            vscode.window.showInformationMessage('No next test case found in any directory');
        }
    });

    let generateTestCaseDisposable = vscode.commands.registerCommand('teapie-extensions.generateTestCase', async (uri: vscode.Uri) => {
        try {
            // Get the target directory from the URI or use the workspace root
            const targetDir = uri.fsPath || vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!targetDir) {
                vscode.window.showErrorMessage('No target directory selected');
                return;
            }

            // Ask for test case name
            const testCaseName = await vscode.window.showInputBox({
                prompt: 'Enter test case name (spaces allowed)',
                placeHolder: 'My Test Case',
                validateInput: (value) => {
                    if (!value) {
                        return 'Test case name is required';
                    }
                    return null;
                }
            });

            if (!testCaseName) {
                return;
            }

            // Convert to PascalCase and remove spaces
            const pascalCaseName = testCaseName
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join('');

            // Run the generate command
            const terminal = vscode.window.createTerminal('TeaPie');
            terminal.show();

            const commandStr = `teapie generate "${pascalCaseName}" "${targetDir}"`;
            terminal.sendText(commandStr);
            terminal.sendText('exit'); // Close the terminal after command completes

            // Function to check if file exists
            const checkFile = async (filePath: string, retries: number = 10, delay: number = 500): Promise<boolean> => {
                for (let i = 0; i < retries; i++) {
                    if (fs.existsSync(filePath)) {
                        // Add a small delay even after finding the file to ensure it's fully written
                        await new Promise(resolve => setTimeout(resolve, 100));
                        return true;
                    }
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                return false;
            };

            // Find and open the .http file with retries
            const httpFile = path.join(targetDir, `${pascalCaseName}-req.http`);
            const fileExists = await checkFile(httpFile);

            if (fileExists) {
                const document = await vscode.workspace.openTextDocument(httpFile);
                await vscode.window.showTextDocument(document, { preview: false });
                vscode.window.showInformationMessage(`Opened ${pascalCaseName}-req.http`);
            } else {
                vscode.window.showErrorMessage(`Could not find the generated .http file at ${httpFile} after multiple attempts`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate test case: ${error}`);
        }
    });

    let exploreCollectionDisposable = vscode.commands.registerCommand('teapie-extensions.exploreCollection', async (uri: vscode.Uri) => {
        try {
            // Get the target directory from the URI or use the workspace root
            const targetDir = uri.fsPath || vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!targetDir) {
                vscode.window.showErrorMessage('No target directory selected');
                return;
            }

            // Create output channel if it doesn't exist
            let outputChannel = vscode.window.createOutputChannel('TeaPie Explorer');
            outputChannel.show();

            // Run the explore command
            const terminal = vscode.window.createTerminal('TeaPie');
            terminal.show();

            // Create a temporary file for output
            const tempOutputFile = path.join(targetDir, '.teapie-explore-output.txt');

            // Run command and redirect output to file
            const commandStr = `teapie explore "${targetDir}" > "${tempOutputFile}"`;
            terminal.sendText(commandStr);
            terminal.sendText('exit');

            // Function to check if file exists and has content
            const checkFile = async (filePath: string, retries: number = 10, delay: number = 500): Promise<boolean> => {
                for (let i = 0; i < retries; i++) {
                    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                        // Add a small delay even after finding the file to ensure it's fully written
                        await new Promise(resolve => setTimeout(resolve, 100));
                        return true;
                    }
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                return false;
            };

            // Wait for the output file
            const fileExists = await checkFile(tempOutputFile);

            if (fileExists) {
                try {
                    // Read and display the output
                    const output = fs.readFileSync(tempOutputFile, 'utf8');
                    outputChannel.clear();
                    outputChannel.appendLine('TeaPie Collection Structure:');
                    outputChannel.appendLine('=========================');
                    outputChannel.appendLine(output);

                    // Clean up the temporary file
                    fs.unlinkSync(tempOutputFile);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to read exploration results: ${error}`);
                }
            } else {
                vscode.window.showErrorMessage('Failed to get exploration results');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to explore collection: ${error}`);
        }
    });

    // Register Preview Command
    let previewHttpFileDisposable = vscode.commands.registerCommand('teapie-extensions.previewHttpFile', async (uri: vscode.Uri) => {
        try {
            // If no URI is provided, try to get it from the active editor
            if (!uri) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    throw new Error('No active editor');
                }
                uri = editor.document.uri;
            }

            // Show preview
            HttpPreviewProvider.show(uri);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to preview HTTP file: ${error}`);
        }
    });

    // Add visual editor command
    let visualEditorDisposable = vscode.commands.registerCommand('teapie-extensions.openVisualEditor', async (uri: vscode.Uri) => {
        try {
            if (!uri) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor');
                    return;
                }
                uri = editor.document.uri;
            }

            if (uri.scheme !== 'file' || !uri.fsPath.endsWith('.http')) {
                vscode.window.showErrorMessage('Please open a .http file first');
                return;
            }

            VisualTestEditorProvider.show(uri);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open visual editor: ${error}`);
        }
    });

    let navigateToFolderDisposable = vscode.commands.registerCommand('teapie-extensions.navigateToFolder', async (path: string) => {
        try {
            // Find the TreeItem corresponding to this path
            const treeViewProvider = new TeaPieTreeViewProvider(vscode.workspace.workspaceFolders?.[0].uri.fsPath);
            await treeViewProvider.reveal(vscode.Uri.file(path));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to navigate to folder: ${error}`);
        }
    });

    // Register command for shifting test names
    context.subscriptions.push(
        vscode.commands.registerCommand('teapie-extensions.shiftTestNames', async (uri: vscode.Uri) => {
            const startNumber = await vscode.window.showInputBox({
                prompt: 'Enter the starting test number to shift from',
                validateInput: (value) => {
                    const num = parseInt(value);
                    return isNaN(num) ? 'Please enter a valid number' : null;
                }
            });

            const shiftAmount = await vscode.window.showInputBox({
                prompt: 'Enter the amount to shift by (positive or negative)',
                validateInput: (value) => {
                    const num = parseInt(value);
                    return isNaN(num) ? 'Please enter a valid number' : null;
                }
            });

            if (startNumber && shiftAmount) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                await testRenameProvider.shiftTestNames(
                    relativePath,
                    parseInt(startNumber),
                    parseInt(shiftAmount)
                );
            }
        })
    );

    // Register command for shifting subsequent tests
    context.subscriptions.push(
        vscode.commands.registerCommand('teapie-extensions.shiftSubsequentTests', async (uri: vscode.Uri) => {
            await testRenameProvider.shiftSubsequentTests(uri);
        })
    );

    // Register HTTP completion provider
    const httpCompletionProvider = new HttpCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            'http',
            new HttpCompletionProvider(),
            '@', '#', ':'
        )
    );

    // Register the hover provider
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            'http',
            new HttpHoverProvider()
        )
    );

    // Register the command to run HTTP tests
    let runHttpTestDisposable = vscode.commands.registerCommand('teapie-extensions.runHttpTest', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'http') {
            const filePath = editor.document.uri.fsPath;
            await runTeaPieCommand('test', filePath);
        }
    });

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('teapie-extensions.openDocs', () => {
            vscode.env.openExternal(vscode.Uri.parse('https://www.teapie.fun'));
        }),
        treeView,
        refreshDisposable,
        openFileDisposable,
        disposable,
        runFileDisposable,
        runToFileDisposable,
        cycleTestFilesDisposable,
        nextTestCaseDisposable,
        nextTestCaseWithSubdirsDisposable,
        generateTestCaseDisposable,
        exploreCollectionDisposable,
        previewHttpFileDisposable,
        visualEditorDisposable,
        navigateToFolderDisposable,
        runHttpTestDisposable
    );
}

function findHttpFile(filePath: string): string | null {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));

    // Remove any existing suffixes (-init, -test, -req)
    const baseNameWithoutSuffix = baseName.replace(/-init$|-test$|-req$/, '');

    // Look for the .http file
    const httpFile = path.join(dir, `${baseNameWithoutSuffix}-req.http`);

    if (fs.existsSync(httpFile)) {
        return httpFile;
    }

    return null;
}

function findNextTestFile(currentFile: string): string | null {
    const dir = path.dirname(currentFile);
    const baseName = path.basename(currentFile);
    const baseNameWithoutExt = baseName.substring(0, baseName.lastIndexOf('-') !== -1 ? baseName.lastIndexOf('-') : baseName.lastIndexOf('.'));

    // Define the sequence of file types
    const fileTypes = [
        { suffix: '-init.csx', next: '-req.http' },
        { suffix: '-req.http', next: '-test.csx' },
        { suffix: '-test.csx', next: '-init.csx' }
    ];

    // Find current file type
    const currentType = fileTypes.find(type => baseName.endsWith(type.suffix));
    if (!currentType) {
        return null;
    }

    // Get next file type in sequence
    const nextType = currentType.next;
    const nextFile = path.join(dir, `${baseNameWithoutExt}${nextType}`);

    // If next file exists, return it
    if (fs.existsSync(nextFile)) {
        return nextFile;
    }

    // If next file doesn't exist, try the next one in sequence
    const nextTypeIndex = fileTypes.findIndex(type => type.suffix === nextType);
    for (let i = 1; i <= fileTypes.length; i++) {
        const index = (nextTypeIndex + i) % fileTypes.length;
        const alternativeFile = path.join(dir, `${baseNameWithoutExt}${fileTypes[index].suffix}`);
        if (fs.existsSync(alternativeFile)) {
            return alternativeFile;
        }
    }

    return null;
}

async function findNextTestCase(currentFile: string, includeSubdirs: boolean): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return null;
    }

    // Get all .http files in the workspace
    const httpFiles = await vscode.workspace.findFiles('**/*-req.http');
    if (httpFiles.length === 0) {
        return null;
    }

    // Convert file paths to strings for comparison
    const filePaths = httpFiles.map(file => file.fsPath);

    // Get the current directory
    const currentDir = path.dirname(currentFile);

    // Filter files based on directory if not including subdirectories
    let relevantFiles = filePaths;
    if (!includeSubdirs) {
        relevantFiles = filePaths.filter(file => path.dirname(file) === currentDir);
    }

    // Sort files to ensure consistent ordering
    relevantFiles.sort();

    // Find the current test case
    const currentHttpFile = findHttpFile(currentFile);
    if (!currentHttpFile) {
        // If we can't find the current test case, return the first one
        return relevantFiles[0];
    }

    // Find the index of the current test case
    const currentIndex = relevantFiles.findIndex(file => file === currentHttpFile);
    if (currentIndex === -1) {
        // If current file is not found in the list, return the first one
        return relevantFiles[0];
    }

    // Get the next test case, wrapping around to the beginning if necessary
    const nextIndex = (currentIndex + 1) % relevantFiles.length;
    return relevantFiles[nextIndex];
}

async function runTeaPieCommand(command: string, target: string): Promise<void> {
    const terminal = vscode.window.createTerminal('TeaPie');
    terminal.show();

    const commandStr = `teapie ${command} "${target}"`;
    terminal.sendText(commandStr);
}

async function setupCsxSupport(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder is open');
        return;
    }

    const workspacePath = workspaceFolder.uri.fsPath;

    try {
        // Create omnisharp.json
        const omnisharpConfig = {
            script: {
                enabled: true,
                defaultTargetFramework: "net7.0",
                enableScriptNuGetReferences: true
            }
        };

        await writeJsonFile(path.join(workspacePath, 'omnisharp.json'), omnisharpConfig);

        // Create global.json
        const globalConfig = {
            sdk: {
                version: "8.0.100",
                rollForward: "latestMinor"
            }
        };

        await writeJsonFile(path.join(workspacePath, 'global.json'), globalConfig);

        // Ensure .vscode directory exists
        const vscodeDir = path.join(workspacePath, '.vscode');
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir);
        }

        // Create/update settings.json
        const settingsPath = path.join(vscodeDir, 'settings.json');
        let settingsConfig: any = {};

        if (fs.existsSync(settingsPath)) {
            try {
                const content = await fs.promises.readFile(settingsPath, 'utf8');
                settingsConfig = JSON.parse(content);
            } catch (error) {
                console.error('Error reading settings.json:', error);
            }
        }

        // Update settings
        const csxSettings = {
            "omnisharp.enableRoslynAnalyzers": true,
            "omnisharp.enableEditorConfigSupport": true,
            "omnisharp.enableImportCompletion": true,
            "omnisharp.useModernNet": true,
            "csharp.referencesCodeLens.enabled": true,
            "omnisharp.enableAsyncCompletion": true,
            "omnisharp.organizeImportsOnFormat": true,
            "dotnet.completion.showCompletionItemsFromUnimportedNamespaces": true
        };

        // Merge settings
        settingsConfig = { ...settingsConfig, ...csxSettings };

        await writeJsonFile(settingsPath, settingsConfig);

        // Create/update launch.json
        const launchPath = path.join(vscodeDir, 'launch.json');
        let launchConfig: any = {
            version: "0.2.0",
            configurations: []
        };

        if (fs.existsSync(launchPath)) {
            try {
                const content = await fs.promises.readFile(launchPath, 'utf8');
                launchConfig = JSON.parse(content);
            } catch (error) {
                console.error('Error reading launch.json:', error);
            }
        }

        // Add CSX debug configuration if it doesn't exist
        const csxDebugConfig = {
            name: "Debug C# Script",
            type: "coreclr",
            request: "launch",
            program: "dotnet",
            args: [
                "script",
                "${file}"
            ],
            cwd: "${workspaceFolder}",
            stopAtEntry: false,
            console: "internalConsole"
        };

        // Check if config already exists
        const configExists = launchConfig.configurations.some((config: any) =>
            config.name === "Debug C# Script" && config.type === "coreclr");

        if (!configExists) {
            launchConfig.configurations.push(csxDebugConfig);
        }

        await writeJsonFile(launchPath, launchConfig);

        // Create a sample.csx file with common imports if it doesn't exist
        const sampleCsxPath = path.join(workspacePath, 'sample.csx');
        if (!fs.existsSync(sampleCsxPath)) {
            const sampleContent = `// Sample C# Script file
#r "nuget: TeaPie.Tool, 1.0.0"
#r "System.Net.Http"

using System;
using System.Threading.Tasks;
using TeaPie;

// Your TeaPie script goes here
var tp = new TeaPie.TeaPie();

// Example usage
tp.SetVariable("example", "Hello TeaPie!");
Console.WriteLine(tp.GetVariable<string>("example"));
`;
            await fs.promises.writeFile(sampleCsxPath, sampleContent, 'utf8');
        }

    } catch (error) {
        console.error('Error setting up CSX support:', error);
        vscode.window.showErrorMessage(`Failed to set up CSX support: ${error}`);
    }
}

async function writeJsonFile(filePath: string, content: any): Promise<void> {
    const jsonContent = JSON.stringify(content, null, 2);
    await fs.promises.writeFile(filePath, jsonContent, 'utf8');
}

export function deactivate() {
    console.log('TeaPie extension deactivated');
} 