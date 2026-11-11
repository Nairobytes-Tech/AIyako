import type { RouteDecision } from '../types/index.js';

export interface RouteOptions {
    escalationModelPath?: string | null;
    threshold?: number;
}

export declare function scoreComplexity(message: string): number;

export declare function chooseRoute(message: string, options?: RouteOptions): RouteDecision;
