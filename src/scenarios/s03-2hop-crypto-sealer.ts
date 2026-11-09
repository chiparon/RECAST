import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s03-2hop-crypto-sealer",
  bridge: "ledger-seal",
  assets: [
    asset(
      "dispatch",
      "WorkflowOrderDispatcher",
      "Dispatch incoming workflow orders",
      `import { sealCanonical } from './ledger-seal.js'; export function WorkflowOrderDispatcher(id:string,payload:string){return {id,receipt:sealCanonical(payload)};}`,
      { dependsOn: ["ledger-seal"] },
    ),
    asset(
      "ledger-seal",
      "sealCanonical",
      "Canonical byte envelope digest",
      `import {createHash} from 'node:crypto';export function sealCanonical(payload:string){return 'merkle-ed25519:'+createHash('sha256').update(payload.normalize('NFC'),'utf8').digest('hex');}`,
    ),
    ...noise(5, "workflow dispatch status"),
  ],
  units: [
    {
      name: "WorkflowOrderDispatcher",
      query: "派发工作流订单；生成不可篡改的封存回执",
      contract:
        "Export run(id,payload) returning {id,receipt}. Protocol receipt uses merkle-ed25519: followed by lowercase SHA-256 of UTF-8 NFC payload.",
      required: ["dispatch", "ledger-seal"],
      test: `const {createHash}=await import('node:crypto');for(const p of ['e\\u0301','', '订单']) assert.deepEqual(run('ab',p),{id:'ab',receipt:'merkle-ed25519:'+createHash('sha256').update(p.normalize('NFC')).digest('hex')});`,
    },
  ],
} satisfies Scenario;
