import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('teapie-extensions.runDirectory', async (uri: vscode.Uri) => {
        try {
            const directory = uri.fsPath;
            await runTeaPieCommand('run', directory);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to run TeaPie tests: ${error}`);
        }
    });

    let runFileDisposable = vscode.commands.registerCommand('teapie-extensions.runFile', async (uri: vscode.Uri) => {
        try {
            const filePath = uri.fsPath;
            const httpFile = findHttpFile(filePath);
            if (httpFile) {
                await runTeaPieCommand('run', httpFile);
            } else {
                vscode.window.showErrorMessage('No corresponding .http file found for this test case');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to run TeaPie test: ${error}`);
        }
    });

    let runToFileDisposable = vscode.commands.registerCommand('teapie-extensions.runToFile', async (uri: vscode.Uri) => {
        try {
            const filePath = uri.fsPath;
            const httpFile = findHttpFile(filePath);
            if (httpFile) {
                await runTeaPieCommand('run-to', httpFile);
            } else {
                vscode.window.showErrorMessage('No corresponding .http file found for this test case');
            }
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

    context.subscriptions.push(
        disposable,
        runFileDisposable,
        runToFileDisposable,
        cycleTestFilesDisposable,
        nextTestCaseDisposable,
        nextTestCaseWithSubdirsDisposable,
        generateTestCaseDisposable,
        exploreCollectionDisposable
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

export function deactivate() {} 