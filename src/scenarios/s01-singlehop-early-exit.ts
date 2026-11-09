import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s01-singlehop-early-exit",
  early: true,
  assets: [
    asset(
      "settlement",
      "settlePayment",
      "Submit payment orders with precision and idempotency",
      `export function settlePayment(amount:number,currency:string,id:string) { if(!Number.isFinite(amount)||amount<=0) throw Error('amount'); const cents=Math.round(amount*(currency==='JPY'?1:100)); return {minor:cents,key:[currency,id,cents].join('/')}; }`,
    ),
    ...noise(3, "invoice layout"),
  ],
  units: [
    {
      name: "PaymentOrder",
      query: "Submit payment orders",
      contract:
        "Export run(amount,currency,id). Reject non-finite or non-positive amounts. Round to nearest minor unit (JPY 0 digits, USD 2). Return {minor,key} with key currency/id/minor.",
      required: ["settlement"],
      test: `assert.deepEqual(run(2.375,'USD','A'),{minor:238,key:'USD/A/238'});assert.deepEqual(run(2.5,'JPY','B'),{minor:3,key:'JPY/B/3'}); for(const n of [0,-1,NaN,Infinity]) assert.throws(()=>run(n,'USD','A'));`,
    },
  ],
} satisfies Scenario;
