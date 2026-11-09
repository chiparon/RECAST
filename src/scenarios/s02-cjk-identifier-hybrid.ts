import { asset, noise, type Scenario } from "./types.js";
export default {
  id: "s02-cjk-identifier-hybrid",
  assets: [
    asset(
      "multipart",
      "MultipartStream",
      "MultipartStream parse_boundary_token 附件流式上传",
      `export function parse_boundary_token(chunks:string[],boundary:string,limit:number) {return chunks.join('').split('--'+boundary).map(x=>x.trim()).filter(x=>x&&x!=='--').map(body=>({body,disk:Buffer.byteLength(body)>limit}));}`,
    ),
    ...noise(4, "attachment upload progress"),
  ],
  units: [
    {
      name: "MultipartStreamUpload",
      query: "中文流式附件上传；解析 MultipartStream 的边界令牌并按阈值落盘",
      contract:
        "Export run(chunks,boundary,limit). Concatenate string chunks before splitting on --boundary. Trim each body, omit empty and terminal --. Return {body,disk} per part; disk iff UTF-8 bytes strictly exceed limit.",
      required: ["multipart"],
      test: `assert.deepEqual(run(['--X\\na','bc\\n--','X\\n猫猫\\n--X--'],'X',3),[{body:'abc',disk:false},{body:'猫猫',disk:true}]);assert.deepEqual(run(['--X--'],'X',0),[]);`,
    },
  ],
} satisfies Scenario;
