import { readFile } from "node:fs/promises";
const r = JSON.parse(await readFile("results/latest-report.json", "utf8"));
for (const c of r.comparison) {
  for (const metric of ["time", "turns"]) {
    const v = c[metric];
    const pass = c.pairs === 10 && v.ratio > 1 && v.p < 0.05;
    console.log(
      pass ? "PASS" : "UNMET",
      c.mode,
      metric,
      "baseline/SAG2",
      v.ratio.toFixed(3),
      "one-sided p",
      v.p.toFixed(4),
    );
    if (!pass) process.exitCode = 1;
  }
}
