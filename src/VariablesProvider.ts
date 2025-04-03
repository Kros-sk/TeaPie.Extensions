import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { parseVariablesFile } from './utils/variablesParser';

export interface Variables {
    TestCaseVariables?: { [key: string]: any };
    CollectionVariables?: { [key: string]: any };
    EnvironmentVariables?: { [key: string]: any };
    GlobalVariables?: { [key: string]: any };
}

export class VariablesProvider {
    private static instance: VariablesProvider;
    private variables: Variables = {};
    private outputChannel: vscode.OutputChannel;
    private lastLoadedPath: string | undefined;
    private lastLoadTime: number = 0;
    private lastModificationTime: number = 0;
    private readonly CACHE_TIMEOUT = 300000; // 5 minút, keďže máme kontrolu mtimeMs

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('TeaPie');
    }

    public static getInstance(): VariablesProvider {
        if (!VariablesProvider.instance) {
            VariablesProvider.instance = new VariablesProvider();
        }
        return VariablesProvider.instance;
    }

    public async loadVariables(startPath: string, forceReload: boolean = false): Promise<Variables> {
        try {
            const now = Date.now();
            
            // Return cached variables if:
            // 1. The path is the same
            // 2. Cache hasn't expired
            // 3. Force reload is not requested
            // 4. File hasn't been modified
            if (!forceReload && 
                this.lastLoadedPath === startPath && 
                (now - this.lastLoadTime) < this.CACHE_TIMEOUT) {
                
                // Even with cache, check if file was modified
                const teapiePath = await this.findTeaPieDirectory(startPath);
                if (teapiePath) {
                    const variablesPath = path.join(teapiePath, 'cache', 'variables', 'variables.json');
                    if (fs.existsSync(variablesPath)) {
                        const stats = fs.statSync(variablesPath);
                        if (stats.mtimeMs <= this.lastModificationTime) {
                            this.outputChannel.appendLine(`[TeaPie] Using cached variables from: ${startPath}`);
                            return this.variables;
                        }
                    }
                }
            }

            this.outputChannel.appendLine(`\n[TeaPie] Loading variables from path: ${startPath}`);
            
            const teapiePath = await this.findTeaPieDirectory(startPath);
            if (!teapiePath) {
                this.outputChannel.appendLine('[TeaPie] No .teapie directory found');
                return {};
            }

            const variablesPath = path.join(teapiePath, 'cache', 'variables', 'variables.json');
            this.outputChannel.appendLine(`[TeaPie] Looking for variables at: ${variablesPath}`);
            
            if (!fs.existsSync(variablesPath)) {
                // Create the cache/variables directory structure if it doesn't exist
                const variablesDir = path.dirname(variablesPath);
                if (!fs.existsSync(variablesDir)) {
                    fs.mkdirSync(variablesDir, { recursive: true });
                    this.outputChannel.appendLine(`[TeaPie] Created variables directory: ${variablesDir}`);
                }
                
                // Create an empty variables file
                fs.writeFileSync(variablesPath, '{}', 'utf8');
                this.outputChannel.appendLine('[TeaPie] Created empty variables.json file');
                
                this.variables = {};
                this.lastLoadedPath = startPath;
                this.lastLoadTime = now;
                this.lastModificationTime = fs.statSync(variablesPath).mtimeMs;
                
                return {};
            }

            const stats = fs.statSync(variablesPath);
            const content = await fs.promises.readFile(variablesPath, 'utf8');
            this.variables = parseVariablesFile(content);
            
            // Update cache metadata
            this.lastLoadedPath = startPath;
            this.lastLoadTime = now;
            this.lastModificationTime = stats.mtimeMs;
            
            this.outputChannel.appendLine('[TeaPie] Loaded variables:');
            this.outputChannel.appendLine(JSON.stringify(this.variables, null, 2));
            
            return this.variables;
        } catch (error) {
            this.outputChannel.appendLine(`[TeaPie] Error loading variables: ${error}`);
            return {};
        }
    }

    private async findTeaPieDirectory(startPath: string): Promise<string | undefined> {
        let currentPath = startPath;
        
        while (currentPath !== path.dirname(currentPath)) {
            const potentialTeapiePath = path.join(currentPath, '.teapie');
            this.outputChannel.appendLine(`[TeaPie] Checking for .teapie in: ${potentialTeapiePath}`);
            
            if (fs.existsSync(potentialTeapiePath)) {
                this.outputChannel.appendLine(`[TeaPie] Found .teapie directory at: ${potentialTeapiePath}`);
                return potentialTeapiePath;
            }
            
            currentPath = path.dirname(currentPath);
        }
        
        return undefined;
    }

    public getVariables(): Variables {
        return this.variables;
    }

    public getVariableValue(variableName: string): string | undefined {
        // Search in all variable sections in order of precedence
        const sections = ['TestCaseVariables', 'CollectionVariables', 'EnvironmentVariables', 'GlobalVariables'];
        
        for (const section of sections) {
            const sectionVars = this.variables[section as keyof Variables];
            if (sectionVars && variableName in sectionVars) {
                this.outputChannel.appendLine(`[TeaPie] Found variable '${variableName}' in ${section}: ${sectionVars[variableName]}`);
                return String(sectionVars[variableName]);
            }
        }
        
        this.outputChannel.appendLine(`[TeaPie] Variable '${variableName}' not found in any section`);
        return undefined;
    }

    public replaceVariables(text: string, showValues: boolean = true): string {
        this.outputChannel.appendLine(`\n[TeaPie] Replacing variables in text (showValues=${showValues}):`);
        this.outputChannel.appendLine(`[TeaPie] Original text: ${text}`);
        
        const result = text.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
            if (!showValues) {
                this.outputChannel.appendLine(`[TeaPie] Keeping original variable name: ${match}`);
                return match; // Return the original {{varName}} format
            }
            const value = this.getVariableValue(varName.trim());
            const replacement = value !== undefined ? value : match;
            this.outputChannel.appendLine(`[TeaPie] Replacing ${match} with: ${replacement}`);
            return replacement;
        });

        this.outputChannel.appendLine(`[TeaPie] Result: ${result}`);
        return result;
    }

    public showOutput(): void {
        this.outputChannel.show();
    }
} 