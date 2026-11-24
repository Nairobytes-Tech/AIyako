import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    openAIToolsToQvac,
    openAIMessagesToQvac,
    qvacCallsToOpenAI,
} from '../services/model-server/server.js';

describe('OpenAI-compatible model server mapping', () => {
    test('maps OpenAI tools to QVAC tool definitions', () => {
        const tools = openAIToolsToQvac([{
            type: 'function',
            function: {
                name: 'save_note',
                description: 'Save a note',
                parameters: { type: 'object', properties: { text: { type: 'string' } } },
            },
        }]);

        assert.equal(tools.length, 1);
        assert.equal(tools[0].type, 'function');
        assert.equal(tools[0].name, 'save_note');
        assert.equal(tools[0].description, 'Save a note');
        assert.equal(tools[0].parameters.type, 'object');
    });

    test('maps assistant tool calls and tool results', () => {
        const history = openAIMessagesToQvac([
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"query":"kioo"}' },
                }],
            },
            { role: 'tool', tool_call_id: 'call-1', content: '{"success":true}' },
        ]);

        assert.equal(history[0].tool_calls[0].name, 'web_search');
        assert.deepEqual(history[0].tool_calls[0].arguments, { query: 'kioo' });
        assert.equal(history[1].name, 'web_search');
        assert.equal(history[1].content, '{"success":true}');
    });

    test('maps QVAC tool calls back to OpenAI format', () => {
        const calls = qvacCallsToOpenAI([{
            id: 'call-2',
            name: 'create_task',
            arguments: { title: 'Ship' },
        }]);

        assert.equal(calls[0].type, 'function');
        assert.equal(calls[0].function.name, 'create_task');
        assert.deepEqual(JSON.parse(calls[0].function.arguments), { title: 'Ship' });
    });
});
