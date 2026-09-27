import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadBundle } from "@firebreak/recorder";
import { ensureViewerBuilt } from "./server";

/** Write a single self-contained HTML file: the viewer with the recording embedded (SPEC §8.6). */
export function exportHtml(recording: string, out?: string, opts: { prompts?: boolean } = {}): string {
  const html = readFileSync(ensureViewerBuilt(), "utf8");
  const bundle = loadBundle(recording, { prompts: opts.prompts ?? false });
  // Escape "<" so the JSON cannot close the script tag.
  const json = JSON.stringify(bundle).replace(/</g, "\\u003c");
  const tag = `<script>window.__FIREBREAK_BUNDLE__=${json};</script>`;
  const target = out ?? recording.replace(/\.sqlite$/, ".html");
  if (!html.includes("<!--FIREBREAK_BUNDLE-->")) throw new Error("viewer build is missing the bundle marker");
  writeFileSync(
    target,
    html.replace("<!--FIREBREAK_BUNDLE-->", () => tag),
  );
  return target.startsWith(process.cwd())
    ? target.slice(process.cwd().length + 1)
    : basename(target) === target
      ? target
      : target;
}
