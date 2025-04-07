import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class TeaPieInitializer {
    private outputChannel: vscode.OutputChannel;
    private initialized: boolean = false;

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

        // Create required subdirectories
        const subdirs = ['reports', 'cache', 'temp'];
        for (const subdir of subdirs) {
            const subdirPath = path.join(teapiePath, subdir);
            if (!fs.existsSync(subdirPath)) {
                fs.mkdirSync(subdirPath, { recursive: true });
                this.outputChannel.appendLine(`Created .teapie/${subdir} folder`);
            }
        }

        const gitignorePath = path.join(rootPath, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            const teapieEntries = [
                '.teapie/reports/',
                '.teapie/cache/',
                '.teapie/temp/'
            ];

            let needsUpdate = false;
            for (const entry of teapieEntries) {
                if (!gitignoreContent.includes(entry)) {
                    needsUpdate = true;
                    break;
                }
            }

            if (needsUpdate) {
                const newContent = gitignoreContent + '\n' + teapieEntries.join('\n');
                fs.writeFileSync(gitignorePath, newContent);
                this.outputChannel.appendLine('Updated .gitignore with TeaPie entries');
            }
        }
    }

    // Initialize TeaPie in the workspace
    async initialize(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const gitRoot = await this.findGitRoot(workspaceFolders[0].uri.fsPath);
            if (gitRoot) {
                this.outputChannel.appendLine(`Found git root at: ${gitRoot}`);
                await this.initializeTeaPieFolder(gitRoot);
            } else {
                this.outputChannel.appendLine('No git root found in workspace');
                // If no git root is found, initialize at workspace root
                await this.initializeTeaPieFolder(workspaceFolders[0].uri.fsPath);
            }
        }
    }

    /**
     * Ensures TeaPie is initialized if needed
     * Returns true if initialization was performed, false if already initialized
     * 
     * This method is explicitly called by TeaPie commands that require initialization
     */
    async ensureInitialized(): Promise<boolean> {
        if (this.initialized) {
            return false;
        }
        
        // Ask user for confirmation before creating .teapie folder
        const choice = await vscode.window.showInformationMessage(
            'This command will initialize TeaPie in your workspace. Continue?',
            'Yes', 'No'
        );
        
        if (choice === 'Yes') {
            await this.initialize();
            this.initialized = true;
            return true;
        } else {
            // User declined initialization
            vscode.window.showInformationMessage('TeaPie initialization canceled');
            return false;
        }
    }

    /**
     * Checks if a valid TeaPie directory exists in the given path hierarchy
     */
    async hasTeaPieDirectory(startPath: string): Promise<boolean> {
        let currentPath = startPath;
        
        while (currentPath !== path.dirname(currentPath)) {
            const potentialTeapiePath = path.join(currentPath, '.teapie');
            
            if (fs.existsSync(potentialTeapiePath)) {
                return true;
            }
            
            currentPath = path.dirname(currentPath);
        }
        
        return false;
    }
} 