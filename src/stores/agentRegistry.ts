/**
 * Agent Registry — In-memory cache + Prisma persistence
 *
 * Manages zero-trust agent registration, capability tracking, and heartbeat.
 */

import { PrismaClient } from '@prisma/client';
import type { AgentRecord, AgentRegistration } from '../types/actionPlan.js';
import { aiLogger } from '../utils/structuredLogging.js';

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// --- In-memory cache ---
const agentCache = new Map<string, AgentRecord>();

// --- Store Operations ---

export async function registerAgent(input: AgentRegistration): Promise<AgentRecord> {
  const db = getPrisma();

  const agent = await db.agent.create({
    data: {
      role: input.role,
      capabilities: input.capabilities,
      publicKey: input.public_key ?? null,
      status: 'idle',
      lastHeartbeat: new Date(),
    },
  });

  const record = agent as unknown as AgentRecord;
  agentCache.set(record.id, record);

  aiLogger.info('Agent registered', {
    module: 'agentRegistry',
    agentId: record.id,
    role: record.role,
    capabilities: record.capabilities,
  });

  return record;
}

export async function getAgent(agentId: string): Promise<AgentRecord | null> {
  const cached = agentCache.get(agentId);
  if (cached) return cached;

  const db = getPrisma();
  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (!agent) return null;

  const record = agent as unknown as AgentRecord;
  agentCache.set(agentId, record);
  return record;
}

export async function updateHeartbeat(agentId: string): Promise<AgentRecord | null> {
  const db = getPrisma();

  try {
    const agent = await db.agent.update({
      where: { id: agentId },
      data: { lastHeartbeat: new Date(), status: 'idle' },
    });

    const record = agent as unknown as AgentRecord;
    agentCache.set(agentId, record);
    return record;
  } catch {
    return null;
  }
}

export async function updateAgentStatus(agentId: string, status: string): Promise<AgentRecord | null> {
  const db = getPrisma();

  try {
    const agent = await db.agent.update({
      where: { id: agentId },
      data: { status },
    });

    const record = agent as unknown as AgentRecord;
    agentCache.set(agentId, record);
    return record;
  } catch {
    return null;
  }
}

export async function listAgents(): Promise<AgentRecord[]> {
  const db = getPrisma();
  const agents = await db.agent.findMany({ orderBy: { createdAt: 'desc' } });

  for (const agent of agents) {
    agentCache.set(agent.id, agent as unknown as AgentRecord);
  }

  return agents as unknown as AgentRecord[];
}

/**
 * Validate that an agent has a specific capability.
 */
export async function validateCapability(agentId: string, capability: string): Promise<boolean> {
  const agent = await getAgent(agentId);
  if (!agent) return false;
  return agent.capabilities.includes(capability);
}

/**
 * Warm the agent cache from Prisma on startup.
 */
export async function warmAgentCache(): Promise<void> {
  try {
    const db = getPrisma();
    const agents = await db.agent.findMany();

    for (const agent of agents) {
      agentCache.set(agent.id, agent as unknown as AgentRecord);
    }

    aiLogger.info('Agent cache warmed', {
      module: 'agentRegistry',
      count: agents.length,
    });
  } catch {
    aiLogger.warn('Failed to warm Agent cache (DB may not be available)', {
      module: 'agentRegistry',
    });
  }
}
