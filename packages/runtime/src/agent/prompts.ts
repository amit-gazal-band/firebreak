import { ROLES, renderMapText, type Observation, type Role, type Scenario } from "@firebreak/engine";

export const PROMPT_VERSION = "1";

const ROLE_TEXT: Record<Role, string> = {
  scout:
    "You are the SCOUT. You move 2 tiles per tick and see 5 tiles around you. You cannot fight fires, clear debris or rescue. " +
    "You are the ONLY one who receives the wind forecast (wind shifts, several ticks ahead). Your value is information: find fires, civilians and debris, and make sure the right teammates know.",
  firefighter:
    "You are a FIREFIGHTER. You move 1 tile per tick and see 2 tiles around you. You carry 3 water; each tick of extinguishing uses 1. " +
    "Refill next to any water (lake or river). An intensity-3 fire can only be reduced when BOTH firefighters extinguish it in the same tick.",
  engineer:
    "You are the ENGINEER. You move 1 tile per tick and see 2 tiles around you. You clear debris from roads (2 ticks) so the rescuer can drive, " +
    "and build firebreaks (1 tick) on grass/forest tiles, which stop fire from spreading. Firebreaks are most useful downwind of a fire.",
  rescuer:
    "You are the RESCUER. You drive on roads and the bridge only, 2 tiles per tick, and see 2 tiles around you. Debris on a road blocks you until the engineer clears it. " +
    "Civilians appear near roads and must be evacuated before their deadline or before fire reaches them. You must be within 1 tile of a civilian to evacuate them.",
};

export const RULES_TEXT = `GAME: Wildfire. Your team of 5 defends a town from spreading wildfires. The match lasts a fixed number of ticks; the world advances every few seconds whether or not you act.

MAP (fixed layout; fires, civilians and debris are NOT shown — you only know them if you or a teammate saw them):
Legend: . grass  T forest  H house  = road  ~ water  B bridge  S fire station (start)
Coordinates are (x, y): x = column (left to right), y = row (top to bottom).

RULES
- Fires have intensity 1-3. Unfought fires grow every few ticks and spread to neighbouring grass/forest/houses, much faster downwind.
- Wind "E" means the wind blows toward the east (increasing x): fire spreads fastest eastward.
- A house that burns at intensity 3 for 3 ticks is destroyed. Any tile burns out to ash after 10 ticks.
- Civilians die if fire reaches them or their deadline passes.
- The bridge may collapse at some point; after that the river cannot be crossed.
- Burning tiles cannot be walked through.

SCORING (team): civilian evacuated +10, civilian lost -20, each house still standing at the end +5, each fire tile put out +1.

HOW YOU ACT
- You are woken up when something relevant happens (a message, your order finished or was blocked, you saw something new, the wind changed) or every few ticks.
- Give orders with your order tools. An order keeps running tick after tick until it is done or blocked, so you do not need to repeat it. Give at most one order per turn; a new order replaces the current one. If your current order is still right, give no order.
- Act immediately: call your tools first. Write at most one short sentence, or nothing.`;

export interface PromptParts {
  system: string;
}

export function systemPrompt(scn: Scenario, agentId: string, role: Role, commsSection: string): string {
  return [
    RULES_TEXT,
    "",
    renderMapText(scn),
    "",
    `YOU: ${agentId}. ${ROLE_TEXT[role]}`,
    `Your orders: ${ROLES[role].orders.join(", ")}.`,
    "",
    "TEAM: scout, ff1 and ff2 (firefighters), engineer, rescuer.",
    "",
    "COMMUNICATION",
    commsSection,
  ].join("\n");
}

export interface PromptMessage {
  from: string;
  channel: string;
  text: string;
  tick: number;
  addressed: boolean;
}

export function userPrompt(opts: {
  obs: Observation;
  reasons: string[];
  messages: PromptMessage[];
  newMessageCount: number;
  orderLog: string[];
  extra?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `TICK ${opts.obs.tick} (${opts.obs.ticks_left} ticks left). Woken because: ${opts.reasons.join("; ") || "heartbeat"}.`,
  );
  lines.push("");
  lines.push("WHAT YOU SEE NOW:");
  lines.push(JSON.stringify(opts.obs));
  if (opts.orderLog.length) {
    lines.push("");
    lines.push("YOUR RECENT ORDERS:");
    lines.push(...opts.orderLog);
  }
  if (opts.messages.length) {
    lines.push("");
    lines.push(`MESSAGES (oldest first; the last ${opts.newMessageCount} are new):`);
    for (const m of opts.messages)
      lines.push(`[t${m.tick}] ${m.channel} ${m.from}${m.addressed ? " → you" : ""}: ${m.text}`);
  }
  if (opts.extra) {
    lines.push("");
    lines.push(opts.extra);
  }
  lines.push("");
  lines.push("Decide now.");
  return lines.join("\n");
}
