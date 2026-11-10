import type { Task } from './domain';
import { contextCapacity } from './contextCapacity';

export type TaskBudgetReason = 'calls' | 'tokens' | 'time' | 'context_capacity' | 'configuration';
export const RUN_BUDGET_REASONS = ['calls', 'tokens', 'time'] as const;
export function defaultTaskBudget(provider: Parameters<typeof contextCapacity>[0]) {
  return { maxSteps: 24, maxTokens: Math.ceil(24 * (contextCapacity(provider).inputCapacity + provider.maxOutputTokens) / 1000) * 1000,
    maxDurationMs: 30 * 60 * 1000 };
}

export function exhaustedTaskBudget(task: Task, at = Date.now()): TaskBudgetReason | undefined {
  if (task.stepCount + (task.memoryCalls ?? 0) >= task.maxSteps) return 'calls';
  if (task.usedTokens >= task.maxTokens) return 'tokens';
  if (task.startedAt && at - Date.parse(task.startedAt) > (task.maxDurationMs ?? 1800000)) return 'time';
  return undefined;
}

/** Old budget interactions did not record a reason. Their capacity flag and
 * configuration state still distinguish repairs from spending authorization. */
export function taskBudgetPauseReason(task: Task, configured = true): TaskBudgetReason | undefined {
  const interaction = task.interaction;
  if (interaction?.kind !== 'budget') return undefined;
  const reason = interaction.payload?.budgetReason;
  if (['calls', 'tokens', 'time', 'context_capacity', 'configuration'].includes(String(reason))) return reason as TaskBudgetReason;
  if (interaction.payload?.capacityError) return 'context_capacity';
  if (!configured) return 'configuration';
  // Includes legacy preflight pauses where usedTokens is still below maxTokens.
  return exhaustedTaskBudget(task) ?? 'tokens';
}
