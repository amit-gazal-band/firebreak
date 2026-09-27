import { Agent, GenericAdapter } from "@band-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { parse } from "yaml";
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

interface Cred {
  agent_id: string;
  api_key: string;
}

interface RestLike {
  getAgentMe(): Promise<{ id: string; handle?: string | null }>;
  createChat(taskId?: string): Promise<{ id: string }>;
  addChatParticipant(chatId: string, p: { participantId: string; role: string }): Promise<unknown>;
  createChatMessage(
    chatId: string,
    m: { content: string; mentions?: { id: string; handle?: string }[] },
  ): Promise<{ id?: string; recipients?: { id: string }[] } & Record<string, unknown>>;
}

interface Room {
  name: string;
  chatId: string;
  members: Set<string>;
}

export function loadBandCredentials(file: string): Record<string, Cred> {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new Error(`Band team needs ${file} with one agent per role (see band_agents.yaml.example)`);
  }
  return parse(readFileSync(path, "utf8")) as Record<string, Cred>;
}

const COMMS = `You are connected to your teammates through Band, a messaging platform for agents.
- There is a team room called "team" with all 5 of you. You can also create smaller rooms for a specific task (e.g. "fire-12-7" with ff1 and ff2) and add teammates to them.
- Every message must @mention at least one teammate, and ONLY the mentioned teammates receive it. Use mentions: ["all"] to reach everyone in the room.
- Mention exactly who needs to know. Do not spam: every message wakes up its recipients.
- Messages arrive in about a second. Share what matters: fires you see, civilians, debris, the wind forecast, and what you are doing next.`;

/**
 * The Band team's transport (SPEC §7.3): five real Band agents connected through @band-ai/sdk.
 * The SDK is used as transport only; the LLM loop is the shared one from the runtime.
 * Delivery follows Band's own rules: only @mentioned room members receive a message.
 */
export class BandTransport implements Transport {
  readonly name = "band";
  private world!: WorldHandle;
  private log!: MessageLog;
  private creds: Record<string, Cred> = {};
  private agents = new Map<string, Agent>();
  private rest = new Map<string, RestLike>();
  private handles = new Map<string, string>();
  private byUuid = new Map<string, string>();
  private rooms = new Map<string, Room>();
  private roomsByChat = new Map<string, Room>();
  private delivery = new Map<string, (m: DeliveredMessage) => void>();
  /** Band message id -> our message id and send time, filled when createChatMessage returns. */
  private sentIds = new Map<string, { id: string; t_ms: number }>();

  async setup(world: WorldHandle, agentIds: string[]): Promise<void> {
    this.world = world;
    this.log = new MessageLog(world);
    this.creds = loadBandCredentials(world.config.band.agents_file);
    for (const id of agentIds)
      if (!this.creds[id]?.agent_id) throw new Error(`band_agents.yaml has no credentials for ${id}`);

    await Promise.all(
      agentIds.map(async (id) => {
        const c = this.creds[id]!;
        const agent = Agent.create({
          adapter: new GenericAdapter(async ({ message, roomId }) =>
            this.onPlatformMessage(id, roomId, message),
          ),
          config: {
            agentId: c.agent_id,
            apiKey: c.api_key,
            ...(world.config.band.rest_url ? { restUrl: world.config.band.rest_url } : {}),
            ...(world.config.band.ws_url ? { wsUrl: world.config.band.ws_url } : {}),
          },
          agentConfig: { autoSubscribeExistingRooms: false },
        });
        await agent.start();
        const rest = (agent.runtime as unknown as { link: { rest: RestLike } }).link.rest;
        const me = await rest.getAgentMe();
        this.agents.set(id, agent);
        this.rest.set(id, rest);
        this.handles.set(id, me.handle ?? id);
        this.byUuid.set(c.agent_id, id);
      }),
    );
    await this.createRoom(agentIds[0]!, "team", agentIds);
  }

  private async createRoom(owner: string, name: string, members: string[]): Promise<Room> {
    const rest = this.rest.get(owner)!;
    const chat = await rest.createChat();
    const room: Room = { name, chatId: chat.id, members: new Set([owner]) };
    for (const m of members) {
      if (m === owner) continue;
      await rest.addChatParticipant(chat.id, { participantId: this.creds[m]!.agent_id, role: "member" });
      room.members.add(m);
    }
    this.rooms.set(name, room);
    this.roomsByChat.set(chat.id, room);
    this.world.emit({
      kind: "event",
      tick: this.world.state().tick,
      t_ms: this.world.now(),
      type: "room_created",
      agent_id: owner,
      payload: { room: name, chat_id: chat.id, members: [...room.members] },
    });
    return room;
  }

