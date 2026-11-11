import type { Goal, GoalStatus, RunTurnResult, RouteDecision } from '../types/index.js';

export interface RunTurnOptions {
    modelId?: string;
    modelPath?: string;
    ctxSize?: number;
    route?: RouteDecision;
    escalationModelPath?: string | null;
    threshold?: number;
    approvalTools?: string[];
    approvalGate?: (call: { name: string; arguments: Record<string, unknown> }) => boolean;
}

export declare function runTurn(
    sessionId: string,
    userMessage: string,
    options?: RunTurnOptions
): Promise<RunTurnResult>;

export declare function resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
    options?: RunTurnOptions
): Promise<RunTurnResult>;

export declare const listGoals: (sessionId: string) => Goal[];

export declare function addGoal(
    sessionId: string,
    title: string,
    options?: { status?: GoalStatus; progress?: string | null }
): Goal;

export declare function updateGoal(
    goalId: string,
    fields?: { title?: string; status?: GoalStatus; progress?: string | null }
): Goal | null;
