/** Classify provider failures, never arbitrary model prose or command output. */
export interface CodexOutputLimit {
  kind: 'truncated' | 'configuration';
}

export function classifyOutputLimit(message: string): CodexOutputLimit | undefined {
  // Context size, account quotas, rate limits and tool output have different
  // remedies. A continuation must not turn those failures into silent retries.
  if (/context[_\s-]*(?:length|window)|insufficient[_\s-]*quota|rate[_\s-]*limit|tool output/i.test(message)) return undefined;
  const output = /max[_\s-]*(?:output|completion)[_\s-]*tokens|output[_\s-]*tokens?|max_tokens|输出.{0,12}(?:token|令牌)/i;
  if (!output.test(message)) return undefined;
  if (/(?:must be|must not|cannot|can't|should|maximum (?:allowed|supported)|supported maximum|requested|parameter).{0,100}(?:less|greater|exceed|between|at most|range|large|limit)|(?:max[_\s-]*(?:output|completion)?[_\s-]*tokens|max_tokens).{0,60}(?:too (?:large|high)|must|unsupported|not supported)/i.test(message)) {
    return { kind: 'configuration' };
  }
  if (/exceed|reach|limit|truncat|incomplete|max_output_tokens|length|上限|截断/i.test(message)) return { kind: 'truncated' };
  return undefined;
}

/** A successful final turn takes precedence over earlier internally retried errors. */
export function codexOutputLimit(result: { exitCode: number | null; stdout: string; stderr: string; lastMessage: string }): CodexOutputLimit | undefined {
  let terminal: 'completed' | 'failed' | undefined;
  let failure: CodexOutputLimit | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const event = record(value);
    if (!event) continue;
    if (event.type === 'turn.started') { terminal = undefined; failure = undefined; }
    if (event.type === 'turn.completed') { terminal = 'completed'; failure = undefined; }
    if (event.type === 'turn.failed' || event.type === 'error' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      terminal = 'failed';
      const diagnostic = JSON.stringify({ message: event.message, code: event.code, error: event.error ?? record(event.response)?.error,
        details: record(event.response)?.incomplete_details ?? event.incomplete_details });
      // A trailing generic "turn failed" must not erase the specific provider
      // error. A new turn/completion or a different concrete cause supersedes it.
      const classified = classifyOutputLimit(diagnostic);
      failure = classified ?? (/context[_\s-]*(?:length|window)|unauthorized|credential|authentication|permission|policy|rate[_\s-]*limit|quota|network/i.test(diagnostic) ? undefined : failure);
    }
  }
  if (result.exitCode === 0 && terminal === 'completed' && result.lastMessage.trim()) return undefined;
  if (failure) return failure;
  return result.exitCode !== 0 ? classifyOutputLimit(result.stderr) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function outputLimitInstructions(stage: 'analyzer' | 'translator', retry: number): string {
  const size = retry > 1 ? 2_000 : 4_000;
  return [
    retry ? `OUTPUT LIMIT RECOVERY ${retry}: the previous model call exceeded its single-response output budget. Its final response is incomplete and must not be treated as a completion.` : 'Keep each model response small; complete the task through multiple tool calls.',
    stage === 'analyzer'
      ? 'Return a compact, complete implementation plan with file/symbol references. Do not quote source code, repeat the requirement, or include code dumps. Preserve every required behavior and dependency.'
      : `Previously executed edits remain in this same staging workspace. Inspect their current contents and continue the remaining work. Make one focused edit to one file or symbol per tool call, keeping generated arguments below ${size} characters; split large implementations into several edits. Do not rewrite an entire large file or put patches in the final response.`,
    'Keep the complete original requirement, write permissions, test criteria and validation obligations. Shorter outputs must not mean omitted behavior, placeholders, weaker assertions or premature success.',
    stage === 'translator' ? 'Finish only after the complete implementation is done. Return one compact JSON object containing a short summary, without code or test dumps.' : '',
  ].filter(Boolean).join('\n');
}
