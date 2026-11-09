import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s09-whole-project-pipeline",
  assets: [
    asset(
      "intake",
      "OrderIntake",
      "Order intake normalization",
      `export function OrderIntake(id:string,cents:number){if(!id.trim()||!Number.isSafeInteger(cents)||cents<1)throw Error('order');return {id:id.trim(),cents};}`,
    ),
    asset(
      "posting",
      "LedgerPosting",
      "Ledger posting accounting protocol",
      `export function LedgerPosting(o:{id:string,cents:number}){return {key:'L/'+o.id,debit:o.cents,credit:-o.cents};}`,
    ),
    asset(
      "audit",
      "AuditOutbox",
      "Audit outbox event protocol",
      `export function AuditOutbox(p:{key:string,debit:number}){return {topic:'posted',dedup:p.key,amount:p.debit};}`,
    ),
    ...noise(4, "order processing panel"),
  ],
  units: [
    {
      name: "OrderIntake",
      query: "Order intake normalization",
      contract:
        "Export run(id,cents). Reject blank IDs or non-positive/non-safe-integer amounts. Return {id:trimmedId,cents}.",
      required: ["intake"],
      test: `assert.deepEqual(run(' x ',9),{id:'x',cents:9});assert.throws(()=>run('',9));assert.throws(()=>run('x',0));`,
    },
    {
      name: "LedgerPosting",
      dependsOn: ["OrderIntake"],
      query: "Ledger posting accounting",
      contract:
        'Export run(order) mapping {id,cents} to {key:"L/"+id,debit:cents,credit:-cents}.',
      required: ["posting"],
      test: `assert.deepEqual(run({id:'k',cents:7}),{key:'L/k',debit:7,credit:-7});`,
    },
    {
      name: "AuditOutbox",
      dependsOn: ["LedgerPosting"],
      query: "Audit outbox event protocol",
      contract:
        'Export run(posting) mapping {key,debit,credit} to {topic:"posted",dedup:key,amount:debit}.',
      required: ["audit"],
      test: `assert.deepEqual(run({key:'L/y',debit:5,credit:-5}),{topic:'posted',dedup:'L/y',amount:5});`,
    },
  ],
  joint: `import {run as intake} from '../OrderIntake.mjs';import {run as post} from '../LedgerPosting.mjs';import {run as audit} from '../AuditOutbox.mjs'; for(const n of [1,99,17001])assert.deepEqual(audit(post(intake(' z ',n))),{topic:'posted',dedup:'L/z',amount:n});`,
} satisfies Scenario;
