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
    private static extensionContext: vscode.ExtensionContext;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('TeaPie');
    }

    public static setExtensionContext(context: vscode.ExtensionContext) {
        VariablesProvider.extensionContext = context;
    }

    public static setEnvironmentChangeHandler(handler: vscode.Event<string>) {
        handler(async () => {
            const instance = VariablesProvider.getInstance();
            if (instance.lastLoadedPath) {
                instance.outputChannel.appendLine('\n[TeaPie] Environment changed, reloading variables...');
                await instance.loadVariables(instance.lastLoadedPath, true);
            }
        });
    }

    public static getInstance(): VariablesProvider {
        if (!VariablesProvider.instance) {
            VariablesProvider.instance = new VariablesProvider();
        }
        return VariablesProvider.instance;
    }

    private async loadEnvironmentVariables(teapiePath: string): Promise<Variables> {
        try {
            const envPath = path.join(teapiePath, 'env.json');
            this.outputChannel.appendLine(`[TeaPie] Looking for environment variables at: ${envPath}`);

            if (!fs.existsSync(envPath)) {
                this.outputChannel.appendLine('[TeaPie] No env.json file found');
                return {};
            }

            const content = await fs.promises.readFile(envPath, 'utf8');
            const envConfig = parseVariablesFile(content);

            // Get the current environment from workspace state
            const currentEnv = VariablesProvider.extensionContext?.workspaceState.get<string>('teapie.currentEnvironment') || 'local';

            this.outputChannel.appendLine(`[TeaPie] Current environment: ${currentEnv}`);

            // Get shared and environment-specific variables
            const sharedVars = envConfig.$shared || {};
            const envVars = envConfig[currentEnv] || {};

            // Convert to Variables format
            const variables: Variables = {
                GlobalVariables: {},
                EnvironmentVariables: {},
                CollectionVariables: {},
                TestCaseVariables: {}
            };

            // Merge shared and environment-specific variables into EnvironmentVariables
            // Environment-specific variables take precedence over shared variables
            variables.EnvironmentVariables = { ...sharedVars, ...envVars };

            this.outputChannel.appendLine('[TeaPie] Loaded environment variables:');
            this.outputChannel.appendLine(JSON.stringify(variables, null, 2));

            return variables;
        } catch (error) {
            this.outputChannel.appendLine(`[TeaPie] Error loading environment variables: ${error}`);
            return {};
        }
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
                
                // Even with cache, check if files were modified
                const teapiePath = await this.findTeaPieDirectory(startPath);
                if (teapiePath) {
                    const variablesPath = path.join(teapiePath, 'cache', 'variables', 'variables.json');
                    const envPath = path.join(teapiePath, 'env.json');
                    
                    let shouldReload = false;
                    
                    if (fs.existsSync(variablesPath)) {
                        const stats = fs.statSync(variablesPath);
                        if (stats.mtimeMs > this.lastModificationTime) {
                            shouldReload = true;
                        }
                    }
                    
                    if (fs.existsSync(envPath)) {
                        const stats = fs.statSync(envPath);
                        if (stats.mtimeMs > this.lastModificationTime) {
                            shouldReload = true;
                        }
                    }
                    
                    if (!shouldReload) {
                        this.outputChannel.appendLine(`[TeaPie] Using cached variables from: ${startPath}`);
                        this.outputChannel.appendLine('[TeaPie] Current cached variables:');
                        this.outputChannel.appendLine(JSON.stringify(this.variables, null, 2));
                        return this.variables;
                    }
                }
            }

            this.outputChannel.appendLine(`\n[TeaPie] Loading variables from path: ${startPath}`);
            
            const teapiePath = await this.findTeaPieDirectory(startPath);
            if (!teapiePath) {
                this.outputChannel.appendLine('[TeaPie] No .teapie directory found');
                return {};
            }

            // First load environment variables
            this.outputChannel.appendLine('\n[TeaPie] Step 1: Loading environment variables');
            const envVariables = await this.loadEnvironmentVariables(teapiePath);
            this.outputChannel.appendLine('[TeaPie] Loaded environment variables:');
            this.outputChannel.appendLine(JSON.stringify(envVariables, null, 2));

            // Then load and merge with variables.json
            const variablesPath = path.join(teapiePath, 'cache', 'variables', 'variables.json');
            this.outputChannel.appendLine(`\n[TeaPie] Step 2: Loading variables from: ${variablesPath}`);
            
            let lastRunVariables: Variables = {};
            
            if (fs.existsSync(variablesPath)) {
                const content = await fs.promises.readFile(variablesPath, 'utf8');
                lastRunVariables = parseVariablesFile(content);
                this.outputChannel.appendLine('[TeaPie] Loaded last run variables:');
                this.outputChannel.appendLine(JSON.stringify(lastRunVariables, null, 2));
            } else {
                // Create the cache/variables directory structure if it doesn't exist
                const variablesDir = path.dirname(variablesPath);
                if (!fs.existsSync(variablesDir)) {
                    fs.mkdirSync(variablesDir, { recursive: true });
                    this.outputChannel.appendLine(`[TeaPie] Created variables directory: ${variablesDir}`);
                }
                
                // Create an empty variables file
                const emptyVariables = {
                    GlobalVariables: {},
                    EnvironmentVariables: {},
                    CollectionVariables: {},
                    TestCaseVariables: {}
                };
                fs.writeFileSync(variablesPath, JSON.stringify(emptyVariables, null, 2), 'utf8');
                this.outputChannel.appendLine('[TeaPie] Created empty variables.json file with structure:');
                this.outputChannel.appendLine(JSON.stringify(emptyVariables, null, 2));
                lastRunVariables = emptyVariables;
            }

            this.outputChannel.appendLine('\n[TeaPie] Step 3: Merging variables');
            this.outputChannel.appendLine('Environment variables before merge:');
            this.outputChannel.appendLine(JSON.stringify(envVariables, null, 2));
            this.outputChannel.appendLine('Last run variables before merge:');
            this.outputChannel.appendLine(JSON.stringify(lastRunVariables, null, 2));

            // Merge variables with environment variables taking precedence
            this.variables = {
                GlobalVariables: { ...lastRunVariables.GlobalVariables, ...envVariables.GlobalVariables },
                EnvironmentVariables: { ...lastRunVariables.EnvironmentVariables, ...envVariables.EnvironmentVariables },
                CollectionVariables: { ...lastRunVariables.CollectionVariables, ...envVariables.CollectionVariables },
                TestCaseVariables: { ...lastRunVariables.TestCaseVariables, ...envVariables.TestCaseVariables }
            };
            
            // Update cache metadata
            this.lastLoadedPath = startPath;
            this.lastLoadTime = now;
            this.lastModificationTime = Math.max(
                fs.existsSync(variablesPath) ? fs.statSync(variablesPath).mtimeMs : 0,
                fs.existsSync(path.join(teapiePath, 'env.json')) ? fs.statSync(path.join(teapiePath, 'env.json')).mtimeMs : 0
            );
            
            this.outputChannel.appendLine('\n[TeaPie] Final merged variables:');
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