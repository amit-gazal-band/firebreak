import { z } from "zod";
import {
  MessageLog,
  type DeliveredMessage,
  type TeamFactory,
  type ToolDef,
  type ToolResult,
  type Transport,
  type WorldHandle,
} from "@firebreak/runtime";
import { PeerTeam } from "./peer";

export type LocalChatDelivery = "mentions" | "broadcast";

const COMMON = `The five agents on your team share one local chat room called "team".
- Send messages with send_message(text, mentions). mentions contains teammate ids (scout, ff1, ff2, engineer, rescuer), or ["all"].
- Mention exactly who needs to act. Do not spam: every delivered message wakes its recipients.
- Share what matters: fires, civilians, debris, the wind forecast, and what you are doing next.`;

const PROMPTS: Record<LocalChatDelivery, string> = {
  mentions: `${COMMON}
- Only teammates you mention receive and see the message.`,
  broadcast: `${COMMON}
- Every message is delivered to and seen by every teammate; mentions only mark its intended recipients.`,
};

/** Deterministic in-process room used to isolate targeted delivery from broadcast delivery. */
export class LocalChatTransport implements Transport {
  readonly name: string;
  private world!: WorldHandle;
  private log!: MessageLog;
  private agents: string[] = [];
  private delivery = new Map<string, (m: DeliveredMessage) => void>();

  constructor(readonly mode: LocalChatDelivery) {
    this.name = `chat-${mode}`;
  }

  async setup(world: WorldHandle, agents: string[]): Promise<void> {
    this.world = world;
    this.log = new MessageLog(world);
    this.agents = agents;
  }

  tools(): ToolDef[] {
    return [
      {
        name: "send_message",
        description:
          'Send a message in the shared team room. mentions: teammate ids (scout, ff1, ff2, engineer, rescuer) or ["all"].',
        schema: {
          text: z.string(),
          mentions: z.array(z.string()).min(1),
        },
      },
    ];
  }

  async call(agent: string, tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    if (tool !== "send_message") return { text: `unknown tool ${tool}`, isError: true };
    const mentions = Array.isArray(input.mentions) ? input.mentions.map(String) : [];
    const intended = mentions.includes("all")
      ? this.agents.filter((id) => id !== agent)
      : [...new Set(mentions)].filter((id) => id !== agent);
    const unknown = intended.filter((id) => !this.agents.includes(id));
    if (unknown.length) return { text: `unknown teammate(s): ${unknown.join(", ")}`, isError: true };
    if (!intended.length) return { text: "mention at least one teammate", isError: true };

    const recipients = this.mode === "mentions" ? intended : this.agents.filter((id) => id !== agent);
    const text = String(input.text ?? "").trim();
    if (!text) return { text: "message text must not be empty", isError: true };
    const { id, t_ms } = this.log.sent(agent, {
      to: recipients,
      channel: "#team",
      text,
      meta: { addressed_to: intended },
    });
    for (const recipient of recipients) {
      const delivered_ms = this.log.delivered(id, recipient);
      this.delivery.get(recipient)?.({
        id,
        from: agent,
        channel: "#team",
        text,
        sent_ms: t_ms,
        delivered_ms,
        addressed: intended.includes(recipient),
      });
    }
    return {
      text: `sent to ${recipients.join(", ")} in #team`,
      isError: false,
    };
  }

  onDeliver(agent: string, cb: (m: DeliveredMessage) => void): void {
    this.delivery.set(agent, cb);
  }

  promptSection(): string {
    return PROMPTS[this.mode];
  }

  async teardown(): Promise<void> {}
}

export const chatMentions: TeamFactory = {
  type: "chat-mentions",
  label: "Chat · mentions only",
  usesLlm: true,
  create: () => new PeerTeam({ transport: new LocalChatTransport("mentions"), view: "self" }),
};

export const chatBroadcast: TeamFactory = {
  type: "chat-broadcast",
  label: "Chat · room broadcast",
  usesLlm: true,
  create: () => new PeerTeam({ transport: new LocalChatTransport("broadcast"), view: "self" }),
};
