import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s10-scale-velocity-stress",
  assets: [
    asset(
      "reservation",
      "reserveStock",
      "Warehouse inventory reservation with bounded capacity and replay",
      `export function reserveStock(stock:number,rows:[string,number][]){const keys=new Set<string>();const accepted=[];for(const [key,n] of rows){if(!keys.has(key)&&Number.isSafeInteger(n)&&n>0&&n<=stock){keys.add(key);stock-=n;accepted.push(key);}}return {stock,accepted};}`,
    ),
    ...noise(60, "enterprise inventory routing profile").map((a, i) => ({
      ...a,
      files: Object.fromEntries(
        Array.from({ length: 10 }, (_, j) => [
          "asset" + i + "_" + j + ".ts",
          "export function profile" +
            i +
            "_" +
            j +
            "(item:string){return item.trim().slice(0," +
            (j + 1) +
            ");}",
        ]),
      ),
    })),
  ],
  units: [
    {
      name: "WarehouseReservation",
      query:
        "Warehouse inventory reservation with bounded stock capacity and idempotent replay",
      contract:
        "Export run(stock,rows). Iterate [key,n] rows. Accept each key once on first valid request, only positive safe integers <= remaining stock. Return {stock,accepted} preserving acceptance order.",
      required: ["reservation"],
      test: `assert.deepEqual(run(8,[['a',9],['a',3],['a',3],['b',0],['c',5],['d',1]]),{stock:0,accepted:['a','c']});assert.deepEqual(run(3,[['z',1.2]]),{stock:3,accepted:[]});`,
    },
  ],
} satisfies Scenario;
