import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionFixture } from './context-compaction-fixtures';
import { buildAutomaticContext } from '../src/ai/server/automaticContext';
import { prepareAutomaticContext } from '../src/ai/server/automaticCompaction';
import { taskSummaryUnits,acceptTaskSummaries,summaryStorageBenefit } from '../src/ai/server/taskSummaryEngine';
import { selectProjectedSummaries,summaryProjectionBenefits } from '../src/ai/server/summaryAdmission';
import { allEvidence,validSummary } from '../src/ai/server/historyRepresentations';
import { Repository } from '../src/ai/server/repository';
import { AUTO_CONTEXT, type SummarySnapshot, type ContextBuildOptions } from '../src/ai/contextState';

globalThis.fetch=async()=>{throw new Error('Network calls prohibited in context tests');};

test('complete request savings admit metadata-heavy summaries and preserve source/user evidence',()=>{
  for(const spec of [{steps:5,records:8},{steps:3,records:2,sources:20},{steps:3,correction:true}]){
    const {state,task,old}=compactionFixture(spec),input=taskSummaryUnits(state,task,old.id),beforeState=JSON.stringify(state);
    const accepted=acceptTaskSummaries(state,task,[input],{summaries:[{taskId:old.id,unitIds:input.units.map(u=>u.id),
      summary:'核对已记录；用户更正和来源仍按原文保存，不代表所有来源当前相同。'}]},'round');
    assert.equal(accepted.length,1);assert.equal(JSON.stringify(state),beforeState);
    assert.ok(validSummary(accepted[0],allEvidence(state,task),accepted));
    assert.deepEqual(accepted[0].coverage,input.units.flatMap(u=>u.coverage));
    const before=buildAutomaticContext(state,task,[],x=>x,{mode:'refactor',maintenanceIntent:'capacity'});
    state.workspaces[0].summaries=accepted;
    const after=buildAutomaticContext(state,task,[],x=>x,{mode:'compact',maintenanceIntent:'capacity'});
    assert.ok(summaryProjectionBenefits(after,before));
    if(spec.records===8)assert.equal(summaryStorageBenefit(accepted[0],[input]),false,'Reproduce the old false rejection');
    if(spec.correction){assert.equal(accepted[0].intermediateUserMessages?.[0].text,'更正：预算上限为150元，不是500元；未完成部分不能标为成功。');
      assert.ok(JSON.stringify(after.messages).includes('150元'));}
    if(spec.sources){
      assert.equal(accepted[0].sourceBindings?.length,60);
      state.graph!.nodes['n-0-0'].content='changed';
      const stale=buildAutomaticContext(state,task,[],x=>x,{mode:'compact',maintenanceIntent:'capacity'});
      assert.ok(stale.stageDraft?.versionNotices?.facts.some(f=>f.kind==='摘要依据变动'));
      assert.equal(stale.canvasReadHashes?.['nodes:n-0-0'],undefined);
    }
  }
});

test('a harmful addition cannot discard a profitable batch; projection uses serialized request cost',()=>{
  const {state,task}=compactionFixture({steps:4});
  for(const m of state.messages)if(m.stepId==='step-0'||m.stepId==='step-1')m.text='依据固定版本完成检查，未发现差异；仍以当时版本为准。'.repeat(30);
  const input=taskSummaryUnits(state,task,'old');
  const candidates=acceptTaskSummaries(state,task,[input],{summaries:[
    {taskId:'old',unitIds:input.units.slice(0,2).map(u=>u.id),summary:'前两步核验已记录，只代表当时版本。'},
    {taskId:'old',unitIds:input.units.slice(2).map(u=>u.id),summary:'后两步完成检查，没有其他变化。'.repeat(400)}]},'mixed');
  const project=(summaries:SummarySnapshot[])=>{const draft=structuredClone(state);draft.workspaces[0].summaries=summaries;
    return buildAutomaticContext(draft,task,[],x=>x,{mode:'compact',maintenanceIntent:'capacity'});};
  const before=project([]),preferred=candidates.filter(s=>summaryStorageBenefit(s,[input]));
  assert.equal(preferred.length,1);assert.equal(summaryProjectionBenefits(project(candidates),before),false);
  const chosen=selectProjectedSummaries({before,preferred,candidates,project});
  assert.deepEqual(chosen,preferred);assert.ok(summaryProjectionBenefits(project(chosen),before));
  const newError={...project(chosen),error:'unrelated unsafe request',capacityEstimateError:undefined};
  assert.equal(summaryProjectionBenefits(newError,before),false);
  assert.equal(summaryProjectionBenefits({...before,requestTokens:0,contextMetrics:{...before.contextMetrics!,rawRequestTokens:before.requestTokens+1}},before),false);
});

