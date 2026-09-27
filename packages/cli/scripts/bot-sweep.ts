import { ScriptedBot, createScenario, observe, observeUnion, renderMapText, step, validateOrder, type OrderBatch } from "@firebreak/engine";

const play = (seed: number, union: boolean) => {
  const scn = createScenario(seed);
  let s = scn.initial;
  const bots = s.agents.map((a) => new ScriptedBot(scn, a.id, a.role));
  let joint = 0;
  while (!s.ended) {
    const orders: OrderBatch = {};
    for (const b of bots) {
      const o = b.decide(union ? observeUnion(scn, s, b.id) : observe(scn, s, b.id));
      if (o && !validateOrder(s, b.id, o)) orders[b.id] = o;
    }
    const r = step(scn, s, orders);
    joint += r.events.filter((e) => e.type === "joint_needed").length;
    s = r.state;
  }
  return { ...s.score, fires: s.fires.length, tick: s.tick, joint };
};
console.log(renderMapText(createScenario(1)));
for (const union of [false, true]) {
  const rows = Array.from({ length: 20 }, (_, i) => play(i + 1, union));
  const avg = (k: keyof (typeof rows)[0]) => (rows.reduce((a, r) => a + (r[k] as number), 0) / rows.length).toFixed(1);
  console.log(union ? "perfect" : "none   ", "total", avg("total"), "evac", avg("evacuated"), "lost", avg("lost"), "ext", avg("extinguished"), "houses", avg("houses_standing"), "destroyed", avg("houses_destroyed"), "fires left", avg("fires"), "joint", avg("joint"), "ticks", avg("tick"));
}
