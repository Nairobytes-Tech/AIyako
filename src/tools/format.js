export function formatToolResult(name, result, args = {}) {
    if (!result || result.success !== true) {
        const error = result && result.error ? result.error : 'Unknown error';
        return `Tool ${name} failed: ${error}`;
    }

    if (name !== 'web_search') {
        return JSON.stringify(result);
    }

    const data = result.data || {};
    const query = args.query || data.query || '';
    const results = Array.isArray(data.results) ? data.results : [];

    if (results.length === 0) {
        return `Web search returned no results for "${query}".`;
    }

    const lines = [`Web search results for "${query}":`];
    results.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.title || '(untitled)'}`);
        lines.push(`   URL: ${item.url || '(no url)'}`);
        if (item.snippet) {
            lines.push(`   ${item.snippet}`);
        }
    });
    return lines.join('\n');
}

export function formatHistoryForModel(history) {
    const callsById = new Map();
    for (const message of history) {
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                callsById.set(call.id, call);
            }
        }
    }

    let changed = false;
    const formatted = history.map(message => {
        if (message.role !== 'tool') {
            return message;
        }

        let result;
        try {
            result = JSON.parse(message.content);
        } catch {
            return message;
        }

        const call = callsById.get(message.tool_call_id);
        let args = {};
        if (call) {
            if (typeof call.arguments === 'string') {
                try {
                    args = JSON.parse(call.arguments);
                } catch {
                    args = {};
                }
            } else if (call.arguments && typeof call.arguments === 'object') {
                args = call.arguments;
            }
        }

        changed = true;
        return {
            ...message,
            content: formatToolResult(call ? call.name : message.name, result, args),
        };
    });

    return changed ? formatted : history;
}
