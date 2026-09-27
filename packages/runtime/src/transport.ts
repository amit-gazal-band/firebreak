import type { ToolDef, ToolResult } from "./llm/types";
import type { WorldHandle } from "./team";

export interface OutgoingMessage {
  /** Recipient agent ids, as resolved by the transport's own delivery rules. */
  to: string[];
  channel: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface DeliveredMessage {
  id: string;
  from: string;
  channel: string;
  text: string;
  sent_ms: number;
  delivered_ms: number;
  /** Whether this message was addressed to the recipient (mention, DM, assignment). */
  addressed: boolean;
}

/**
 * A team's communication layer (SPEC §7). Each transport exposes its native affordances as tools
 * and delivers messages by its own rules. The runtime records every send/deliver/consume.
 */
export interface Transport {
  readonly name: string;
  setup(world: WorldHandle, agents: string[]): Promise<void>;
  /** Tool definitions for this agent (e.g. send_message, create_room). */
  tools(agent: string): ToolDef[];
  /** Run one of this transport's tools on behalf of `agent`. */
  call(agent: string, tool: string, input: Record<string, unknown>): Promise<ToolResult>;
  /** Register the delivery callback for an agent. */
  onDeliver(agent: string, cb: (m: DeliveredMessage) => void): void;
  /** Short text for the prompt describing how communication works on this team. */
  promptSection(agent: string): string;
  teardown(): Promise<void>;
}

let seq = 0;
export function messageId(worldId: string): string {
  seq += 1;
  return `${worldId}-m${seq}`;
}

/**
 * Records the send side of a transport. Transports call these hooks;
 * delivery and consumption are recorded by the agent (SPEC §7, §10 message latency).
 */
export class MessageLog {
  constructor(private world: WorldHandle) {}

  sent(from: string, m: OutgoingMessage, id = messageId(this.world.worldId)): { id: string; t_ms: number } {
    const t_ms = this.world.now();
    this.world.emit({
      kind: "message",
      id,
      t_ms,
      from,
      to: m.to,
      channel: m.channel,
      text: m.text,
      ...(m.meta ? { meta: m.meta } : {}),
    });
    return { id, t_ms };
  }

  delivered(message_id: string, recipient: string): number {
    const t_ms = this.world.now();
    this.world.emit({ kind: "delivery", message_id, recipient, stage: "delivered", t_ms });
    return t_ms;
  }

  consumed(message_id: string, recipient: string): void {
    this.world.emit({ kind: "delivery", message_id, recipient, stage: "consumed", t_ms: this.world.now() });
  }
}