type Scenario='normal'|'source-edit'|'inflated'|'projection-error'|'projection-edit'|'step-budget'|'token-budget'|'omitted'|'bad-range';
async function lifecycle(scenario:Scenario='normal',steps=5) {
  const fixture=compactionFixture({steps,records:8}),repo=new Repository(':memory:');
  repo.transaction(()=>{repo.state=fixture.state;});
  const state=repo.state,task=state.tasks.find(t=>t.id===fixture.task.id)!;
  state.provider.contextWindow=22000;state.provider.maxOutputTokens=1024;state.provider.apiFamily=undefined;state.provider.model='offline-context';
  if(scenario==='step-budget')task.maxSteps=1;
  if(scenario==='token-budget')task.maxTokens=1;
  let calls=0,projections=0;
  const changeSource=()=>{const m=state.messages.find(m=>m.id==='msg-0-0')!;m.version++;m.text+=' 用户已修改此条记录。';};
  const build=(options?:ContextBuildOptions)=>{
    const ownsSummary=!!repo.state.workspaces[0].summaries?.length;
    if(ownsSummary){projections++;
      if(!(repo.state.workspaces[0].sessionContext?.historicalSummaryCounts.old)){
        assert.ok(!options?.summaryMaintenance?.evicted.has('test-rejected-probe'),'A projection must not inherit another probe\'s evictions');
        options?.summaryMaintenance?.evicted.add('test-rejected-probe');
      }
      if(scenario==='projection-error')throw new Error('synthetic projection failure');
      if(scenario==='projection-edit')changeSource();
    }
    return buildAutomaticContext(repo.state,task,[],x=>x,options);
  };
  try{
    const manifest=await prepareAutomaticContext({repo,task,signal:new AbortController().signal,guard:()=>{},build,
      caller:async(provider,_credential,request)=>{
        calls++;assert.equal(provider.thinkingEffort,state.provider.thinkingEffort);
        const payload=JSON.parse(String(request.messages[1].content));
        assert.ok(payload.ranges?.length);assert.equal(payload.tasks,undefined);
        if(scenario==='source-edit')changeSource();
        return {text:JSON.stringify({summaries:scenario==='omitted'?[]:payload.ranges.map((r:{rangeId:string})=>({
          rangeId:scenario==='bad-range'?'invented':r.rangeId,
          summary:scenario==='inflated'?'没有新增证据，不能断言完成。'.repeat(800):'各步骤已完成检查并记录结果，未报告新增问题。'}))}),
          outputTokens:100,finishReason:'stop',toolCalls:[]};
      }});
    assert.equal(repo.state.tasks.find(t=>t.id===task.id),task,'Recoverable projection failure must not detach the live task');
    assert.equal(task.memoryCalls??0,calls);
    return {manifest,state:structuredClone(repo.state),calls,projections};
  }finally{repo.close();}
}

test('actual compaction admits useful ranges, retains history and counts one historical round',async()=>{
  const result=await lifecycle();
  assert.equal(result.calls,1);assert.equal(result.state.workspaces[0].summaries?.length,1);
  assert.ok(result.manifest.stageDraft?.residentTaskIds?.includes('old'));
  assert.equal(result.manifest.stageDraft?.metrics?.targetReached,true);
  assert.equal(result.state.workspaces[0].sessionContext?.historicalSummaryCounts.old,1);
  assert.equal(result.state.tasks.find(t=>t.id==='current')?.memoryCalls,1);
});

test('multiple assigned ranges share one call and one historical-round count',async()=>{
  const result=await lifecycle('normal',11),workspace=result.state.workspaces[0];
  assert.equal(result.calls,1);assert.equal(workspace.summaries?.length,3);
  assert.deepEqual(workspace.summaries?.map(s=>s.inputUnitIds?.length).sort(),[3,4,4]);
  assert.equal(workspace.sessionContext?.historicalSummaryCounts.old,1);
  assert.equal(workspace.sessionContext?.countedSummaryRounds?.old.length,1);
});

test('await edits, malformed ranges, no-benefit and projection failures never persist summaries',async()=>{
  for(const scenario of ['source-edit','inflated','projection-error','projection-edit','omitted','bad-range'] as const){
    const result=await lifecycle(scenario);
    assert.equal(result.state.workspaces[0].summaries?.length??0,0,scenario);
    assert.equal(result.state.workspaces[0].sessionContext?.historicalSummaryCounts.old??0,0,scenario);
    assert.ok(result.calls<=AUTO_CONTEXT.maxCalls,scenario);
    if(scenario==='source-edit')assert.equal(result.calls,AUTO_CONTEXT.maxCalls);
    assert.ok(!result.manifest.error,scenario);
    assert.ok(result.state.messages.some(m=>m.id==='msg-0-0'),scenario);
  }
});

test('summary calls respect remaining task step/token budgets',async()=>{
  for(const scenario of ['step-budget','token-budget'] as const){
    const result=await lifecycle(scenario);assert.equal(result.calls,0);
    assert.equal(result.state.workspaces[0].summaries?.length??0,0);assert.ok(!result.manifest.error);
  }
});
