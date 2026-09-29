import type { Role } from "@firebreak/engine";

/**
 * Role and score icons (SPEC §9.3): hand-drawn SVG paths on a 24×24 grid, so an exported replay
 * looks the same on every OS (emoji don't). Each icon is a list of fills and cut-outs, rasterised
 * once per size and colour to an offscreen canvas and reused every frame.
 */
export type IconName =
  "scout" | "firefighter" | "engineer" | "rescuer" | "hq" | "civilian" | "house" | "lost" | "fire";

type Op = { cut?: true; d: string };

const circle = (x: number, y: number, r: number) =>
  `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}z`;

const PATHS: Record<IconName, Op[]> = {
  // Binoculars: two barrels on lenses, joined by a bridge.
  scout: [
    { d: rect(4, 5, 6, 10) + rect(14, 5, 6, 10) + rect(9, 9, 6, 5) },
    { d: circle(7, 16, 4.8) + circle(17, 16, 4.8) },
    { cut: true, d: circle(7, 16, 2.2) + circle(17, 16, 2.2) },
  ],
  // Firefighter helmet: dome, crest and a wide brim with a longer back.
  firefighter: [
    { d: "M5 15C5 8.5 8.2 5.5 12 5.5S19 8.5 19 15z" },
    { d: rect(10.8, 2.5, 2.4, 5) },
    { d: "M2 15h20.5l-1 3.5H3z" },
    { cut: true, d: rect(11.2, 9, 1.6, 6) },
  ],
  // Engineer: hard hat over a wrench.
  engineer: [
    { d: "M4.5 11.5C4.5 6.8 7.8 4 12 4s7.5 2.8 7.5 7.5z" },
    { d: rect(2.5, 11, 19, 2.4) },
    { d: circle(6.5, 18.5, 3.6) + rect(8, 17.2, 13.5, 2.6) },
    { cut: true, d: rect(2.5, 17.4, 4.6, 2.2) },
  ],
  // Ambulance: box body with a cross, cab with a window, two wheels.
  rescuer: [
    { d: rect(1.5, 6, 13, 11) + "M14.5 9.5h4.2l3.8 4V17h-8z" },
    { cut: true, d: "M7 8h2.4v2.6H12V13H9.4v2.6H7V13H4.4v-2.4H7z" + "M16 11h2.2l2.3 2.4H16z" },
    { cut: true, d: circle(6, 17.5, 3.3) + circle(17.5, 17.5, 3.3) },
    { d: circle(6, 17.5, 2.3) + circle(17.5, 17.5, 2.3) },
  ],
  // Radio tower: an A-frame mast with a beacon and two signal arcs.
  hq: [
    { d: "M12 9L17 22.5h-2.4L12 14.5 9.4 22.5H7z" + rect(8.8, 18, 6.4, 1.6) },
    { d: circle(12, 7, 2) },
    {
      d:
        "M7.02 11.18A6.5 6.5 0 0 1 7.02 2.82L8.32 3.91A4.8 4.8 0 0 0 8.32 10.09z" +
        "M16.98 11.18A6.5 6.5 0 0 0 16.98 2.82L15.68 3.91A4.8 4.8 0 0 1 15.68 10.09z",
    },
  ],
  // Person: head and shoulders.
  civilian: [{ d: circle(12, 6.5, 3.6) }, { d: "M5 22v-5.5C5 12.5 8 11 12 11s7 1.5 7 5.5V22z" }],
  // House: roof, walls, a door.
  house: [{ d: "M12 3L22.5 12H19.5v9h-15v-9H1.5z" }, { cut: true, d: rect(10, 14.5, 4, 6.5) }],
  // Lost civilian: a person with a cross through it.
  lost: [
    { d: circle(12, 6.5, 3.6) + "M5 22v-5.5C5 12.5 8 11 12 11s7 1.5 7 5.5V22z" },
    { cut: true, d: "M3.4 5.1l1.7-1.7 15.5 15.5-1.7 1.7z" },
    { d: "M2.3 4l1.7-1.7L21.7 20l-1.7 1.7z" },
  ],
  // Flame.
  fire: [
    {
      d: "M12 2c1 3.5 6.5 6.5 6.5 12a6.5 6.5 0 0 1-13 0c0-3 1.5-4.8 3-6.2.3 2 1.2 3.2 2.3 3.6C10 8 10.8 4.8 12 2z",
    },
    { cut: true, d: "M12 13.5c1.2 1.4 2.8 2.6 2.8 4.5a2.8 2.8 0 0 1-5.6 0c0-1.9 1.6-3.1 2.8-4.5z" },
  ],
};

