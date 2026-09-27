import { ROLES, type Order, type Role } from "@firebreak/engine";
import { z } from "zod";
import type { ToolDef } from "../llm/types";

const coord = { x: z.number().int().describe("column, 0-19"), y: z.number().int().describe("row, 0-19") };

/** One tool per order type (SPEC §6.4). */
const ORDER_TOOLS: Record<Order["type"], ToolDef> = {
  move_to: {
    name: "move_to",
    description: "Walk to tile (x, y). The engine pathfinds and moves you every tick until you arrive or are blocked.",
    schema: coord,
  },
  extinguish: {
    name: "extinguish",
    description:
      "Put out the fire at (x, y). You walk next to it first, then spray 1 water per tick until it is out or you run dry. " +
      "An intensity-3 fire only goes down if BOTH firefighters extinguish it in the same tick.",
    schema: coord,
  },
  refill: {
    name: "refill",
    description: "Walk to the nearest water (lake or river) and refill to full.",
    schema: {},
  },
  clear_debris: {
    name: "clear_debris",
    description: "Clear the debris blocking the road at (x, y). You walk next to it first; clearing takes 2 ticks.",
    schema: coord,
  },
  build_firebreak: {
    name: "build_firebreak",
    description: "Turn the grass/forest tile at (x, y) into a firebreak that cannot burn. You walk next to it first; takes 1 tick.",
    schema: coord,
  },
  rescue: {
    name: "rescue",
    description: "Drive next to civilian `civilian_id` and evacuate them.",
    schema: { civilian_id: z.string().describe("e.g. c1") },
  },
  wait: {
    name: "wait",
    description: "Stop and do nothing until your next order.",
    schema: {},
  },
};

export function orderToolsFor(role: Role): ToolDef[] {
  return ROLES[role].orders.map((t) => ORDER_TOOLS[t as Order["type"]]);
}

export const ORDER_TOOL_NAMES = new Set(Object.keys(ORDER_TOOLS));

export function toOrder(name: string, input: Record<string, unknown>): Order {
  switch (name) {
    case "move_to":
    case "extinguish":
    case "clear_debris":
    case "build_firebreak":
      return { type: name, x: Number(input.x), y: Number(input.y) };
    case "rescue":
      return { type: "rescue", civilian_id: String(input.civilian_id) };
    case "refill":
    case "wait":
      return { type: name };
    default:
      throw new Error(`not an order tool: ${name}`);
  }
}
