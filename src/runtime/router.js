const COMPLEXITY_KEYWORDS = [
    'analyze',
    'analyse',
    'compare',
    'explain in depth',
    'design',
    'architect',
    'roadmap',
    'strategy',
    'step by step',
    'debug',
    'code',
    'refactor',
    'summarize',
    'summarise',
    'plan',
    'pros and cons',
];

const CONNECTOR_PATTERN = /\b(and then|after that|also|multiple|all of|first|second|then)\b/;
const CODE_PATTERN = /```|\bfunction\b|\bclass\b|\bimport\b|\bselect\b|\bcreate table\b/;
const WEB_SEARCH_PATTERN = /\b(web search|search the web|search online|search for|look up|lookup|google|latest|news|current events|on the internet|online)\b/;

export function scoreComplexity(message) {
    const text = String(message || '').toLowerCase();
    let score = 0;

    if (text.length > 320) {
        score += 2;
    } else if (text.length > 160) {
        score += 1;
    }

    if (COMPLEXITY_KEYWORDS.some(keyword => text.includes(keyword))) {
        score += 2;
    }

    const questionMarks = (text.match(/\?/g) || []).length;
    if (questionMarks > 1) {
        score += 1;
    }

    if (CONNECTOR_PATTERN.test(text)) {
        score += 1;
    }

    if (CODE_PATTERN.test(text)) {
        score += 1;
    }

    if (WEB_SEARCH_PATTERN.test(text)) {
        score += 2;
    }

    return score;
}

export function chooseRoute(message, options = {}) {
    const escalationModelPath = options.escalationModelPath
        || process.env.KIOO_ESCALATION_MODEL_PATH
        || null;
    const threshold = options.threshold === undefined ? 2 : options.threshold;
    const score = scoreComplexity(message);

    if (!escalationModelPath) {
        return {
            provider: 'local',
            modelPath: null,
            score,
            threshold,
            reason: 'no escalation model configured',
        };
    }

    if (score >= threshold) {
        return {
            provider: 'escalation',
            modelPath: escalationModelPath,
            score,
            threshold,
            reason: 'complexity threshold reached',
        };
    }

    return {
        provider: 'local',
        modelPath: null,
        score,
        threshold,
        reason: 'low complexity',
    };
}
