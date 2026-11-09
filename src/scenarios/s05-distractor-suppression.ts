import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s05-distractor-suppression",
  assets: [
    asset(
      "backpressure",
      "fanoutWindow",
      "Market quote fanout backpressure sliding window",
      `export function fanoutWindow(events:string[],cap:number){const latest=new Map<string,string>();for(const e of events){const k=e.split(':')[0];latest.delete(k);latest.set(k,e);if(latest.size>cap)latest.delete(latest.keys().next().value!);}return [...latest.values()];}`,
    ),
    ...noise(12, "router stream buffer"),
  ],
  units: [
    {
      name: "MarketFanout",
      query:
        "market quote router stream buffer fanout with backpressure sliding window",
      contract:
        "Export run(events,capacity). Keep latest quote per symbol (prefix before colon) in last-update order. Evict least recently updated when distinct symbols exceed capacity. Return strings oldest first, empty for capacity zero.",
      required: ["backpressure"],
      test: `assert.deepEqual(run(['A:1','B:2','A:3','C:4'],2),['A:3','C:4']);assert.deepEqual(run(['X:1'],0),[]);assert.deepEqual(run([],3),[]);`,
    },
  ],
} satisfies Scenario;
