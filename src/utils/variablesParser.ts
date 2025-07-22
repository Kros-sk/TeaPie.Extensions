export function parseVariablesFile(content: string): { [key: string]: any } {
    try {
        return JSON.parse(content);
    } catch (error) {
        console.error('Error parsing variables file:', error);
        return {};
    }
} 