  private onPlatformMessage(
    recipient: string,
    chatId: string,
    message: { id: string; content: string; senderId: string; messageType?: string },
    attempt = 0,
  ): void {
    const from = this.byUuid.get(message.senderId);
    if (!from || from === recipient) return;
    if (message.messageType && message.messageType !== "text") return;
    const sent = this.sentIds.get(message.id);
    // The websocket can beat the REST response of the send; wait briefly for the id mapping.
    if (!sent && attempt < 30) {
      setTimeout(() => this.onPlatformMessage(recipient, chatId, message, attempt + 1), 50);
      return;
    }
    const room = this.roomsByChat.get(chatId);
    const ourId = sent?.id ?? message.id;
    const delivered = this.log.delivered(ourId, recipient);
    const text = message.content.replace(/@\[\[([0-9a-f-]+)\]\]\s*/g, (_, uuid: string) => {
      const id = this.byUuid.get(uuid);
      return id ? `@${id} ` : "";
    });
    this.delivery.get(recipient)?.({
      id: ourId,
      from,
      channel: room ? `#${room.name}` : "#room",
      text: text.trim(),
      sent_ms: sent?.t_ms ?? delivered,
      delivered_ms: delivered,
      addressed: true,
    });
  }

  onDeliver(agent: string, cb: (m: DeliveredMessage) => void): void {
    this.delivery.set(agent, cb);
  }

  tools(_agent: string): ToolDef[] {
    return [
      {
        name: "send_message",
        description:
          'Post a message in a Band room. Only the teammates you @mention receive it. mentions: teammate ids (scout, ff1, ff2, engineer, rescuer) or ["all"].',
        schema: {
          room: z.string().describe('room name, e.g. "team"'),
          text: z.string(),
          mentions: z.array(z.string()).min(1),
        },
      },
      {
        name: "create_room",
        description:
          "Create a new Band room for a task and add teammates to it (you are added automatically).",
        schema: {
          name: z.string().describe('short name, e.g. "fire-12-7"'),
          participants: z.array(z.string()),
        },
      },
      {
        name: "add_participant",
        description: "Add a teammate to an existing room.",
        schema: { room: z.string(), agent: z.string() },
      },
    ];
  }

  async call(agent: string, tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (tool) {
        case "send_message":
          return await this.send(
            agent,
            String(input.room ?? "team"),
            String(input.text ?? ""),
            (input.mentions as string[]) ?? [],
          );
        case "create_room": {
          const name = String(input.name ?? "").trim() || `room-${this.rooms.size + 1}`;
          if (this.rooms.has(name)) return { text: `room "${name}" already exists`, isError: true };
          const members = [...new Set([agent, ...((input.participants as string[]) ?? [])])].filter(
            (m) => this.creds[m],
          );
          const room = await this.createRoom(agent, name, members);
          return { text: `created room "${name}" with ${[...room.members].join(", ")}`, isError: false };
        }
        case "add_participant": {
          const room = this.rooms.get(String(input.room));
          const who = String(input.agent);
          if (!room) return { text: `no room "${input.room}"`, isError: true };
          if (!this.creds[who]) return { text: `unknown teammate ${who}`, isError: true };
          if (!room.members.has(who)) {
            await this.rest
              .get(agent)!
              .addChatParticipant(room.chatId, { participantId: this.creds[who]!.agent_id, role: "member" });
            room.members.add(who);
          }
          return { text: `${who} is in "${room.name}"`, isError: false };
        }
      }
      return { text: `unknown tool ${tool}`, isError: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.world.emit({
        kind: "event",
        tick: this.world.state().tick,
        t_ms: this.world.now(),
        type: /429|rate/i.test(msg) ? "rate_limited" : "transport_error",
        agent_id: agent,
        payload: { tool, error: msg.slice(0, 300) },
      });
      return { text: `Band error: ${msg.slice(0, 200)}`, isError: true };
    }
  }

  private async send(agent: string, roomName: string, text: string, mentions: string[]): Promise<ToolResult> {
    const room = this.rooms.get(roomName.replace(/^#/, ""));
    if (!room)
      return { text: `no room "${roomName}". Rooms: ${[...this.rooms.keys()].join(", ")}`, isError: true };
    if (!room.members.has(agent)) return { text: `you are not in "${room.name}"`, isError: true };
    const targets = mentions.includes("all")
      ? [...room.members].filter((m) => m !== agent)
      : [...new Set(mentions)].filter((m) => m !== agent);
    const unknown = targets.filter((m) => !room.members.has(m));
    if (unknown.length)
      return {
        text: `not in "${room.name}": ${unknown.join(", ")}. Add them first or use another room.`,
        isError: true,
      };
    if (!targets.length) return { text: "mention at least one teammate", isError: true };
    const { id, t_ms } = this.log.sent(agent, {
      to: targets,
      channel: `#${room.name}`,
      text,
      meta: { addressed_to: targets },
    });
    const res = await this.rest.get(agent)!.createChatMessage(room.chatId, {
      content: text,
      mentions: targets.map((m) => ({ id: this.creds[m]!.agent_id, handle: this.handles.get(m)! })),
    });
    if (typeof res.id === "string") this.sentIds.set(res.id, { id, t_ms });
    return { text: `sent to ${targets.join(", ")} in #${room.name}`, isError: false };
  }

  promptSection(_agent: string): string {
    return COMMS;
  }

  async teardown(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.stop(3000).catch(() => false)));
  }
}

export const band: TeamFactory = {
  type: "band",
  label: "Band",
  usesLlm: true,
  create: () => new PeerTeam({ transport: new BandTransport(), view: "self" }),
};
