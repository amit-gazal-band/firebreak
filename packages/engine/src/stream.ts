/**
 * The event stream a match produces (SPEC §8). The recorder writes it, the live server
 * broadcasts it, and the viewer consumes it, so live and replay share one code path.
 * Browser-safe: no Node imports.
 */
import type { Scenario, WorldEvent, WorldState } from "./types";

export interface MatchHeader {
  match_id: string;
  created_at: string;
  seed: number;
  tick_ms: number;
  ticks: number;
  teams: { world_id: string; team: string; label: string }[];
  scenario: Scenario;
  /** The full resolved configuration (secrets redacted). */
  config: Record<string, unknown>;
}

export interface TickFrame {
  kind: "tick";
  world_id: string;
  tick: number;
  t_ms: number;
  state: WorldState;
  hash: string;
}

export type RuntimeEventType =
  | "order_issued"
  | "order_rejected"
  | "wake"
  | "spawn"
  | "report"
  | "room_created"
  | "transport_error"
  | "rate_limited"
  | "match_aborted";

export interface EventFrame {
  kind: "event";
  world_id: string;
  tick: number;
  t_ms: number;
  type: WorldEvent["type"] | RuntimeEventType;
  agent_id?: string;
  payload: Record<string, unknown>;
}

export interface MessageFrame {
  kind: "message";
  world_id: string;
  id: string;
  t_ms: number;
  from: string;
  /** Recipient agent ids this message will be delivered to. */
  to: string[];
  /** Where it was posted: a room, channel, issue, or "direct". */
  channel: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface DeliveryFrame {
  kind: "delivery";
  world_id: string;
  message_id: string;
  recipient: string;
  stage: "delivered" | "consumed";
  t_ms: number;
}

export interface LlmFrame {
  kind: "llm";
  world_id: string;
  id: string;
  agent_id: string;
  started_ms: number;
  ended_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  cost_estimated: boolean;
  /** Prompt text; omitted from bundles unless requested (it is large). */
  prompt?: string;
  response: string;
  tool_calls: { name: string; input: unknown; result: string }[];
  error?: string;
}

export interface EndFrame {
  kind: "end";
  t_ms: number;
  status: "completed" | "aborted";
  reason?: string;
  results: { world_id: string; team: string; score: number; cost_usd: number }[];
}

export type StreamFrame = TickFrame | EventFrame | MessageFrame | DeliveryFrame | LlmFrame | EndFrame;

/** A whole recording loaded into memory, as the viewer consumes it. */
export interface RecordingBundle {
  header: MatchHeader;
  frames: StreamFrame[];
}
