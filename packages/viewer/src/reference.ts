import { DEFAULT_GAME_CONFIG, ROLES, SCORE_VALUES, type Role, type TileKind } from "@firebreak/engine";
import { ROLE_ICON, iconDataUrl, iconImg } from "./icons";
import { ROLE_COLOR, TILE_COLOR } from "./render";
import { createThemeToggle } from "./theme";

const ROLE_MARKS: { role: Role; name: string }[] = [
  { role: "scout", name: "Scout" },
  { role: "firefighter", name: "Firefighters" },
  { role: "engineer", name: "Engineer" },
  { role: "rescuer", name: "Rescuer" },
];

const TILES: { kind: TileKind; name: string }[] = [
  { kind: "grass", name: "Grass" },
  { kind: "forest", name: "Forest" },
  { kind: "house", name: "House" },
  { kind: "road", name: "Road" },
  { kind: "water", name: "Water" },
  { kind: "bridge", name: "Bridge" },
  { kind: "debris", name: "Debris" },
  { kind: "firebreak", name: "Firebreak" },
  { kind: "ash", name: "Ash" },
  { kind: "station", name: "Station" },
];

function roleIconsMarkup(role: Role): string {
  const badges = role === "firefighter" ? ["1", "2"] : [undefined];
  return `<span class="role-icons">${badges
    .map(
      (badge) =>
        `<img src="${iconDataUrl(ROLE_ICON[role], ROLE_COLOR[role], "#1b1e2b", badge)}" alt="${role}${badge ? ` ${badge}` : ""}">`,
    )
    .join("")}</span>`;
}

function roleItem(role: Role, name: string): string {
  return `<div class="legend-item">${roleIconsMarkup(role)}<span><b>${name}</b></span></div>`;
}

function tileItem(kind: TileKind, name: string): string {
  return `<div class="legend-item"><span class="tile-mark tile-${kind}" style="--tile:${TILE_COLOR[kind]}"></span><span>${name}</span></div>`;
}

function legendSections(): string {
  return `<section class="legend-section"><h3>Agents</h3><div class="legend-grid">
    ${ROLE_MARKS.map((r) => roleItem(r.role, r.name)).join("")}
    <div class="legend-item"><span class="role-mark hq-mark">HQ</span><span><b>Orchestrator</b> <small>no body</small></span></div>
  </div></section>
  <section class="legend-section"><h3>Map</h3><div class="legend-grid tile-grid">
    ${TILES.map((t) => tileItem(t.kind, t.name)).join("")}
  </div></section>
  <section class="legend-section"><h3>Overlays</h3><div class="legend-grid">
    <div class="legend-item"><span class="effect-mark fire-mark">1–3</span><span>Fire intensity</span></div>
    <div class="legend-item"><span class="effect-mark civilian-mark">●</span><span>Civilian + deadline ring</span></div>
    <div class="legend-item"><span class="effect-mark message-mark">→</span><span>Message in flight</span></div>
    <div class="legend-item"><span class="effect-mark order-mark">┄□</span><span>Active order: dashed line from agent to target</span></div>
    <div class="legend-item"><span class="effect-mark order-mark order-blocked-mark">┄□</span><span>Blocked order target</span></div>
    <div class="legend-item"><span class="effect-mark fog-mark"></span><span>Outside current team vision</span></div>
  </div></section>`;
}

export function compactRoleLegend(): HTMLElement {
  const node = document.createElement("div");
  node.className = "role-key";
  node.setAttribute("aria-label", "Agent map symbols");
  for (const item of ROLE_MARKS) {
    const entry = document.createElement("span");
    entry.title = item.name;
    const badges = item.role === "firefighter" ? ["1", "2"] : [undefined];
    for (const badge of badges)
      entry.append(
        iconImg(ROLE_ICON[item.role], 24, {
          disc: ROLE_COLOR[item.role],
          fg: "#1b1e2b",
          ...(badge ? { badge } : {}),
          title: badge ? `Firefighter ${badge}` : item.name,
        }),
      );
    entry.append(document.createTextNode(item.name));
    node.append(entry);
  }
  return node;
}

export function createLegendDialog(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "legend-dialog";
  dialog.setAttribute("aria-labelledby", "legend-title");
  dialog.innerHTML = `<form method="dialog"><button class="dialog-close" aria-label="Close legend">×</button></form>
    <h2 id="legend-title">Map legend</h2>
    ${legendSections()}
    <p class="meta">Click an agent on any map to inspect its role, position, current order, messages, and last model decision.</p>`;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  return dialog;
}

export function rulesHref(): string {
  const next = new URLSearchParams(location.search);
  next.set("rules", "");
  return `?${next.toString()}`;
}

export function renderRulesPage(root: HTMLElement): void {
  const back = new URLSearchParams(location.search);
  back.delete("rules");
  const backHref = back.size ? `?${back.toString()}` : "./";
  const c = DEFAULT_GAME_CONFIG;
  root.innerHTML = `<main class="reference-page">
    <nav class="reference-nav"><a href="${backHref}">← Back</a><span>FIRE<b>BREAK</b></span></nav>
    <header><p class="eyebrow">Game reference</p><h1>Rules and map legend</h1>
      <p>Five agents defend the same seeded wildfire world. Scores compare coordination strategies; within a match, every team receives the same map, schedule, and deterministic luck.</p></header>

    <section><h2>Objective and scoring</h2><div class="score-rules">
      <div><strong>+${SCORE_VALUES.civilianEvacuated}</strong><span>civilian evacuated</span></div>
      <div><strong>${SCORE_VALUES.civilianLost}</strong><span>civilian lost</span></div>
      <div><strong>+${SCORE_VALUES.houseStanding}</strong><span>house standing at the end</span></div>
      <div><strong>+${SCORE_VALUES.fireExtinguished}</strong><span>fire tile extinguished</span></div>
    </div></section>

    <section><h2>Agents</h2><div class="rules-table-wrap"><table><thead><tr><th>Map mark</th><th>Role</th><th>Speed</th><th>Vision</th><th>Capabilities</th></tr></thead><tbody>
      <tr><td>${roleItem("scout", "Scout")}</td><td>Scout</td><td>${ROLES.scout.speed} tiles/tick</td><td>${ROLES.scout.vision} tiles</td><td>Explores and uniquely receives the wind forecast.</td></tr>
      <tr><td>${roleItem("firefighter", "Firefighters")}</td><td>Two firefighters</td><td>${ROLES.firefighter.speed} tile/tick</td><td>${ROLES.firefighter.vision} tiles</td><td>Carry ${c.water_capacity} water. Intensity-3 fires require both firefighters on the same tick.</td></tr>
      <tr><td>${roleItem("engineer", "Engineer")}</td><td>Engineer</td><td>${ROLES.engineer.speed} tile/tick</td><td>${ROLES.engineer.vision} tiles</td><td>Clears debris in ${c.clear_debris_ticks} ticks and builds firebreaks.</td></tr>
      <tr><td>${roleItem("rescuer", "Rescuer")}</td><td>Rescuer</td><td>${ROLES.rescuer.speed} tiles/tick</td><td>${ROLES.rescuer.vision} tiles</td><td>Drives on roads and evacuates civilians.</td></tr>
    </tbody></table></div></section>

    <section><h2>World rules</h2><div class="rule-cards">
      <article><h3>Synchronized ticks</h3><p>By default, all triggered decisions and team-message follow-ups finish before every world advances one logical step. Model speed changes run time, not simulated reaction time.</p></article>
      <article><h3>Orders persist</h3><p>An order continues every tick until done, blocked, or replaced. Targeted actions automatically travel toward their target.</p></article>
      <article><h3>Fire grows and spreads</h3><p>Fire has intensity 1–3, grows every ${c.fire.growth_every} ticks when unfought, spreads faster downwind, and burns tiles out after ${c.fire.burnout_ticks} ticks.</p></article>
      <article><h3>People and buildings</h3><p>Civilians are lost if fire reaches them or their ${c.civilian_deadline}-tick deadline passes. A house at intensity 3 for ${c.fire.house_destroy_ticks} ticks is destroyed.</p></article>
      <article><h3>Fog of war</h3><p>Agents only know what their vision and communication condition reveal. Darkened tiles are outside the team's current combined vision.</p></article>
    </div></section>

    <section><h2>Teamwork that matters</h2><div class="rule-cards">
      <article><h3>Pair the firefighters</h3><p>An intensity-3 fire only yields when both firefighters extinguish it on the same tick. They may stand on different adjacent tiles around the fire.</p></article>
      <article><h3>Share the forecast</h3><p>Only the scout receives advance wind shifts. Communication lets the rest of the team act before the fire changes direction.</p></article>
      <article><h3>Open rescue routes</h3><p>The rescuer is fast but road-bound. When debris blocks a route, the engineer must clear it before the rescuer can reach civilians.</p></article>
    </div></section>

    <section><h2>Communication conditions</h2><div class="rules-table-wrap"><table><thead><tr><th>Condition</th><th>What information moves</th></tr></thead><tbody>
      <tr><td>No communication</td><td>Each agent sees only its own observations; there are no message tools.</td></tr>
      <tr><td>Perfect communication</td><td>Every agent receives the team's combined current vision. It is an omniscient reference condition, not a chat system.</td></tr>
      <tr><td>Mentions only</td><td>A room message is delivered only to the named teammates. Only those recipients wake.</td></tr>
      <tr><td>Room broadcast</td><td>Every room message is delivered to every teammate; mentions merely mark the intended recipients.</td></tr>
      <tr><td>Subagents</td><td>An orchestrator gives an isolated worker one complete assignment. The worker independently observes and adapts until it reports verified completion or unrecoverable blockage. A replacement gets a fresh brief and inherits the body's physical state. A hard tick cutoff is optional and disabled by default.</td></tr>
    </tbody></table></div></section>

    <section><h2>AI broadcast booth</h2><div class="rule-cards">
      <article><h3>Full-information observer</h3><p>The commentator sees the complete map, every fire and civilian, all agent orders, and every sent message regardless of who received it.</p></article>
      <article><h3>Plain-language analysis</h3><p>At replay checkpoints it explains the fire situation, what the team is coordinating, and whether its current priorities make sense.</p></article>
      <article><h3>Outside the experiment</h3><p>The broadcast is generated only after the outcome is fixed. It cannot advise players, change latency or score, or enter competitive model-cost metrics.</p></article>
      <article><h3>Saved for replay</h3><p>Historical matches generate a versioned commentary sidecar on first open. The original SQLite recording remains unchanged and verifiable.</p></article>
    </div></section>

    <section class="reference-legend"><h2>Viewer legend</h2>${legendSections()}</section>
    <footer>Defaults shown here describe the standard scenario. Every recording stores its exact resolved configuration and prompts.</footer>
  </main>`;
  root.querySelector(".reference-nav")!.append(createThemeToggle());
}
