import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s04-attachment-quarantine-gate",
  assets: [
    asset(
      "tenant",
      "ownsAttachment",
      "Tenant ownership attachment authorization",
      `export function ownsAttachment(a:string,b:string){return a===b;}`,
    ),
    asset(
      "signature",
      "detectPdf",
      "PDF filename MIME and magic signature validation",
      `export function detectPdf(name:string,mime:string,magic:string){return name.toLowerCase().endsWith('.pdf') && mime==='application/pdf' && magic.startsWith('%PDF-');}`,
    ),
    asset(
      "quarantine",
      "scanRelease",
      "Quarantine approval of scanned attachments",
      `export function scanRelease(scan:string){return scan==='clean';}`,
    ),
    ...noise(5, "attachment gateway upload display"),
  ],
  units: [
    {
      name: "AttachmentGateway",
      query:
        "Tenant ownership authorization；PDF filename MIME signature validation；quarantine until scan approval",
      contract:
        "Export run(tenant,owner,name,mime,magic,scan). Return the first failing reason tenant/signature/quarantine, else allow. Accept case-insensitive .pdf, application/pdf and %PDF- prefix. Only clean scans may pass.",
      required: ["tenant", "signature", "quarantine"],
      test: `const f=(t,n,m,p,s)=>run(t,'a',n,m,p,s);assert.equal(f('b','x.pdf','application/pdf','%PDF-1','clean'),'tenant');for(const [n,m,p] of [['x.png','application/pdf','%PDF-1'],['a.pdf','image/png','%PDF-1'],['a.pdf','application/pdf','PDF']]) assert.equal(f('a',n,m,p,'clean'),'signature');assert.equal(f('a','a.pdf','application/pdf','%PDF-1','pending'),'quarantine');assert.equal(f('a','a.PDF','application/pdf','%PDF-1','clean'),'allow');`,
    },
  ],
} satisfies Scenario;
