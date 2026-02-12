import type {
  AIRequestDTO,
  AIResponseDTO,
  ClientContextDTO
} from "@shared/types/dto.js";

export type AskRequest = AIRequestDTO & {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  clientContext?: ClientContextDTO;
};

export interface AskResponse extends AIResponseDTO {
  routingStages?: string[];
  gpt5Used?: boolean;
  auditSafe?: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext?: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage?: {
    requestId: string;
    logged: boolean;
  };
  clientContext?: ClientContextDTO;
}
