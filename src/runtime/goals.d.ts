import type { Goal, GoalStatus } from '../types/index.js';

export declare const GOAL_STATUSES: GoalStatus[];

export declare function addGoal(
    sessionId: string,
    title: string,
    options?: { status?: GoalStatus; progress?: string | null }
): Goal;

export declare function getGoal(goalId: string): Goal | null;

export declare function listGoals(sessionId: string): Goal[];

export declare function updateGoal(
    goalId: string,
    fields?: { title?: string; status?: GoalStatus; progress?: string | null }
): Goal | null;

export declare function deleteGoal(goalId: string): boolean;

export declare function findGoalByTitle(
    sessionId: string,
    title: string,
    status?: GoalStatus | null
): Goal | null;

export interface GoalSyncResult {
    created: Goal[];
    completed: Goal[];
}

export declare function syncGoalsFromEvents(sessionId: string, events?: unknown[]): GoalSyncResult;
