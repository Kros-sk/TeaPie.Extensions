import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { parseString } from 'xml2js';
import { promisify } from 'util';

const parseXmlString = promisify(parseString);

interface XmlDocParam {
    $: { name: string };
    _: string;
}

interface XmlDocMemberData {
    $: { name: string };
    summary?: string[];
    remarks?: string[];
    returns?: string[];
    param?: XmlDocParam[];
    example?: string[];
}

interface XmlDocResult {
    doc?: {
        assembly?: {
            name?: string[];
        };
        members?: [{
            member?: XmlDocMemberData[];
        }];
    };
}

export interface XmlDocMember {
    name: string;
    summary?: string;
    remarks?: string;
    returns?: string;
    params?: Array<{
        name: string;
        description: string;
    }>;
    example?: string;
}

export class XmlDocParser {
    private static cache: Map<string, XmlDocMember[]> = new Map();
    private static outputChannel: vscode.OutputChannel;

    private static getOutputChannel(): vscode.OutputChannel {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('TeaPie Documentation');
        }
        return this.outputChannel;
    }

    private static log(message: string) {
        const channel = this.getOutputChannel();
        const timestamp = new Date().toISOString();
        channel.appendLine(`[${timestamp}] ${message}`);
    }

    private static cleanXmlText(text: any): string {
        if (typeof text !== 'string') {
            this.outputChannel?.appendLine(`[XmlDocParser] Received non-string value in cleanXmlText: ${typeof text}`);
            return String(text || '');
        }
        return text
            .replace(/\s+/g, ' ')
            .trim();
    }

    private static processXmlValue(value: any): string {
        if (!value) {
            return '';
        }

        // Handle array of values (xml2js often returns arrays)
        if (Array.isArray(value)) {
            return value.map(v => this.cleanXmlText(v)).join(' ');
        }

        return this.cleanXmlText(value);
    }

    public static async loadXmlDocs(xmlPath: string): Promise<XmlDocMember[]> {
        try {
            // Check cache first
            if (this.cache.has(xmlPath)) {
                this.outputChannel?.appendLine(`[XmlDocParser] Using cached documentation for ${xmlPath}`);
                const cached = this.cache.get(xmlPath);
                if (cached) {
                    return cached;
                }
            }

            const xmlContent = await fs.promises.readFile(xmlPath, 'utf8');

            if (xmlContent.length === 0) {
                return [];
            }

            const result = await parseXmlString(xmlContent) as XmlDocResult;

            const members: XmlDocMember[] = [];

            if (!result.doc?.members?.[0]?.member) {
                return [];
            }

            const totalMembers = result.doc.members[0].member.length;

            for (const member of result.doc.members[0].member) {
                try {
                    if (!member.$ || !member.$.name) {
                        continue;
                    }

                    const docMember: XmlDocMember = {
                        name: member.$.name
                    };

                    // Process summary
                    if (member.summary?.[0]) {
                        docMember.summary = this.processXmlValue(member.summary[0]);
                    }

                    // Process remarks
                    if (member.remarks?.[0]) {
                        docMember.remarks = this.processXmlValue(member.remarks[0]);
                    }

                    // Process returns
                    if (member.returns?.[0]) {
                        docMember.returns = this.processXmlValue(member.returns[0]);
                    }

                    // Process parameters
                    if (member.param) {
                        docMember.params = member.param.map(p => ({
                            name: p.$.name,
                            description: this.processXmlValue(p._)
                        }));
                    }

                    // Process example
                    if (member.example?.[0]) {
                        docMember.example = this.processXmlValue(member.example[0]);
                    }

                    members.push(docMember);
                } catch (memberError) {
                    // Silently continue on member processing errors
                }
            }

            // Cache the results
            this.cache.set(xmlPath, members);
            return members;

        } catch (error) {
            console.error(`[XmlDocParser] Error processing file ${xmlPath}:`, error);
            if (error instanceof Error) {
                console.error(`[XmlDocParser] Error stack:`, error.stack);
            }
            return [];
        }
    }

    public static getMemberDoc(members: XmlDocMember[], memberName: string): XmlDocMember | undefined {
        // Normalize the member name to handle different formats
        const normalizedName = memberName.replace(/\s+/g, '');
        
        const member = members.find(m => {
            const normalizedMemberName = m.name.replace(/\s+/g, '');
            return normalizedMemberName === normalizedName;
        });

        console.log(`[XmlDocParser] ${member ? 'Found' : 'Did not find'} documentation for member: ${memberName}`);
        return member;
    }

    public static getCompletionItems(members: XmlDocMember[], prefix: string): XmlDocMember[] {
        console.log(`[XmlDocParser] Getting completion items for prefix: "${prefix}"`);
        
        // Handle special cases
        if (prefix === 'tp') {
            // If prefix is exactly 'tp', we want TeaPie methods
            return this.getMembersByType(members, 'TeaPie.TeaPie');
        }
        
        // Filter members that match the current context
        const contextMembers = members.filter(m => {
            // Only include TeaPie members and extensions
            if (!m.name.includes('TeaPie.')) {
                return false;
            }

            // Skip internal members
            if (m.name.includes('Internal') || m.name.includes('Private')) {
                return false;
            }

            // If there's a prefix, filter by it
            if (prefix) {
                // Get the simple name without namespace
                const memberParts = m.name.split('.');
                const lastPart = memberParts[memberParts.length - 1]
                    .replace(/^[TMP]:/, '')  // Remove type prefix
                    .replace(/\(.+\)$/, ''); // Remove parameter list
                
                return lastPart.toLowerCase().includes(prefix.toLowerCase());
            }

            return true;
        });

        console.log(`[XmlDocParser] Found ${contextMembers.length} completion items for prefix: "${prefix}"`);
        return contextMembers;
    }

    public static getMembersByType(members: XmlDocMember[], type: string): XmlDocMember[] {
        console.log(`[XmlDocParser] Getting members for type: ${type}`);
        
        // Get all members for the TeaPie core class
        const typeMembers = members.filter(m => {
            // Match both the type itself and its methods
            const isCoreType = m.name === `T:${type}`;
            const isTypeMethod = m.name.startsWith(`M:${type}.`);
            const isTypeProperty = m.name.startsWith(`P:${type}.`);
            
            const result = isCoreType || isTypeMethod || isTypeProperty;
            
            if (result) {
                console.log(`[XmlDocParser] Matched member: ${m.name}`);
            }
            
            return result;
        });

        console.log(`[XmlDocParser] Found ${typeMembers.length} members for type: ${type}`);
        
        if (typeMembers.length === 0) {
            // Try again with just the last part of the type name (e.g., "TeaPie" instead of "TeaPie.TeaPie")
            const simpleName = type.split('.').pop() || '';
            console.log(`[XmlDocParser] Trying simplified type name: ${simpleName}`);
            
            const simpleTypeMembers = members.filter(m => {
                const memberName = m.name.replace(/^[TMP]:/, '');
                return memberName.includes(`.${simpleName}.`) || memberName.endsWith(`.${simpleName}`);
            });
            
            console.log(`[XmlDocParser] Found ${simpleTypeMembers.length} members using simplified name`);
            return simpleTypeMembers;
        }
        
        return typeMembers;
    }

    public static dispose() {
        if (this.outputChannel) {
            this.outputChannel.dispose();
        }
    }
} 