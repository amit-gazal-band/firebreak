import type { TeamFactory } from "@firebreak/runtime";
import { band } from "./band";
import { subagents } from "./subagents";
import { chatBroadcast, chatMentions } from "./local-chat";
import { PeerTeam } from "./peer";
import { botsNone, botsPerfect } from "./scripted";

export { PeerTeam } from "./peer";
export { BandTransport, band } from "./band";
export { SubagentTeam, subagents, ORCHESTRATOR, validateSubagentAssignment } from "./subagents";
export { LocalChatTransport, chatBroadcast, chatMentions } from "./local-chat";
export { botsNone, botsPerfect } from "./scripted";

export const none: TeamFactory = {
  type: "none",
  label: "No communication",
  usesLlm: true,
  create: () => new PeerTeam({ transport: null, view: "self" }),
};

export const perfect: TeamFactory = {
  type: "perfect",
  label: "Perfect communication",
  usesLlm: true,
  create: () => new PeerTeam({ transport: null, view: "union" }),
};

const REGISTRY: Record<string, TeamFactory> = {
  none,
  perfect,
  "chat-mentions": chatMentions,
  "chat-broadcast": chatBroadcast,
  band,
  subagents,
  "bots-none": botsNone,
  "bots-perfect": botsPerfect,
};

export function registerTeam(f: TeamFactory): void {
  REGISTRY[f.type] = f;
}

export function teamFactory(type: string): TeamFactory {
  const f = REGISTRY[type];
  if (!f) throw new Error(`unknown team "${type}". Known: ${Object.keys(REGISTRY).join(", ")}`);
  return f;
}

export function knownTeams(): string[] {
  return Object.keys(REGISTRY);
}
