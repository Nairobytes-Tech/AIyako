import type { Approval, ApprovalStatus } from '../types/index.js';

export declare const APPROVAL_STATUSES: ApprovalStatus[];

export interface ApprovalToolCall {
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
}

export declare function createApprovals(
    sessionId: string,
    toolCalls: ApprovalToolCall[],
    gate?: ((call: ApprovalToolCall) => boolean) | null
): Approval[];

export declare function getApproval(approvalId: string): Approval | null;

export declare function listApprovals(sessionId: string, status?: ApprovalStatus | null): Approval[];

export declare function listPendingApprovals(sessionId: string): Approval[];

export declare function listUnexecutedApprovals(sessionId: string): Approval[];

export declare function setApprovalStatus(approvalId: string, status: ApprovalStatus): boolean;

export declare function markApprovalExecuted(
    approvalId: string,
    result?: Record<string, unknown> | null
): boolean;

export declare function listExecutedApprovals(sessionId: string): Approval[];

export declare function parseApprovalTools(value?: string | null): string[];

export declare function buildApprovalGate(
    tools?: string[] | string | null
): ((call: { name: string }) => boolean) | null;
