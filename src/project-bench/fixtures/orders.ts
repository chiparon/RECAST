import { defineTask } from "../fixture-format.ts";
export default defineTask({
  id: "P01",
  title: "Order batch posting and audit",
  goal: "Turn an input array of orders into a balanced posting batch and its audit outbox. Keep source records unchanged even if validation fails.",
  refs: {
    "refs/posting-keys.mjs": `// Stable protocol keys for posting and audit consumers. Identifiers may contain separators or Unicode.
export function postingKey(id){ return 'L/'+encodeURIComponent(id); }
export function auditKey(posting){ return 'posted:'+posting; }`,
    "refs/cents.mjs": `// Monetary contract shared by debit, credit, and aggregate reporting.
export function positiveCents(n){ if(!Number.isSafeInteger(n)||n<1) throw new RangeError('invalid cents'); return n; }
export function addCents(a,b){ const sum=a+b; if(!Number.isSafeInteger(sum)) throw new RangeError('overflow'); return sum; }`,
  },
  modules: [
    {
      name: "OrderIntake",
      description:
        "Export normalize(row). Require an object with a nonblank string id and positive safe integer cents. Return a new {id,cents} with id trimmed (case sensitive) and only these fields. Use refs/cents.mjs for the monetary contract.",
      skeleton:
        "export function normalize(row) { throw new Error('TODO: order intake'); }",
      smoke:
        "import {normalize} from '../OrderIntake.mjs'; assert.deepEqual(normalize({id:' a ',cents:5}),{id:'a',cents:5}); assert.throws(()=>normalize({id:'a',cents:0}));",
    },
    {
      name: "LedgerPosting",
      dependsOn: ["OrderIntake"],
      description:
        "Export post(row), accepting the same raw row and validation rules as normalize. Produce {key,debit,credit}, using refs/posting-keys.mjs postingKey on the normalized id, debit=cents and credit=-cents.",
      skeleton:
        "export function post(row) { throw new Error('TODO: ledger posting'); }",
      smoke:
        "import {post} from '../LedgerPosting.mjs'; assert.deepEqual(post({id:'k',cents:7}),{key:'L/k',debit:7,credit:-7});",
    },
    {
      name: "AuditOutbox",
      dependsOn: ["OrderIntake", "LedgerPosting"],
      description:
        'Export settle(rows). Return {total,postings,events}. For each unique normalized id in first appearance order, append post(row) and {topic:"posted",dedup:auditKey(posting.key),amount:posting.debit}. Equal id and cents replays are ignored. Conflicting cents for an existing id throw. Reject invalid rows and unsafe total via refs/cents.mjs. The empty batch has total 0 and empty arrays.',
      skeleton:
        "export function settle(rows) { throw new Error('TODO: batch settlement'); }",
      smoke:
        "import {settle} from '../AuditOutbox.mjs'; assert.deepEqual(settle([]),{total:0,postings:[],events:[]});",
    },
  ],
  jointSmoke:
    "import {settle} from '../AuditOutbox.mjs'; assert.deepEqual(settle([{id:' ab ',cents:3},{id:'ab',cents:3}]),{total:3,postings:[{key:'L/ab',debit:3,credit:-3}],events:[{topic:'posted',dedup:'posted:L/ab',amount:3}]});",
  acceptance: [
    {
      id: "intake-validation",
      body: `import {normalize} from './OrderIntake.mjs';
for(const row of [null,{}, {id:3,cents:1},{id:'   ',cents:1}, ...[0,-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1].map(cents=>({id:'x',cents}))])assert.throws(()=>normalize(row));
const row=Object.freeze({id:'  Ω/a  ',cents:Number.MAX_SAFE_INTEGER,note:'discard'});assert.deepEqual(normalize(row),{id:'Ω/a',cents:Number.MAX_SAFE_INTEGER});`,
    },
    {
      id: "posting-wire-format",
      body: `import {post} from './LedgerPosting.mjs';
for(const id of ['a/b','x%y','ç b','__proto__'])assert.deepEqual(post({id:' '+id+' ',cents:19}),{key:'L/'+encodeURIComponent(id),debit:19,credit:-19});
assert.throws(()=>post({id:'x',cents:-1}));`,
    },
    {
      id: "batch-integration",
      body: `import {settle} from './AuditOutbox.mjs';
const out=settle([{id:' A/B ',cents:13},{id:'c %',cents:4},{id:'A/B',cents:13}]);
assert.deepEqual(out,{total:17,postings:[{key:'L/A%2FB',debit:13,credit:-13},{key:'L/c%20%25',debit:4,credit:-4}],events:[{topic:'posted',dedup:'posted:L/A%2FB',amount:13},{topic:'posted',dedup:'posted:L/c%20%25',amount:4}]});`,
    },
    {
      id: "first-occurrence-and-case",
      body: `import {settle} from './AuditOutbox.mjs';
const out=settle(['b','B','__proto__',' b '].map(id=>({id,cents:2})));
assert.deepEqual(out.postings.map(p=>p.key),['L/b','L/B','L/__proto__']);assert.equal(out.total,6);assert.equal(out.events.length,3);`,
    },
    {
      id: "conflict-isolation",
      body: `import {settle} from './AuditOutbox.mjs';
const rows=Object.freeze([{id:' x ',cents:1},{id:'y',cents:7},{id:'x',cents:2}].map(Object.freeze));
assert.throws(()=>settle(rows));assert.equal(rows[0].id,' x ');
assert.deepEqual(settle([]),{total:0,postings:[],events:[]});`,
    },
    {
      id: "aggregate-boundary",
      body: `import {settle} from './AuditOutbox.mjs';
const max=Number.MAX_SAFE_INTEGER; assert.equal(settle([{id:'p',cents:max},{id:'p',cents:max}]).total,max);
assert.throws(()=>settle([{id:'p',cents:max},{id:'q',cents:1}])); assert.throws(()=>settle([{id:'p',cents:1},{id:'q',cents:NaN}]));`,
    },
  ],
});
