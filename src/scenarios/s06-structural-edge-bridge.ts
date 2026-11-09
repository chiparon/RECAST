import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s06-structural-edge-bridge",
  bridge: "journal",
  assets: [
    asset(
      "claim",
      "applyClaim",
      "Supplier claim deduction capped in integer cents · 核算供应商索赔扣款上限",
      `import { appendOnce } from './journal.js';export function applyClaim(s:{balance:number,events:Record<string,number>},id:string,amount:number){if(!Number.isSafeInteger(amount)||amount<1)throw Error('amount');if(id in s.events)return appendOnce(s,id,amount);if(amount>s.balance)throw Error('cap');appendOnce(s,id,amount);s.balance-=amount;return s;}`,
    ),
    asset(
      "journal",
      "appendOnce",
      "Atomic keyed journal mutation and collision handling",
      `export function appendOnce(s:{events:Record<string,number>},id:string,x:number){if(id in s.events && s.events[id]!==x)throw Error('conflict');s.events[id]=x;return s;}`,
    ),
    ...noise(4, "claim deduction dashboard"),
  ],
  units: [
    {
      name: "SupplierClaim",
      query: "核算供应商索赔扣款上限；保证冲突时整体回滚与原子投递",
      contract:
        "Export run(state,id,cents). Mutate {balance,events:{}} atomically. Positive safe integer cents only. Duplicate id with same amount is a no-op, conflicting replay or insufficient balance throws without changing state. On success return state.",
      required: ["claim", "journal"],
      test: `const s={balance:90,events:{}};assert.deepEqual(run(s,'x',55),{balance:35,events:{x:55}});assert.deepEqual(run(s,'x',55),s);for(const [k,n] of [['x',5],['y',36],['z',1.2]]){const before=structuredClone(s);assert.throws(()=>run(s,k,n));assert.deepEqual(s,before);}`,
    },
  ],
} satisfies Scenario;
