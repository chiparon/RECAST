import { describe, expect, it } from 'vitest';
import { classifyOutputLimit, codexOutputLimit } from './codex-output-limit';

describe('Codex output-limit diagnostics', () => {
  it.each([
    'exceed output tokens', 'Exceeded the maximum output tokens',
    'Model response reached its output token limit.', 'max_output_tokens',
    'maximum number of output tokens reached', '输出 Token 达到上限',
  ])('recognizes truncated output: %s', message => {
    expect(classifyOutputLimit(message)).toEqual({ kind: 'truncated' });
  });
  it.each([
    'max_tokens must be less than or equal to 8192',
    'max_output_tokens is too large for this model',
    'Requested output tokens exceed the supported maximum of 8192',
  ])('distinguishes incompatible request parameters: %s', message => {
    expect(classifyOutputLimit(message)).toEqual({ kind: 'configuration' });
  });
  it.each(['context_length_exceeded: output tokens do not fit the context window',
    'rate limit exceeded', 'insufficient_quota', 'tool output tokens exceeded limit',
    '401 unauthorized', 'network connection reset', 'Codex translation timed out.'])('does not retry other failures: %s', message => {
    expect(classifyOutputLimit(message)).toBeUndefined();
  });
  it('ignores command output and successful turns that internally recovered', () => {
    const error = { type: 'error', message: 'exceed output tokens' };
    const completed = { type: 'turn.completed' };
    expect(codexOutputLimit({ exitCode: 0, lastMessage: 'done', stderr: '',
      stdout: [error, completed].map(event => JSON.stringify(event)).join('\n') })).toBeUndefined();
    expect(codexOutputLimit({ exitCode: 1, lastMessage: '', stderr: 'not authorized',
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'exceed output tokens' } }) })).toBeUndefined();
  });
  it('detects a failed zero-exit turn even when an earlier final message exists', () => {
    expect(codexOutputLimit({ exitCode: 0, lastMessage: 'Earlier summary', stderr: '', stdout:
      JSON.stringify({ type: 'turn.failed', error: { message: 'exceed output tokens' } }) })).toEqual({ kind: 'truncated' });
  });
  it('recognizes structured incomplete responses', () => {
    expect(codexOutputLimit({ exitCode: 1, lastMessage: '', stderr: '', stdout:
      JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }) })).toEqual({ kind: 'truncated' });
  });
  it('keeps a specific provider error when a generic terminal error follows', () => {
    expect(codexOutputLimit({ exitCode: 1, lastMessage: '', stderr: '', stdout: [
      { type: 'error', message: 'exceed output tokens' },
      { type: 'turn.failed', error: { message: 'Task failed' } },
    ].map(event => JSON.stringify(event)).join('\n') })).toEqual({ kind: 'truncated' });
  });
});