export const ROLE_ICON: Record<Role, IconName> = {
  scout: "scout",
  firefighter: "firefighter",
  engineer: "engineer",
  rescuer: "rescuer",
};

/** Human names for the legend and tooltips. */
export const ICON_LABEL: Record<IconName, string> = {
  scout: "Scout",
  firefighter: "Firefighter",
  engineer: "Engineer",
  rescuer: "Rescuer",
  hq: "Orchestrator (HQ)",
  civilian: "Civilian",
  house: "House",
  lost: "Civilian lost",
  fire: "Fire",
};

const cache = new Map<string, HTMLCanvasElement>();
let paths: Map<IconName, { cut: boolean; path: Path2D }[]> | null = null;

function compiled(name: IconName) {
  paths ??= new Map(
    (Object.keys(PATHS) as IconName[]).map((k) => [
      k,
      PATHS[k].map((op) => ({ cut: !!op.cut, path: new Path2D(op.d) })),
    ]),
  );
  return paths.get(name)!;
}

/** The icon as a `px`-sized bitmap in `color` (device pixels), cached. */
export function iconBitmap(name: IconName, px: number, color: string): HTMLCanvasElement {
  const size = Math.max(4, Math.round(px));
  const key = `${name}|${size}|${color}`;
  let cv = cache.get(key);
  if (cv) return cv;
  cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  for (const op of compiled(name)) {
    ctx.globalCompositeOperation = op.cut ? "destination-out" : "source-over";
    ctx.fill(op.path);
  }
  cache.set(key, cv);
  return cv;
}

/** Draw an icon centred on (x, y), `px` device pixels across. */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  x: number,
  y: number,
  px: number,
  color: string,
): void {
  const bmp = iconBitmap(name, px, color);
  ctx.drawImage(bmp, x - bmp.width / 2, y - bmp.height / 2);
}

const discCache = new Map<string, string>();

/**
 * A role disc with its icon as a data URL, for DOM use (feed lines, inspector, legend), drawn by
 * the same code as the board so every place shows the same icon.
 */
export function iconDataUrl(name: IconName, disc: string | null, fg: string, badge?: string): string {
  const key = `${name}|${disc}|${fg}|${badge ?? ""}`;
  let url = discCache.get(key);
  if (url) return url;
  const S = 48;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d")!;
  if (disc) {
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.fill();
  }
  drawIcon(ctx, name, S / 2, S / 2, disc ? S * 0.7 : S, fg);
  if (badge) drawBadge(ctx, S * 0.8, S * 0.22, S * 0.2, badge);
  url = cv.toDataURL();
  discCache.set(key, url);
  return url;
}

/** The FF1 / FF2 number badge. */
export function drawBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  text: string,
): void {
  ctx.fillStyle = "#1b1e2b";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${Math.round(r * 1.5)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + r * 0.08);
}

/** An <img> of an icon, sized in CSS pixels. */
export function iconImg(
  name: IconName,
  cssPx: number,
  opts: { disc?: string | null; fg?: string; badge?: string; title?: string } = {},
): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "icon";
  img.src = iconDataUrl(name, opts.disc ?? null, opts.fg ?? "#1b1e2b", opts.badge);
  img.width = img.height = cssPx;
  img.alt = opts.title ?? ICON_LABEL[name];
  img.title = opts.title ?? ICON_LABEL[name];
  return img;
}
