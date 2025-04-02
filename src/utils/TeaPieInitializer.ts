import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class TeaPieInitializer {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async findGitRoot(startPath: string): Promise<string | null> {
        let currentPath = startPath;
        while (currentPath !== path.parse(currentPath).root) {
            const gitPath = path.join(currentPath, '.git');
            if (fs.existsSync(gitPath)) {
                return currentPath;
            }
            currentPath = path.dirname(currentPath);
        }
        return null;
    }

    async initializeTeaPieFolder(rootPath: string): Promise<void> {
        const teapiePath = path.join(rootPath, '.teapie');
        if (!fs.existsSync(teapiePath)) {
            fs.mkdirSync(teapiePath, { recursive: true });
            this.outputChannel.appendLine('Created .teapie folder');
        }

        const gitignorePath = path.join(rootPath, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            const teapieEntry = '.teapie';

            if (!gitignoreContent.includes(teapieEntry)) {
                const newContent = gitignoreContent + `\n${teapieEntry}`;
                fs.writeFileSync(gitignorePath, newContent);
                this.outputChannel.appendLine('Updated .gitignore with TeaPie entry');
            }
        }
    }

    async initialize(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const gitRoot = await this.findGitRoot(workspaceFolders[0].uri.fsPath);
            if (gitRoot) {
                this.outputChannel.appendLine(`Found git root at: ${gitRoot}`);
                await this.initializeTeaPieFolder(gitRoot);
            } else {
                this.outputChannel.appendLine('No git root found in workspace');
            }
        }
    }
} 