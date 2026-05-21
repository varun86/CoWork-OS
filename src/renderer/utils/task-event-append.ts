import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

const RENDERER_NOISE_EVENT_TYPES = new Set([
  "log",
  "llm_usage",
  "llm_streaming",
  "progress_update",
  "task_analysis",
  "executing",
]);

const RENDERER_REPLACEABLE_EVENT_TYPES = new Set(["progress_update", "executing", "llm_streaming"]);

const DEFAULT_MAX_EVENTS = 600;

export function isRendererNoiseEvent(event: TaskEvent): boolean {
  return RENDERER_NOISE_EVENT_TYPES.has(getEffectiveTaskEventType(event));
}

export function capTaskEvents(
  events: TaskEvent[],
  maxEvents: number = DEFAULT_MAX_EVENTS,
): TaskEvent[] {
  if (events.length <= maxEvents) return events;

  const indexed = events.map((event, index) => ({ event, index }));
  const structural = indexed.filter(({ event }) => !isRendererNoiseEvent(event));

  if (structural.length >= maxEvents) {
    return structural.slice(-maxEvents).map(({ event }) => event);
  }

  const noiseBudget = maxEvents - structural.length;
  const recentNoise = indexed
    .filter(({ event }) => isRendererNoiseEvent(event))
    .slice(-noiseBudget);
  const keepIndexes = new Set<number>([
    ...structural.map(({ index }) => index),
    ...recentNoise.map(({ index }) => index),
  ]);

  return indexed.filter(({ index }) => keepIndexes.has(index)).map(({ event }) => event);
}

export function getTransientEventReplacementKey(event: TaskEvent): string | null {
  if (!RENDERER_REPLACEABLE_EVENT_TYPES.has(event.type)) return null;
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const payloadStep =
    payload.step && typeof payload.step === "object" && !Array.isArray(payload.step)
      ? (payload.step as Record<string, unknown>)
      : null;
  const stepId =
    typeof event.stepId === "string"
      ? event.stepId
      : typeof payload.stepId === "string"
        ? payload.stepId
        : typeof payloadStep?.id === "string"
          ? payloadStep.id
          : "";
  const groupId =
    typeof event.groupId === "string"
      ? event.groupId
      : typeof payload.groupId === "string"
        ? payload.groupId
        : "";
  const stage =
    typeof payload.stage === "string"
      ? payload.stage
      : typeof payload.label === "string"
        ? payload.label
        : "";
  return [event.taskId, event.type, stepId, groupId, stage].join(":");
}

export function appendRendererTaskEvents(
  previousEvents: TaskEvent[],
  incomingEvents: TaskEvent[],
): TaskEvent[] {
  if (incomingEvents.length === 0) return previousEvents;

  const replacements = new Map<string, TaskEvent>();
  const appends: TaskEvent[] = [];
  for (const event of incomingEvents) {
    const key = getTransientEventReplacementKey(event);
    if (key) {
      replacements.set(key, event);
    } else {
      appends.push(event);
    }
  }

  let nextEvents = previousEvents;
  if (replacements.size > 0) {
    const usedKeys = new Set<string>();
    nextEvents = previousEvents.map((event) => {
      const key = getTransientEventReplacementKey(event);
      if (key && replacements.has(key)) {
        usedKeys.add(key);
        return replacements.get(key)!;
      }
      return event;
    });
    for (const [key, event] of replacements) {
      if (!usedKeys.has(key)) appends.push(event);
    }
  }

  if (appends.length > 0) {
    nextEvents = [...nextEvents, ...appends];
  }
  return capTaskEvents(nextEvents);
}
