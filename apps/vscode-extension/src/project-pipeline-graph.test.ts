import { describe, expect, it } from 'vitest';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Annotation, END, START, MemorySaver, StateGraph } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { createProjectPipelineGraph, type ProjectPipelineGraphSteps } from './project-pipeline-graph';

function steps(overrides: Partial<ProjectPipelineGraphSteps>): ProjectPipelineGraphSteps {
  return {
    prepare: async () => 1,
    moduleCompleted: () => false,
    retrieve: async () => {},
    generate: async () => {},
    prepareIntegration: () => 0,
    integrate: async () => {},
    startValidation: () => {},
    validate: async () => true,
    repair: async () => {},
    publish: async () => {},
    ...overrides,
  };
}

describe('project graph preserves independent verifier execution', () => {
  it('keeps one Agent conversation and cumulative message history across feedback invocations', async () => {
    const saver = new MemorySaver();
    const agent = createAgent({
      model: new FakeListChatModel({ responses: ['agent report'] }),
      tools: [],
      checkpointer: saver,
    });
    const config = { configurable: { thread_id: 'same-verifier-host-run' } };
    let finalMessages: BaseMessage[] = [];
    const graph = createProjectPipelineGraph(steps({
      generate: async () => {
        await agent.invoke({ messages: [new HumanMessage('verify this implementation')] }, config);
        const result = await agent.invoke({ messages: [new HumanMessage('host feedback: explain the failing test')] }, config);
        finalMessages = result.messages;
      },
    }));

    await graph.invoke({}, { recursionLimit: Number.MAX_SAFE_INTEGER });

    expect(finalMessages.map(message => message.content)).toEqual([
      'verify this implementation', 'agent report', 'host feedback: explain the failing test', 'agent report',
    ]);
    const namespaces = new Set<string>();
    for await (const checkpoint of saver.list(config)) namespaces.add(checkpoint.config.configurable?.checkpoint_ns ?? '');
    expect([...namespaces]).toEqual(['']);
  });

  it('retains independent checkpoint identity when existing validation invokes a graph twice', async () => {
    const state = Annotation.Root({ count: Annotation<number>() });
    const saver = new MemorySaver();
    const verifier = new StateGraph(state)
      .addNode('observe', value => ({ count: value.count + 1 }))
      .addEdge(START, 'observe').addEdge('observe', END)
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: 'same-validation-run' } };
    const counts: number[] = [];
    const graph = createProjectPipelineGraph(steps({
      validate: async () => {
        counts.push((await verifier.invoke({ count: 0 }, config)).count);
        counts.push((await verifier.invoke({}, config)).count);
        return true;
      },
    }));

    await graph.invoke({}, { recursionLimit: Number.MAX_SAFE_INTEGER });

    expect(counts).toEqual([1, 2]);
  });
});
