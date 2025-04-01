import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface Variables {
    GlobalVariables?: { [key: string]: string };
    EnvironmentVariables?: { [key: string]: string };
    CollectionVariables?: { [key: string]: any };
    TestCaseVariables?: { [key: string]: any };
}

export class VariablesProvider {
    private static instance: VariablesProvider;
    private variables: Variables = {};
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('TeaPie Variables');
    }

    public static getInstance(): VariablesProvider {
        if (!VariablesProvider.instance) {
            VariablesProvider.instance = new VariablesProvider();
        }
        return VariablesProvider.instance;
    }

    public async loadVariables(startPath: string): Promise<Variables> {
        try {
            this.outputChannel.appendLine(`\n[TeaPie] Loading variables from path: ${startPath}`);
            
            // Find the .teapie directory by traversing up from the start path
            let currentPath = startPath;
            let teapiePath = '';
            
            while (currentPath !== path.dirname(currentPath)) {
                const potentialTeapiePath = path.join(currentPath, '.teapie');
                this.outputChannel.appendLine(`[TeaPie] Checking for .teapie in: ${potentialTeapiePath}`);
                if (fs.existsSync(potentialTeapiePath)) {
                    teapiePath = potentialTeapiePath;
                    this.outputChannel.appendLine(`[TeaPie] Found .teapie directory at: ${teapiePath}`);
                    break;
                }
                currentPath = path.dirname(currentPath);
            }

            if (!teapiePath) {
                this.outputChannel.appendLine('[TeaPie] No .teapie directory found');
                return {};
            }

            // Update path to include cache/variables subdirectory
            const variablesPath = path.join(teapiePath, 'cache', 'variables', 'variables.json');
            this.outputChannel.appendLine(`[TeaPie] Looking for variables at: ${variablesPath}`);
            
            if (!fs.existsSync(variablesPath)) {
                this.outputChannel.appendLine('[TeaPie] No variables.json file found');
                return {};
            }

            const content = fs.readFileSync(variablesPath, 'utf8');
            this.variables = JSON.parse(content);
            
            this.outputChannel.appendLine('[TeaPie] Loaded variables:');
            this.outputChannel.appendLine(JSON.stringify(this.variables, null, 2));
            
            return this.variables;
        } catch (error) {
            this.outputChannel.appendLine(`[TeaPie] Error loading variables: ${error}`);
            console.error('Error loading variables:', error);
            return {};
        }
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

    public showOutput() {
        this.outputChannel.show();
    }
} 