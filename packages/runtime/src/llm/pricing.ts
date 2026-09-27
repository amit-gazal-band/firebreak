/** USD per million tokens. Used for the `api` backend and as an estimate elsewhere. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: [RegExp, Price][] = [
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
];

export function priceFor(model: string): Price | null {
  return PRICES.find(([re]) => re.test(model))?.[1] ?? null;
}

export function costUsd(
  model: string,
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
): { usd: number; known: boolean } {
  const p = priceFor(model);
  if (!p) return { usd: 0, known: false };
  const usd = (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
  return { usd, known: true };
}
