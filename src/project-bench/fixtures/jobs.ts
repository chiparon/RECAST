import { defineTask } from "../fixture-format.ts";
export default defineTask({
  id: "P03",
  title: "Leased job queue with deterministic retry scheduling",
  goal: "Build a dispatcher that chooses currently available jobs and applies outcomes for one dispatch cycle. Jobs are valid records {id,due,leaseUntil,failures}, with unique nonempty string ids, integer timestamps, leaseUntil either an integer or null, and failures a nonnegative integer. Every function must leave caller-owned arrays and jobs unchanged.",
  refs: {
    "refs/retry-wire.mjs": `// Retry timing and terminal failure contract; first failure has number 1.
export const MAX_FAILURES=3;
export function waitMs(number){ return 1250*2**(number-1); }`,
    "refs/lease-clock.mjs": `// Inclusive due and lease expiry at the current clock timestamp.
export function available(job,now){ return job.due<=now && (job.leaseUntil===null || job.leaseUntil<=now); }`,
  },
  modules: [
    {
      name: "RetryPolicy",
      description:
        "Export afterFailure(failures,now) where failures is the count BEFORE this attempt. Return {failures:next,due:timestamp}, with next=failures+1. When next reaches or exceeds refs/retry-wire.mjs MAX_FAILURES, due is null; otherwise due=now+waitMs(next). Inputs are valid.",
      skeleton:
        "export function afterFailure(failures,now){ throw new Error('TODO: retry policy'); }",
      smoke:
        "import {afterFailure} from '../RetryPolicy.mjs';assert.deepEqual(afterFailure(0,100),{failures:1,due:1350});",
    },
    {
      name: "LeaseQueue",
      description:
        "Export select(jobs,now,limit) returning eligible job ids. Use refs/lease-clock.mjs for availability. Pick at most limit by ascending due, breaking equal-due ties by original array position. Require limit to be a nonnegative safe integer; zero yields [].",
      skeleton:
        "export function select(jobs,now,limit){ throw new Error('TODO: lease selection'); }",
      smoke:
        "import {select} from '../LeaseQueue.mjs';assert.deepEqual(select([{id:'a',due:10,leaseUntil:null,failures:0}],10,1),['a']);assert.deepEqual(select([],10,0),[]);",
    },
    {
      name: "DispatchCycle",
      dependsOn: ["LeaseQueue", "RetryPolicy"],
      description:
        'Export dispatch(jobs,now,limit,outcomes). outcomes is an object mapping ids to "ok" or "fail". For selected ids in select order require an OWN outcome of either value; throw on missing/invalid selected outcomes. Ignore outcomes for unselected ids. On ok remove the job and append its id to completed. On fail use afterFailure: if due is null remove the job and append id to dead; otherwise replace due/failures, set leaseUntil=null, preserve other fields. Return {jobs,completed,dead}; jobs retain their original relative input order, completed/dead follow selection order.',
      skeleton:
        "export function dispatch(jobs,now,limit,outcomes){ throw new Error('TODO: dispatch cycle'); }",
      smoke:
        "import {dispatch} from '../DispatchCycle.mjs';assert.deepEqual(dispatch([],10,3,{}),{jobs:[],completed:[],dead:[]});",
    },
  ],
  jointSmoke:
    "import {dispatch} from '../DispatchCycle.mjs';const j={id:'j',due:9,leaseUntil:10,failures:1};assert.deepEqual(dispatch([j],10,1,{j:'fail'}),{jobs:[{id:'j',due:2510,leaseUntil:null,failures:2}],completed:[],dead:[]});",
  acceptance: [
    {
      id: "retry-boundaries",
      body: `import {afterFailure} from './RetryPolicy.mjs';
assert.deepEqual(afterFailure(0,0),{failures:1,due:1250});assert.deepEqual(afterFailure(1,7),{failures:2,due:2507});
assert.deepEqual(afterFailure(2,9),{failures:3,due:null});assert.deepEqual(afterFailure(9,5),{failures:10,due:null});`,
    },
    {
      id: "leases-ties-and-limit",
      body: `import {select} from './LeaseQueue.mjs';
const jobs=Object.freeze([['b',2,null],['future',9,null],['z',2,5],['leased',0,6],['a',0,null]].map(([id,due,leaseUntil])=>Object.freeze({id,due,leaseUntil,failures:0})));
assert.deepEqual(select(jobs,5,2),['a','b']);assert.deepEqual(select(jobs,5,9),['a','b','z']);assert.deepEqual(select(jobs,5,0),[]);for(const limit of [-1,1.5,NaN])assert.throws(()=>select(jobs,5,limit));`,
    },
    {
      id: "mixed-transitions",
      body: `import {dispatch} from './DispatchCycle.mjs';
const jobs=Object.freeze([['late',8,0],['retry',3,0],['die',4,2],['done',2,1],['later',100,0]].map(([id,due,failures])=>Object.freeze({id,due,failures,leaseUntil:null})));
const out=dispatch(jobs,10,3,{done:'ok',die:'fail',retry:'fail',later:'nonsense'});
assert.deepEqual(out,{jobs:[jobs[0],{id:'retry',due:1260,failures:1,leaseUntil:null},jobs[4]],completed:['done'],dead:['die']});assert.equal(jobs[1].due,3);`,
    },
    {
      id: "outcome-order",
      body: `import {dispatch} from './DispatchCycle.mjs';const jobs=['p','q','r'].map((id,i)=>({id,due:[2,1,1][i],failures:2,leaseUntil:3}));assert.deepEqual(dispatch(jobs,3,5,{p:'ok',q:'ok',r:'fail'}),{jobs:[],completed:['q','p'],dead:['r']});`,
    },
    {
      id: "invalid-outcomes",
      body: `import {dispatch} from './DispatchCycle.mjs';const j=Object.freeze({id:'toString',due:1,failures:0,leaseUntil:null});
for(const outcomes of [{},Object.create({toString:'ok'}),{toString:'later'}])assert.throws(()=>dispatch([j],1,1,outcomes));assert.deepEqual(dispatch([j],1,0,{}),{jobs:[j],completed:[],dead:[]});`,
    },
    {
      id: "retry-next-cycle",
      body: `import {dispatch} from './DispatchCycle.mjs';const j={id:'a',due:0,failures:1,leaseUntil:0,tag:'keep'};const a=dispatch([j],100,1,{a:'fail'});
assert.deepEqual(a.jobs,[{id:'a',due:2600,failures:2,leaseUntil:null,tag:'keep'}]);assert.deepEqual(dispatch(a.jobs,2599,1,{}),{jobs:a.jobs,completed:[],dead:[]});assert.deepEqual(dispatch(a.jobs,2600,1,{a:'fail'}),{jobs:[],completed:[],dead:['a']});`,
    },
  ],
});
