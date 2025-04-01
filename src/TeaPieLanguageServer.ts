import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { XmlDocMember, XmlDocParser } from './XmlDocParser';

// Create output channel for logging
let outputChannel: vscode.OutputChannel;

// Remove this import if not used
// import { fileURLToPath } from 'url';

export class TeaPieLanguageServer {
    private static instance: TeaPieLanguageServer;
    private context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];
    private xmlDocs: XmlDocMember[] = [];

    // Add this map to explicitly handle TeaPie method names
    private teaPieMethodMap: {[key: string]: string} = {
        'M:TeaPie.TeaPie.GetVariable``1(System.String,``0)': 'GetVariable',
        'M:TeaPie.TeaPie.SetVariable``1(System.String,``0,System.String[])': 'SetVariable',
        'M:TeaPie.TeaPie.SetEnvironment(System.String)': 'SetEnvironment',
        'P:TeaPie.TeaPie.Request': 'Request',
        'P:TeaPie.TeaPie.Requests': 'Requests',
        'P:TeaPie.TeaPie.Response': 'Response',
        'P:TeaPie.TeaPie.Responses': 'Responses',
        'M:TeaPie.TeaPie.Test(System.String,System.Action,System.Boolean)': 'Test',
        'M:TeaPie.TeaPie.Test(System.String,System.Func{System.Threading.Tasks.Task},System.Boolean)': 'Test',
        'M:TeaPie.TeaPie.Log(System.String)': 'Log',
        'M:TeaPie.TeaPie.Assert(System.Boolean,System.String)': 'Assert',
        'M:TeaPie.TeaPie.Equal(System.Object,System.Object)': 'Equal'
    };

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        outputChannel = vscode.window.createOutputChannel('TeaPie Language Server');
        outputChannel.show(true);
    }

    public static getInstance(context: vscode.ExtensionContext): TeaPieLanguageServer {
        if (!TeaPieLanguageServer.instance) {
            TeaPieLanguageServer.instance = new TeaPieLanguageServer(context);
        }
        return TeaPieLanguageServer.instance;
    }

    public async initialize(): Promise<void> {
        try {
            // Load XML documentation
            outputChannel.appendLine('[TeaPie] Initializing TeaPie Language Server...');
            await this.loadXmlDocumentation();
            
            if (this.xmlDocs.length > 0) {
                outputChannel.appendLine(`[TeaPie] XML documentation loaded with ${this.xmlDocs.length} members`);
            } else {
                outputChannel.appendLine('[TeaPie] Failed to load XML documentation');
            }

            // Register completion provider for TeaPie-specific features
            this.disposables.push(
                vscode.languages.registerCompletionItemProvider(
                    { scheme: 'file', pattern: '**/*.csx' },
                    {
                        provideCompletionItems: async (
                            document: vscode.TextDocument,
                            position: vscode.Position
                        ): Promise<vscode.CompletionList | undefined> => {
                            const line = document.lineAt(position.line);
                            const linePrefix = line.text.substring(0, position.character);
                            
                            outputChannel.appendLine(`[TeaPie] Getting completions for line: "${linePrefix}"`);

                            // Handle empty completions
                            if (this.xmlDocs.length === 0) {
                                outputChannel.appendLine('[TeaPie] No XML documentation available, attempting to load...');
                                await this.loadXmlDocumentation();
                                
                                if (this.xmlDocs.length === 0) {
                                    outputChannel.appendLine('[TeaPie] Still no documentation available, returning default completions');
                                    return this.getDefaultCompletions();
                                }
                            }

                            // Get completion items based on context
                            let completionItems: vscode.CompletionItem[] = [];

                            // If we're after 'tp.', show TeaPie instance methods and properties
                            if (linePrefix.endsWith('tp.')) {
                                outputChannel.appendLine('[TeaPie] Providing completions for tp.');
                                completionItems = await this.getTeaPieMembers();
                                
                                if (completionItems.length === 0) {
                                    outputChannel.appendLine('[TeaPie] No TeaPie members found, returning default completions');
                                    return this.getDefaultCompletions();
                                }
                            }
                            // If we're after 'tp' (without dot), also provide completions
                            else if (linePrefix.trim() === 'tp') {
                                outputChannel.appendLine('[TeaPie] Providing completions for just "tp"');
                                completionItems = await this.getTeaPieMembers();
                            }
                            // If we're after a dot, try to provide context-aware completions
                            else if (linePrefix.endsWith('.')) {
                                const beforeDot = linePrefix.slice(0, -1).trim();
                                outputChannel.appendLine(`[TeaPie] Providing completions for context: "${beforeDot}"`);
                                const filteredMembers = XmlDocParser.getCompletionItems(this.xmlDocs, beforeDot);
                                completionItems = filteredMembers.map(member => this.createCompletionItem(member));
                            }

                            if (completionItems.length === 0) {
                                outputChannel.appendLine('[TeaPie] No specific completions found, letting OmniSharp handle it');
                                return undefined;
                            }

                            outputChannel.appendLine(`[TeaPie] Returning ${completionItems.length} completion items`);
                            return new vscode.CompletionList(completionItems, true);
                        }
                    },
                    '.' // Trigger completion on dot
                )
            );

            outputChannel.appendLine('[TeaPie] TeaPie Language Server initialized successfully');
        } catch (error) {
            outputChannel.appendLine(`[TeaPie] Failed to initialize TeaPie Language Server: ${error}`);
            throw error;
        }
    }

    public async loadXmlDocumentation(): Promise<void> {
        try {
            // Try to find TeaPie.dll in common locations
            const possibleLocations = [
                // .NET tools location (most likely)
                path.join(process.env.USERPROFILE || '', '.dotnet', 'tools', '.store', 'teapie.tool'),
                path.join(process.env.USERPROFILE || '', '.dotnet', 'tools'),
                // NuGet packages location (fallback)
                path.join(process.env.USERPROFILE || '', '.nuget', 'packages', 'teapie.tool'),
                path.join(process.env.USERPROFILE || '', '.nuget', 'packages', 'teapie'),
            ];

            outputChannel.appendLine('[TeaPie] Searching for TeaPie XML documentation in locations: ' + JSON.stringify(possibleLocations));

            let allDocs: XmlDocMember[] = [];

            for (const baseLocation of possibleLocations) {
                outputChannel.appendLine(`[TeaPie] Checking location: ${baseLocation}`);
                
                if (fs.existsSync(baseLocation)) {
                    outputChannel.appendLine(`[TeaPie] Location exists: ${baseLocation}`);
                    
                    // Use recursive directory search
                    const searchDir = async (dir: string): Promise<string[]> => {
                        try {
                            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                            const filesPromises = entries.map(async entry => {
                                const res = path.resolve(dir, entry.name);
                                return entry.isDirectory() ? searchDir(res) : [res];
                            });
                            
                            const files = await Promise.all(filesPromises);
                            return files.flat();
                        } catch (err) {
                            outputChannel.appendLine(`[TeaPie] Error reading directory ${dir}: ${err}`);
                            return [];
                        }
                    };

                    const files = await searchDir(baseLocation);
                    outputChannel.appendLine(`[TeaPie] Found ${files.length} files in directory`);
                    
                    // Look for all TeaPie XML files
                    const xmlFiles = files.filter(f => {
                        const lowerName = f.toLowerCase();
                        return lowerName.includes('teapie') && lowerName.endsWith('.xml');
                    });
                    outputChannel.appendLine(`[TeaPie] Found ${xmlFiles.length} potential XML documentation files: ${JSON.stringify(xmlFiles)}`);
                    
                    // Try to load documentation from each file
                    for (const xmlFile of xmlFiles) {
                        outputChannel.appendLine(`[TeaPie] Loading documentation from: ${xmlFile}`);
                        try {
                            const docs = await XmlDocParser.loadXmlDocs(xmlFile);
                            if (docs.length > 0) {
                                outputChannel.appendLine(`[TeaPie] Successfully loaded ${docs.length} documentation members from ${xmlFile}`);
                                allDocs = [...allDocs, ...docs];
                            } else {
                                outputChannel.appendLine(`[TeaPie] No documentation members found in ${xmlFile}`);
                            }
                        } catch (error) {
                            outputChannel.appendLine(`[TeaPie] Failed to load documentation from ${xmlFile}: ${error}`);
                        }
                    }

                    if (allDocs.length > 0) {
                        break; // Stop searching if we found documentation
                    }
                } else {
                    outputChannel.appendLine(`[TeaPie] Location does not exist: ${baseLocation}`);
                }
            }

            this.xmlDocs = allDocs;

            if (this.xmlDocs.length === 0) {
                outputChannel.appendLine('[TeaPie] No XML documentation found in any of the searched locations');
            } else {
                outputChannel.appendLine(`[TeaPie] Successfully loaded ${this.xmlDocs.length} total documentation members`);
                // Log first few members to verify content
                outputChannel.appendLine('[TeaPie] Sample members: ' + JSON.stringify(this.xmlDocs.slice(0, 3).map(m => m.name)));
                
                // Check for TeaPie.TeaPie members specifically
                const teaPieMembers = XmlDocParser.getMembersByType(this.xmlDocs, 'TeaPie.TeaPie');
                outputChannel.appendLine(`[TeaPie] Found ${teaPieMembers.length} TeaPie.TeaPie members`);
                if (teaPieMembers.length > 0) {
                    outputChannel.appendLine('[TeaPie] Sample TeaPie members: ' + JSON.stringify(teaPieMembers.slice(0, 3).map(m => m.name)));
                }
            }
        } catch (error) {
            outputChannel.appendLine(`[TeaPie] Failed to load XML documentation: ${error}`);
            this.xmlDocs = [];
        }
    }

    private createCompletionItem(member: XmlDocMember): vscode.CompletionItem {
        // Use our explicit map for TeaPie methods to get the correct display name
        let displayName = '';
        
        // Check if we have an explicit mapping for this member
        if (this.teaPieMethodMap[member.name]) {
            displayName = this.teaPieMethodMap[member.name];
            outputChannel.appendLine(`[TeaPie] Using explicit name mapping for ${member.name} -> ${displayName}`);
        }
        // Handle different member types if not in our map
        else if (member.name.startsWith('M:')) {
            // For extension methods, we need to handle them specially
            if (member.name.includes('(TeaPie.TeaPie,') || member.name.includes('(TeaPie.TeaPie)')) {
                // Extract the method name from the extension method
                const methodNameMatch = /\.([^.]+)\(TeaPie\.TeaPie/.exec(member.name);
                if (methodNameMatch && methodNameMatch[1]) {
                    displayName = methodNameMatch[1];
                    outputChannel.appendLine(`[TeaPie] Extracted extension method name "${displayName}" from ${member.name}`);
                } else {
                    // Fallback for extension methods
                    const parts = member.name.split('.');
                    const methodPart = parts[parts.length - 1];
                    displayName = methodPart.split('(')[0].replace(/^M:/, '');
                    outputChannel.appendLine(`[TeaPie] Fallback extension method name "${displayName}" from ${member.name}`);
                }
            } 
            // Regular methods
            else {
                const nameParts = member.name.split('.');
                const methodName = nameParts[nameParts.length - 1];
                
                // Extract the name up to any backtick or parenthesis
                const methodMatch = methodName.match(/M:([^`(]+)/);
                if (methodMatch && methodMatch[1]) {
                    displayName = methodMatch[1];
                } else {
                    // Fallback
                    displayName = methodName.replace(/M:/, '').split('(')[0].split('`')[0];
                }
                
                outputChannel.appendLine(`[TeaPie] Extracted method name "${displayName}" from ${member.name}`);
            }
        } else if (member.name.startsWith('P:')) {
            // For properties, just get the name after the last dot
            const propertyParts = member.name.split('.');
            displayName = propertyParts[propertyParts.length - 1].replace(/P:/, '');
            
            outputChannel.appendLine(`[TeaPie] Extracted property name "${displayName}" from ${member.name}`);
        } else {
            // For other types, use the last part of the name
            const parts = member.name.split('.');
            displayName = parts[parts.length - 1]
                .replace(/^[TMP]:/, '')
                .replace(/\(.+\)$/, '')
                .split('`')[0]; // Remove generic backticks
                
            outputChannel.appendLine(`[TeaPie] Extracted other name "${displayName}" from ${member.name}`);
        }
        
        outputChannel.appendLine(`[TeaPie] Final display name for ${member.name} is "${displayName}"`);

        // Create the completion item with the correct kind
        const kind = member.name.startsWith('M:') 
            ? vscode.CompletionItemKind.Method 
            : member.name.startsWith('P:') 
                ? vscode.CompletionItemKind.Property
                : vscode.CompletionItemKind.Class;

        const item = new vscode.CompletionItem(displayName, kind);
        
        // Make our completions have highest priority by setting sortText
        item.sortText = '!!' + displayName; // '!!' sorts before '0' or anything else
        
        // Add detailed information
        if (member.name.startsWith('M:')) {
            // For methods, add signature info
            const paramInfo = this.extractParameterInfo(member.name);
            item.detail = `${displayName}(${paramInfo})`;
            
            if (member.summary) {
                item.detail += ` - ${member.summary}`;
            }
        } else {
            // For non-methods
            item.detail = member.summary;
        }
        
        // Add full documentation
        item.documentation = new vscode.MarkdownString(this.formatDocumentation(member));
        
        return item;
    }
    
    private extractParameterInfo(methodName: string): string {
        // Extract parameter types from method signature
        const match = methodName.match(/\(([^)]*)\)/);
        if (!match || !match[1]) {
            return '';
        }
        
        // For extension methods, skip the first parameter (TeaPie.TeaPie)
        let params = match[1].split(',');
        if (params[0].trim() === 'TeaPie.TeaPie') {
            params = params.slice(1);
        }
        
        return params
            .map(param => {
                // Clean up parameter type names
                let type = param.trim().split(' ').pop() || '';
                type = type.replace('System.', '');
                type = type.replace('``0', 'T');
                type = type.replace('``1', 'U');
                return type;
            })
            .join(', ');
    }

    private formatDocumentation(member: XmlDocMember): string {
        const parts: string[] = [];

        if (member.summary) {
            parts.push(member.summary);
        }

        if (member.params && member.params.length > 0) {
            parts.push('\n\n**Parameters:**');
            for (const param of member.params) {
                parts.push(`- \`${param.name}\`: ${param.description}`);
            }
        }

        if (member.returns) {
            parts.push(`\n\n**Returns:** ${member.returns}`);
        }

        if (member.remarks) {
            parts.push(`\n\n**Remarks:** ${member.remarks}`);
        }

        if (member.example) {
            parts.push(`\n\n**Example:**\n\`\`\`csharp\n${member.example}\n\`\`\``);
        }

        return parts.join('\n');
    }

    private getDefaultCompletions(): vscode.CompletionList {
        outputChannel.appendLine('[TeaPie] Providing default TeaPie completions');
        
        const completions = [
            {
                label: 'SetEnvironment',
                kind: vscode.CompletionItemKind.Method,
                description: 'Sets the current environment for test execution'
            },
            {
                label: 'Test',
                kind: vscode.CompletionItemKind.Method,
                description: 'Defines a test case to execute'
            },
            {
                label: 'GetVariable',
                kind: vscode.CompletionItemKind.Method,
                description: 'Gets a variable value from the context'
            },
            {
                label: 'SetVariable',
                kind: vscode.CompletionItemKind.Method,
                description: 'Sets a variable value in the context'
            },
            {
                label: 'Log',
                kind: vscode.CompletionItemKind.Method,
                description: 'Logs a message to the output'
            },
            {
                label: 'Requests',
                kind: vscode.CompletionItemKind.Property,
                description: 'Collection of HTTP requests'
            },
            {
                label: 'Responses',
                kind: vscode.CompletionItemKind.Property,
                description: 'Collection of HTTP responses'
            }
        ].map(item => {
            const completion = new vscode.CompletionItem(item.label, item.kind);
            completion.detail = item.description;
            return completion;
        });
        
        return new vscode.CompletionList(completions, true);
    }

    // Add this method to handle special case filtering for TeaPie members
    private async getTeaPieMembers(): Promise<vscode.CompletionItem[]> {
        outputChannel.appendLine('[TeaPie] Getting TeaPie members for completion');
        
        if (this.xmlDocs.length === 0) {
            return this.getDefaultCompletions().items;
        }
        
        // Get only top-level TeaPie members without internal implementation details
        const teaPieMembers = this.xmlDocs.filter(m => {
            // Direct TeaPie.TeaPie members
            const isDirectTeaPieMember = m.name.includes('TeaPie.TeaPie.') && 
                !m.name.includes('.Internal.') && 
                !m.name.includes('Implementation') && 
                !m.name.includes('<>') && 
                !m.name.includes('__');
            
            // Also include extension methods for TeaPie
            // These have format like: M:TeaPie.Extensions.TeaPieExtensionClass.Method(TeaPie.TeaPie,...)
            const isExtensionMethod = m.name.startsWith('M:') && 
                m.name.includes('.TeaPie') && 
                // Check if first parameter is TeaPie.TeaPie
                (m.name.includes('(TeaPie.TeaPie,') || m.name.includes('(TeaPie.TeaPie)'));
            
            return isDirectTeaPieMember || isExtensionMethod;
        });
        
        outputChannel.appendLine(`[TeaPie] Found ${teaPieMembers.length} TeaPie members after filtering`);
        teaPieMembers.forEach(m => outputChannel.appendLine(`[TeaPie] Included member: ${m.name}`));
        
        // Transform to completion items
        const completionItems = teaPieMembers.map(member => this.createCompletionItem(member));
        
        // If we found some items from XML, return them
        if (completionItems.length > 0) {
            return completionItems;
        }
        
        // Fallback to default completions
        return this.getDefaultCompletions().items;
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        XmlDocParser.dispose();
    }
} 