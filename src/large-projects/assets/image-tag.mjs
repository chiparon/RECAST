import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const hash = createHash("sha256");
for(const name of ["Dockerfile","package.json","package-lock.json","bridge.cjs"]) {
  hash.update(name).update(readFileSync(new URL("./browser-runtime/"+name,import.meta.url)));
}
export const image = "recast-bench-django-browser:"+hash.digest("hex").slice(0,16);
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(image);
