import { createActor, setup } from "xstate";

export type AgentTurnLifecycleEvent =
  | { type: "START_STREAMING" }
  | { type: "START_GENERATE" }
  | { type: "TEXT_SEEN" }
  | { type: "NO_ASSISTANT_TEXT" }
  | { type: "STREAM_ERROR" }
  | { type: "MODEL_ERROR" }
  | { type: "RETRY_STREAMING" }
  | { type: "RETRY_GENERATE" }
  | { type: "GENERATED_TEXT" }
  | { type: "FALLBACK_TEXT" }
  | { type: "DELIVERED" }
  | { type: "DELIVERY_ERROR" };

export type AgentTurnLifecycleSnapshot = {
  value: string;
  status: string;
};

export type AgentTurnLifecycleTraceEntry = {
  at: number;
  event: AgentTurnLifecycleEvent["type"];
  from: AgentTurnLifecycleSnapshot;
  to: AgentTurnLifecycleSnapshot;
};

export const agentTurnLifecycleMachine = setup({
  types: {
    events: {} as AgentTurnLifecycleEvent,
  },
}).createMachine({
  id: "agentTurnLifecycle",
  initial: "received",
  states: {
    received: {
      on: {
        START_STREAMING: { target: "streaming" },
        START_GENERATE: { target: "generating" },
        MODEL_ERROR: { target: "recovering" },
      },
    },
    streaming: {
      on: {
        TEXT_SEEN: { target: "streaming" },
        NO_ASSISTANT_TEXT: { target: "recovering" },
        GENERATED_TEXT: { target: "finalizing" },
        FALLBACK_TEXT: { target: "finalizing" },
        STREAM_ERROR: { target: "recovering" },
        MODEL_ERROR: { target: "recovering" },
        DELIVERED: { target: "delivered" },
        DELIVERY_ERROR: { target: "failed" },
      },
    },
    generating: {
      on: {
        GENERATED_TEXT: { target: "finalizing" },
        NO_ASSISTANT_TEXT: { target: "recovering" },
        FALLBACK_TEXT: { target: "finalizing" },
        MODEL_ERROR: { target: "recovering" },
        DELIVERED: { target: "delivered" },
        DELIVERY_ERROR: { target: "failed" },
      },
    },
    recovering: {
      on: {
        RETRY_STREAMING: { target: "streaming" },
        RETRY_GENERATE: { target: "generating" },
        GENERATED_TEXT: { target: "finalizing" },
        FALLBACK_TEXT: { target: "finalizing" },
        MODEL_ERROR: { target: "failed" },
        DELIVERY_ERROR: { target: "failed" },
      },
    },
    finalizing: {
      on: {
        DELIVERED: { target: "delivered" },
        DELIVERY_ERROR: { target: "failed" },
        MODEL_ERROR: { target: "failed" },
      },
    },
    delivered: {
      type: "final",
    },
    failed: {
      type: "final",
    },
  },
});

function snapshotOf(actor: any): AgentTurnLifecycleSnapshot {
  const snapshot: any = actor.getSnapshot();
  return {
    value: String(snapshot?.value ?? "unknown"),
    status: String(snapshot?.status ?? "active"),
  };
}

export function createAgentTurnController() {
  const actor = createActor(agentTurnLifecycleMachine as any);
  const trace: AgentTurnLifecycleTraceEntry[] = [];
  actor.start();

  return {
    send(event: AgentTurnLifecycleEvent): AgentTurnLifecycleSnapshot {
      const from = snapshotOf(actor);
      actor.send(event as any);
      const to = snapshotOf(actor);
      trace.push({ at: Date.now(), event: event.type, from, to });
      return to;
    },
    snapshot(): AgentTurnLifecycleSnapshot {
      return snapshotOf(actor);
    },
    trace(): AgentTurnLifecycleTraceEntry[] {
      return [...trace];
    },
    stop() {
      actor.stop();
    },
  };
}
