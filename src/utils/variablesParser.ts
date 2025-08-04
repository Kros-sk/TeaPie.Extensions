export function parseVariablesFile(content: string): { [key: string]: any } {
    try {
        return JSON.parse(content);
    } catch (error) {
        return {};
    }
} 