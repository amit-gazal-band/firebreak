// node:sqlite is still flagged experimental in Node 22; silence only that warning.
const originalEmit = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite")) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const { DatabaseSync } = await import("node:sqlite");

export { DatabaseSync };
export type Database = InstanceType<typeof DatabaseSync>;
