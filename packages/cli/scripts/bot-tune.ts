import {
  ScriptedBot,
  createScenario,
  mergeGameConfig,
  observe,
  observeUnion,
  step,
  validateOrder,
  type OrderBatch,
  type GameConfig,
} from "@firebreak/engine";

const play = (seed: number, union: boolean, cfg: GameConfig) => {
  const scn = createScenario(seed, cfg);
  let s = scn.initial;
  const bots = s.agents.map((a) => new ScriptedBot(scn, a.id, a.role));
  while (!s.ended) {
    const orders: OrderBatch = {};
    for (const b of bots) {
      const o = b.decide(union ? observeUnion(scn, s, b.id) : observe(scn, s, b.id));
      if (o && !validateOrder(s, b.id, o)) orders[b.id] = o;
    }
    s = step(scn, s, orders).state;
  }
  return s;
};
for (const base of [0.08, 0.05, 0.035])
  for (const growth of [4, 6])
    for (const deadline of [12, 16]) {
      const cfg = mergeGameConfig({
        fire: { base_spread: base, growth_every: growth } as GameConfig["fire"],
        civilian_deadline: deadline,
      });
      const res = [false, true].map((u) => {
        const rows = Array.from({ length: 30 }, (_, i) => play(i + 1, u, cfg));
        const m = (f: (s: (typeof rows)[0]) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
        return `total ${m((s) => s.score.total)
          .toFixed(0)
          .padStart(
            4,
          )} lost ${m((s) => s.score.lost).toFixed(1)} evac ${m((s) => s.score.evacuated).toFixed(1)} destroyed ${m((s) => s.score.houses_destroyed).toFixed(1)} fires ${m((s) => s.fires.length).toFixed(0)}`;
      });
      console.log(
        `spread ${base} growth ${growth} deadline ${deadline} | none: ${res[0]} | perfect: ${res[1]}`,
      );
    }
