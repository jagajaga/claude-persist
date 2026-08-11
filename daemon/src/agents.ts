// Counting the subagents a session currently has working.
//
// There is no "agent finished" event to rely on. Every Agent tool call returns
// its tool_result immediately — 405 real calls in one session, all resolved in
// 0.0s with "Async agent launched successfully", none left outstanding — so
// counting dispatches without results always yields zero.
//
// What the SDK does give is `parent_tool_use_id`: messages produced by a
// subagent are stamped with the id of the Agent call that launched it. So an
// agent is "working" if something has arrived under its id recently. That is
// self-correcting — no finish signal needed, and a wrong count fixes itself
// within one window instead of sticking.

/** Silence after which an agent stops being counted as working. */
export const AGENT_ACTIVE_MS = 45_000;

export interface AgentActivity {
  /** SDK task id, present only for tasks the CLI reported; required to stop one. */
  taskId?: string;
  /** What the CLI called it, e.g. 'agent' or 'bash'. */
  kind?: string;
  /** The Agent tool_use id; subagent messages carry it as parent_tool_use_id. */
  id: string;
  /** What it was asked to do, for the tooltip. */
  description: string;
  lastActivityAt: number;
}

/** Best-effort human label for an Agent tool call, from its input. */
export function agentDescription(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['description', 'subagent_type', 'prompt']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        const text = value.trim().replace(/\s+/g, ' ');
        return text.length > 80 ? `${text.slice(0, 80)}…` : text;
      }
    }
  }
  return 'subagent';
}

/**
 * Which agents count as working now.
 *
 * Sorted by when they were dispatched so the list reads in the order they were
 * launched rather than jumping around as each one reports.
 */
export function activeAgents(
  agents: Map<string, AgentActivity>,
  now: number,
  windowMs = AGENT_ACTIVE_MS,
): AgentActivity[] {
  const live: AgentActivity[] = [];
  for (const agent of agents.values()) {
    if (now - agent.lastActivityAt <= windowMs) live.push(agent);
  }
  return live;
}

/** Drop agents that have been silent long enough to be considered done. */
export function pruneAgents(
  agents: Map<string, AgentActivity>,
  now: number,
  windowMs = AGENT_ACTIVE_MS,
): boolean {
  let changed = false;
  for (const [id, agent] of agents) {
    if (now - agent.lastActivityAt > windowMs) {
      agents.delete(id);
      changed = true;
    }
  }
  return changed;
}


/**
 * The live set the CLI reports, which is authoritative when available.
 *
 * `background_tasks_changed` carries every live task after each change with
 * REPLACE semantics, so swapping the whole set cannot wedge a stale entry the
 * way pairing start/stop edges can. It also carries the task id that stopTask
 * needs — inferring agents from message activity gives no handle to stop one.
 *
 * The CLI emits nothing at startup, so the set must be reset whenever the
 * session's process restarts rather than assumed empty-means-unchanged.
 */
export function tasksFromLevelSignal(msg: Record<string, unknown>): AgentActivity[] | null {
  if (msg.type !== 'system' || msg.subtype !== 'background_tasks_changed') return null;
  const tasks = msg.tasks;
  if (!Array.isArray(tasks)) return [];
  const now = Date.now();
  const out: AgentActivity[] = [];
  for (const raw of tasks) {
    if (!raw || typeof raw !== 'object') continue;
    const task = raw as Record<string, unknown>;
    const taskId = typeof task.task_id === 'string' ? task.task_id : undefined;
    if (!taskId) continue;
    out.push({
      id: taskId,
      taskId,
      kind: typeof task.task_type === 'string' ? task.task_type : undefined,
      description:
        typeof task.description === 'string' && task.description.trim()
          ? task.description.trim()
          : 'background task',
      lastActivityAt: now,
    });
  }
  return out;
}
