import { computeMetrics } from "@firebreak/recorder";
for (const f of process.argv.slice(2)) console.log(JSON.stringify(computeMetrics(f), null, 1));
