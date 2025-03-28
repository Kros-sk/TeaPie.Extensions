import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class TestRenameProvider {
    constructor(private context: vscode.ExtensionContext) { }

    async shiftTestNames(startPath: string, startNumber: number, shiftAmount: number) {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            const basePath = workspaceFolder.uri.fsPath;
            const fullPath = path.join(basePath, startPath);

            // Check if path exists
            if (!fs.existsSync(fullPath)) {
                throw new Error(`Path ${fullPath} does not exist`);
            }

            // Get all files in the directory
            const files = fs.readdirSync(fullPath);

            // Filter and sort files that match the pattern (number followed by dot and text)
            const testFiles = files
                .filter(file => /^\d+\./.test(file))
                .sort((a, b) => {
                    const numA = parseInt(a.split('.')[0]);
                    const numB = parseInt(b.split('.')[0]);
                    return numA - numB;
                });

            // Find files that need to be renamed
            const filesToRename = testFiles.filter(file => {
                const fileNumber = parseInt(file.split('.')[0]);
                return fileNumber >= startNumber;
            });

            // Rename files in reverse order to avoid conflicts
            for (let i = filesToRename.length - 1; i >= 0; i--) {
                const oldName = filesToRename[i];
                const oldNumber = parseInt(oldName.split('.')[0]);
                const newNumber = oldNumber + shiftAmount;
                const newName = oldName.replace(/^\d+/, newNumber.toString());

                const oldPath = path.join(fullPath, oldName);
                const newPath = path.join(fullPath, newName);

                fs.renameSync(oldPath, newPath);
                console.log(`Renamed ${oldName} to ${newName}`);
            }

            vscode.window.showInformationMessage(`Successfully shifted ${filesToRename.length} test files`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error shifting test names: ${error}`);
            throw error;
        }
    }

    async shiftSubsequentTests(uri: vscode.Uri) {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }

            const relativePath = vscode.workspace.asRelativePath(uri);
            const fullPath = uri.fsPath;

            // If it's a file, get its directory
            const targetPath = fs.statSync(fullPath).isFile() ? path.dirname(fullPath) : fullPath;

            // Get all files in the directory
            const files = fs.readdirSync(targetPath);

            // Filter and sort files that match the pattern (number followed by dot and text)
            const testFiles = files
                .filter(file => /^\d+\./.test(file))
                .sort((a, b) => {
                    const numA = parseInt(a.split('.')[0]);
                    const numB = parseInt(b.split('.')[0]);
                    return numA - numB;
                });

            // If it's a file, find its number
            let startNumber: number;
            if (fs.statSync(fullPath).isFile()) {
                const fileName = path.basename(fullPath);
                const match = fileName.match(/^(\d+)\./);
                if (!match) {
                    throw new Error('Selected file does not follow the numbered test case pattern');
                }
                startNumber = parseInt(match[1]);
            } else {
                // If it's a directory, find the lowest number in the directory
                startNumber = Math.min(...testFiles.map(file => parseInt(file.split('.')[0])));
            }

            // Find files that need to be renamed
            const filesToRename = testFiles.filter(file => {
                const fileNumber = parseInt(file.split('.')[0]);
                return fileNumber >= startNumber;
            });

            // Rename files in reverse order to avoid conflicts
            for (let i = filesToRename.length - 1; i >= 0; i--) {
                const oldName = filesToRename[i];
                const oldNumber = parseInt(oldName.split('.')[0]);
                const newNumber = oldNumber + 1;
                const newName = oldName.replace(/^\d+/, newNumber.toString());

                const oldPath = path.join(targetPath, oldName);
                const newPath = path.join(targetPath, newName);

                fs.renameSync(oldPath, newPath);
                console.log(`Renamed ${oldName} to ${newName}`);
            }

            vscode.window.showInformationMessage(`Successfully shifted ${filesToRename.length} test files`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error shifting test names: ${error}`);
            throw error;
        }
    }
} 