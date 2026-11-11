import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreComplexity, chooseRoute } from '../src/runtime/router.js';

const ESCALATION_PATH = '/tmp/stronger-model.gguf';

describe('Hybrid router', () => {
    test('short simple messages stay local', () => {
        const route = chooseRoute('hello', { escalationModelPath: ESCALATION_PATH });
        assert.equal(route.provider, 'local');
        assert.equal(route.modelPath, null);
        assert.equal(route.reason, 'low complexity');
    });

    test('complex messages escalate when a stronger model is configured', () => {
        const route = chooseRoute(
            'Please analyze and compare these three options step by step and explain the pros and cons.',
            { escalationModelPath: ESCALATION_PATH }
        );
        assert.equal(route.provider, 'escalation');
        assert.equal(route.modelPath, ESCALATION_PATH);
        assert.equal(route.reason, 'complexity threshold reached');
        assert.ok(route.score >= route.threshold);
    });

    test('complex messages stay local when no stronger model is configured', () => {
        const route = chooseRoute('Please analyze and compare step by step', { escalationModelPath: null });
        assert.equal(route.provider, 'local');
        assert.equal(route.reason, 'no escalation model configured');
    });

    test('threshold can be tuned', () => {
        const message = 'Can you plan my week?';
        const strict = chooseRoute(message, { escalationModelPath: ESCALATION_PATH, threshold: 99 });
        assert.equal(strict.provider, 'local');
    });

    test('web search turns escalate when a stronger model is configured', () => {
        const route = chooseRoute('Search the web for Austin Obimbo', { escalationModelPath: ESCALATION_PATH });
        assert.equal(route.provider, 'escalation');
        assert.equal(route.reason, 'complexity threshold reached');
    });

    test('scoreComplexity rewards code and multi-part requests', () => {
        assert.ok(scoreComplexity('```js\nconst x = 1;\n```') >= 1);
        assert.ok(scoreComplexity('do this, and then that, also that?') >= 1);
        assert.equal(scoreComplexity('hi'), 0);
    });
});
