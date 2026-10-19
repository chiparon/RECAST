import {expect,it,vi} from 'vitest';
import {rankRetrievalWithReferences,parseRetrievalRerank} from './retrieval-rerank';
import {completeWithDeepSeek} from './deepseek-client';
vi.mock('./deepseek-client',()=>({completeWithDeepSeek:vi.fn()}));
const input={requirement:'implement parsing and storage',selectReferences:true,candidates:['a','b','c','d'].map(id=>({id,name:id,granularity:'module',relativePath:''}))};
const reference=(id:string)=>({id,reason:'actual mechanism',evidence:'method body',incrementalValue:'implementation'});
const response={responsibilities:['parse','store'],candidates:[{id:'a',score:.9,covers:[0]},{id:'b',score:.85,covers:[0]},{id:'c',score:.75,covers:[1]},{id:'d',score:.3,covers:[1]}],selected:[reference('a'),reference('b'),reference('c')],missingResponsibilities:['tenant guard']};
it('one call selects distinct mechanisms from the full shortlist and preserves gaps',async()=>{
 vi.mocked(completeWithDeepSeek).mockReset().mockResolvedValue(JSON.stringify(response));
 const result=await rankRetrievalWithReferences(input,new AbortController().signal);
 expect(result.order.slice(0,2)).toEqual(['a','c']);
 expect(result.selection?.proposed).toHaveLength(3);
 expect(result.selection?.selected.map(x=>x.id)).toEqual(['a','c']);
 expect(result.selection?.rejected[0].id).toBe('b');
 expect(result.selection?.missingResponsibilities).toEqual(['tenant guard']);
 expect(completeWithDeepSeek).toHaveBeenCalledTimes(1);
});
it('a malformed selection is retried with its actual failure and never falls back to top three',async()=>{
 vi.mocked(completeWithDeepSeek).mockReset().mockResolvedValue(JSON.stringify({...response,selected:[{id:'a',score:.9,covers:[0]}]}));
 await expect(rankRetrievalWithReferences(input,new AbortController().signal)).rejects.toThrow('selected.reason');
 expect(completeWithDeepSeek).toHaveBeenCalledTimes(2);
 const prompt=vi.mocked(completeWithDeepSeek).mock.calls[1][0][1].content;
 expect(prompt).toContain('selected.reason');
});
it('bounded API distinguishes the singleton automatic case from legacy ranking',()=>{
 expect(parseRetrievalRerank({...input,candidates:input.candidates.slice(0,1)}).selectReferences).toBe(true);
 expect(()=>parseRetrievalRerank({...input,selectReferences:false,candidates:input.candidates.slice(0,1)})).toThrow();
 expect(()=>parseRetrievalRerank({...input,selectReferences:'yes'})).toThrow();
});
