import { defineTask } from "../fixture-format.ts";
export default defineTask({
  id: "P02",
  title: "Tenant claim deductions with an atomic outbox",
  goal: "Apply claim deductions atomically to a tenant balance and append replay-safe events. State and request objects must never be modified. State supplied to the service has a nonnegative safe-integer balance and an array of existing {key,cents} event records.",
  refs: {
    "refs/claim-keys.mjs": `// Tenant-qualified wire key, used by the outbox and by replay lookups.
export function claimKey(tenant,id){ return 'claim/'+encodeURIComponent(tenant)+'/'+encodeURIComponent(id); }`,
    "refs/deduction-policy.mjs": `// Validate deduction amounts and enforce the available balance.
export function centsOf(value){ if(!Number.isSafeInteger(value)||value<=0)throw new RangeError('invalid deduction');return value; }
export function debit(balance,cents){ if(cents>balance)throw new RangeError('insufficient balance');return balance-cents; }`,
  },
  modules: [
    {
      name: "ClaimPolicy",
      description:
        "Export prepare(tenant,row). Validate tenant and row.id as nonblank strings, trim both (case sensitive), validate row.cents via refs/deduction-policy.mjs centsOf, and return exactly {key,cents} using refs/claim-keys.mjs claimKey.",
      skeleton:
        "export function prepare(tenant,row){ throw new Error('TODO: claim policy'); }",
      smoke:
        "import {prepare} from '../ClaimPolicy.mjs';assert.deepEqual(prepare(' t ',{id:' k ',cents:8}),{key:'claim/t/k',cents:8});assert.throws(()=>prepare('t',{id:'x',cents:0}));",
    },
    {
      name: "OutboxJournal",
      dependsOn: ["ClaimPolicy"],
      description:
        'Export classify(events,claim), where claim is the {key,cents} returned by prepare. Return "new" if key is absent, "replay" for a matching key and amount. Throw on a matching key with a different amount. Existing events have unique keys; do not mutate either argument.',
      skeleton:
        "export function classify(events,claim){ throw new Error('TODO: outbox journal'); }",
      smoke:
        "import {classify} from '../OutboxJournal.mjs';assert.equal(classify([],{key:'claim/a/k',cents:5}),'new');",
    },
    {
      name: "ClaimSettlement",
      dependsOn: ["ClaimPolicy", "OutboxJournal"],
      description:
        "Export apply(state,tenant,rows). Return a fresh {balance,events} with a fresh events array. Preserve previous event order. In input order, prepare and classify each row against all events accumulated so far. Ignore replays before checking balance. For new claims debit via refs/deduction-policy.mjs and append their {key,cents}. Throw on conflict, invalid rows or insufficient funds, including failures midway. Return a fresh equivalent state for an empty batch.",
      skeleton:
        "export function apply(state,tenant,rows){ throw new Error('TODO: atomic settlement'); }",
      smoke:
        "import {apply} from '../ClaimSettlement.mjs';assert.deepEqual(apply({balance:7,events:[]},'a',[]),{balance:7,events:[]});",
    },
  ],
  jointSmoke:
    "import {apply} from '../ClaimSettlement.mjs';const state={balance:10,events:[]};assert.deepEqual(apply(state,'a',[{id:'x',cents:5},{id:'x',cents:5}]),{balance:5,events:[{key:'claim/a/x',cents:5}]});assert.deepEqual(state,{balance:10,events:[]});",
  acceptance: [
    {
      id: "policy-wire",
      body: `import {prepare} from './ClaimPolicy.mjs';const row=Object.freeze({id:' π/x ',cents:23});assert.deepEqual(prepare(' t/1 ',row),{key:'claim/t%2F1/%CF%80%2Fx',cents:23});
for(const args of [[' ',row],[1,row],['t',{id:'',cents:1}],...[-1,0,1.25,Number.MAX_SAFE_INTEGER+1].map(cents=>['t',{id:'x',cents}])])assert.throws(()=>prepare(...args));`,
    },
    {
      id: "classify-existing",
      body: `import {classify} from './OutboxJournal.mjs';
const es=Object.freeze([Object.freeze({key:'x',cents:10}),Object.freeze({key:'y',cents:9})]);
assert.equal(classify(es,{key:'z',cents:1}),'new');assert.equal(classify(es,{key:'y',cents:9}),'replay');assert.throws(()=>classify(es,{key:'y',cents:10}));`,
    },
    {
      id: "replay-before-balance",
      body: `import {apply} from './ClaimSettlement.mjs';const e=Object.freeze({key:'claim/T/id',cents:20});const state=Object.freeze({balance:0,events:Object.freeze([e])});const out=apply(state,' T ',[{id:' id ',cents:20}]);assert.deepEqual(out,state);assert.notEqual(out,state);assert.notEqual(out.events,state.events);`,
    },
    {
      id: "tenant-and-order",
      body: `import {apply} from './ClaimSettlement.mjs';const original={balance:40,events:[{key:'claim/other/a',cents:9}]};
const out=apply(original,'tenant',[{id:'a',cents:15},{id:'b',cents:25},{id:' a ',cents:15}]);
assert.deepEqual(out,{balance:0,events:[{key:'claim/other/a',cents:9},{key:'claim/tenant/a',cents:15},{key:'claim/tenant/b',cents:25}]});
assert.deepEqual(original,{balance:40,events:[{key:'claim/other/a',cents:9}]});`,
    },
    {
      id: "midbatch-conflicts",
      body: `import {apply} from './ClaimSettlement.mjs';const s={balance:8,events:[]};
for(const second of [{id:'a',cents:4},{id:'b',cents:8},{id:'b',cents:1.5}]){assert.throws(()=>apply(s,'t',[{id:'a',cents:3},second]));assert.deepEqual(s,{balance:8,events:[]});}
const posted=apply(s,'t',[{id:'a',cents:3}]);assert.throws(()=>apply(posted,'t',[{id:'a',cents:1}]));assert.equal(posted.balance,5);`,
    },
    {
      id: "successive-requests",
      body: `import {apply} from './ClaimSettlement.mjs';const a=apply({balance:13,events:[]},'a/b',[{id:'k%',cents:8}]);
const b=apply(a,'a/b',[{id:'k%',cents:8},{id:'last',cents:5}]);assert.equal(b.balance,0);assert.deepEqual(b.events,[{key:'claim/a%2Fb/k%25',cents:8},{key:'claim/a%2Fb/last',cents:5}]);assert.equal(a.balance,5);assert.equal(a.events.length,1);`,
    },
  ],
});
