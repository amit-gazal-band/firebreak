import { ROLES, renderMapText, type Observation, type Role, type Scenario } from "@firebreak/engine";

export const PROMPT_VERSION = "2";

const ROLE_TEXT: Record<Role, string> = {
  scout:
    "You are the SCOUT. You move 2 tiles per tick and see 5 tiles around you. You cannot fight fires, clear debris or rescue. " +
    "You are the ONLY one who receives the wind forecast (wind shifts, several ticks ahead). Your value is information: find fires, civilians and debris, and make sure the right teammates know.\n" +
    "PLAYBOOK: keep moving; sweep the map (both sides of the river, near houses and roads, where civilians appear). Never wait.",
  firefighter:
    "You are a FIREFIGHTER. You move 1 tile per tick and see 2 tiles around you. You carry 3 water; each tick of extinguishing uses 1. " +
    "Refill next to any water (lake or river). An intensity-3 fire can only be reduced when BOTH firefighters extinguish it in the same tick.\n" +
    "PLAYBOOK: if you know of a fire, call extinguish(x,y) on it (it walks there by itself). Prefer fires near houses and civilians and small fires before they grow. " +
    "For an intensity-3 fire, both firefighters must work it at the same time. When out of water, refill(). If you know of no fire, move toward where fires are likely instead of waiting.",
  engineer:
    "You are the ENGINEER. You move 1 tile per tick and see 2 tiles around you. You clear debris from roads (2 ticks) so the rescuer can drive, " +
    "and build firebreaks (1 tick) on grass/forest tiles, which stop fire from spreading.\n" +
    "PLAYBOOK: debris blocking a road the rescuer needs is your top priority: call clear_debris(x,y) (it walks there by itself). " +
    "Otherwise build firebreaks between fires and houses, on the downwind side of the fire. Do not wait while there is debris you know of.",
  rescuer:
    "You are the RESCUER. You drive on roads and the bridge only, 2 tiles per tick, and see 2 tiles around you. Debris on a road blocks you until the engineer clears it. " +
    "Civilians appear near roads and must be evacuated before their deadline or before fire reaches them.\n" +
    "PLAYBOOK: as soon as you know of a civilian, call rescue(civilian_id): it drives there and evacuates them by itself. " +
    "If a civilian is unreachable because of debris, make sure the engineer knows and rescue another one meanwhile. When you know of none, patrol the roads near houses.",
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
- Give orders with your order tools. An order keeps running tick after tick until it is done or blocked, so you do not need to repeat it. Give at most one order per turn; a new order replaces the current one. If your current order is still right, give no order.\n- Order tools that act on a target (extinguish, clear_debris, build_firebreak, rescue, refill) walk or drive there by themselves: you do not need move_to first.\n- wait() only when there is truly nothing useful to do. Idle agents lose points.
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
