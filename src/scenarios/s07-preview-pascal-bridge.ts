import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s07-preview-pascal-bridge",
  bridge: "calibrator",
  assets: [
    asset(
      "service",
      "MaintenanceWorkOrder",
      "Engine maintenance work order triggering",
      `export function maintenance(previous:number,current:number,OperatingHourMeterCalibrator:(n:number)=>number){if(current<previous)throw Error('rollback');const n=Math.floor(current/500);return n>Math.floor(previous/500)?{interval:n,price:OperatingHourMeterCalibrator(n)}:null;}`,
    ),
    asset(
      "calibrator",
      "OperatingHourMeterCalibrator",
      "Tariff coefficient lookup",
      `export function OperatingHourMeterCalibrator(n:number){return 1200+37*n;}`,
    ),
    ...noise(4, "engine maintenance schedule labels"),
  ],
  units: [
    {
      name: "MaintenanceWorkOrder",
      query: "发动机维保工单触发；边界计价校准",
      contract:
        "Export run(previous,current). Reject meter regression. If a new 500-hour interval is crossed return {interval:n,price:1200+37*n} for latest floor(current/500); otherwise null.",
      required: ["service", "calibrator"],
      test: `assert.equal(run(0,499),null);assert.deepEqual(run(499,500),{interval:1,price:1237});assert.equal(run(500,999),null);assert.deepEqual(run(1,1250),{interval:2,price:1274});assert.throws(()=>run(501,500));`,
    },
  ],
} satisfies Scenario;
