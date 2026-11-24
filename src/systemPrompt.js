import { readFileSync } from 'node:fs';

export const KIOO_BASE_PROMPT = readFileSync(
    new URL('../prompts/kioo-system.txt', import.meta.url),
    'utf8'
).trim();

export function buildSystemPrompt(tools = []) {
    const lines = [];
    for (const tool of tools) {
        const definition = tool.function || tool;
        if (!definition || !definition.name) {
            continue;
        }
        lines.push(`- ${definition.name}: ${definition.description || 'Use when relevant.'}`);
    }

    if (lines.length === 0) {
        return KIOO_BASE_PROMPT;
    }

    return `${KIOO_BASE_PROMPT}\n\n## Available tools\n${lines.join('\n')}\n\nUse the tool schemas for exact arguments. Call a tool instead of describing what you would do.`;
}
