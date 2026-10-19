export interface ReferenceChoice {id:string;reason:string;evidence:string;incrementalValue:string}
export interface ReferenceRanking {id:string;score:number;covers:number[]}
/** Use model evidence labels, never filenames, languages or project-specific hints. */
export function chooseImplementationReferences(proposed:ReferenceChoice[], ranked:ReferenceRanking[]) {
 if(proposed.length<1||proposed.length>3)throw new Error('Expected 1-3 proposals');
 const byId=new Map(ranked.map(r=>[r.id,r]));const seen=new Set<string>();
 for(const p of proposed){if(seen.has(p.id)||!byId.has(p.id))throw new Error('Unknown or duplicate reference');seen.add(p.id);}
 const selected:ReferenceChoice[]=[];const rejected:Array<{id:string;reason:string}>=[];const covered=new Set<number>();
 for(const p of proposed){const r=byId.get(p.id)!;
  // Keep the primary partial reference even if the pool lacks a full implementation.
  if(selected.length && (r.score<0.5 || !r.covers.length)){
   rejected.push({id:p.id,reason:'No credible additional behavior evidence (score < 0.5 or empty covers)'});continue;
  }
  if(selected.length && r.covers.every(i=>covered.has(i))){
   rejected.push({id:p.id,reason:'All evidenced mechanisms already covered; alternative reference, not a complement'});continue;
  }
  selected.push(p);for(const i of r.covers)covered.add(i);
 }
 return {selected,rejected};
}

export const implementationReferenceInstruction = "任务是找到能借鉴的实现，不是凑齐三个相似模块，也不是最大化候选数量。先选一个源码最有用的主参考；默认到此结束。只有另一个候选的代码提供了目标确实需要、且前面已选参考没有提供的不同实现机制，才加入第二或第三个。最多三个是上限，不是配额。相同机制的不同异常类、同一API的包装/调用/界面展示、重复配置/接口声明应视为备选，从中保留最合适一个；不同语言或名字不同不是新增价值。不同职责标签也不是独有实现证据。先限定当前目标模块自己负责的逻辑：目标代码需要调用一个外部依赖，不代表要在本模块实现该依赖；参数类型、异常类型、依赖端口名称、辅助代码关键词都不是额外实现任务。补充参考必须对当前模块需要借鉴的生产逻辑有实质贡献。实现任务不要把主参考已使用的异常声明、DTO、接口或薄适配器当作独立补充；只有目标本身要设计契约时才为契约选参考。边缘辅助价值不足以单独入选。实现任务看方法体：展示权限警告不等于授权决策，调用接口不等于实现接口，记录异常不等于重试策略；这些是通用能力区分原则。契约任务可以参考真实类型与接口定义。判断只限展示的代码，摘要和上一阶段评分不是证明，不推断未展示能力。reason/incrementalValue只能描述引用的方法体实际做了什么：不要把目标需求套在候选身上，不能由API名、类型签名或摘要推断其已实现授权决策/事务/幂等。签名只能证明存在契约；接口调用只能证明有委托。不充分的目标能力写入missingResponsibilities。每项写reason说明要借鉴的机制，evidence给出预览中实际出现的具体方法/表达式及短源码片段，尽量引用原文，incrementalValue说明相对前面已选项新增的具体机制；第一项说明为何是主参考。若只能给出名称相关或笼统职责覆盖就不要选。给出missingResponsibilities说明选中源码没有提供的目标能力；缺口交给后续实现，不能用弱候选假装补齐。返回selected=[{\"id\":\"允许ID\",\"reason\":\"可借鉴机制\",\"evidence\":\"连续源码原文\",\"incrementalValue\":\"独有机制\"}]和missingResponsibilities=[\"缺少的能力\"]。selected通常只有1项，也可以2或3项，ID不重复。";

export interface ImplementationReferenceSelection {
 responsibilities: string[];
 candidates: ReferenceRanking[];
 proposed: ReferenceChoice[];
 selected: ReferenceChoice[];
 rejected: Array<{id:string;reason:string}>;
 missingResponsibilities: string[];
}
export function parseReferenceSelection(value: unknown, allowed: readonly string[]): ImplementationReferenceSelection {
 const v=value as {responsibilities:string[]; candidates:ReferenceRanking[]; selected:ReferenceChoice[]; missingResponsibilities:string[]};
 if(!Array.isArray(v?.selected)||v.selected.length<1||v.selected.length>3) throw new Error('selected must contain 1-3 references');
 for(const choice of v.selected) {
  if(!choice || !allowed.includes(choice.id)) throw new Error('Unknown selected reference');
  for(const key of ['reason','evidence','incrementalValue'] as const)
   if(typeof choice[key]!=='string'||!choice[key].trim()) throw new Error('selected.'+key+' must describe actual implementation evidence');
 }
 if(!Array.isArray(v.missingResponsibilities)||v.missingResponsibilities.some(x=>typeof x!=='string'||!x.trim())) throw new Error('missingResponsibilities must be a string array');
 const filtered=chooseImplementationReferences(v.selected,v.candidates);
 return {responsibilities:v.responsibilities,candidates:v.candidates,proposed:v.selected,...filtered,missingResponsibilities:v.missingResponsibilities};
}
