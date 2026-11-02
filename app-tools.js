// Application handlers are server-owned closures; only schemas enter the API.
export async function runAppToolLoop(body, registry, send, { deadline }) {
  const results = new Map();
  let rounds = 0;
  let executions = 0;
  for (;;) {
    if (Date.now() >= deadline) throw new Error('OPENROUTER_DEADLINE');
    const result = await send(body);
    const message = result.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (!Array.isArray(calls)) throw new Error('INVALID_TOOL_CALLS');
    if (!calls.length) return result;
    if (rounds >= 4 || calls.length > 8) throw new Error('APP_TOOL_ROUND_LIMIT');
    rounds += 1;
    body.messages.push({ ...message, role: 'assistant' });
    for (const call of calls) {
      if (typeof call?.id !== 'string' || !call.id || call.id.length > 200) throw new Error('INVALID_TOOL_CALL_ID');
      const name = call.function?.name;
      const signature = JSON.stringify([name, call.function?.arguments]);
      let output;
      const cached = results.get(call.id);
      if (cached) output = cached.signature === signature ? cached.output : { error: 'duplicate_id_mismatch' };
      else {
        try {
          if (call.type !== 'function' || !Object.hasOwn(registry, name)) output = { error: 'unknown_tool' };
          else if (++executions > 8 || Date.now() >= deadline) output = { error: 'tool_budget_exhausted' };
          else {
            if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 5000) throw new Error('INVALID_ARGUMENTS');
            const args = JSON.parse(call.function.arguments);
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
            // Await effects to completion. A Promise.race timeout would allow a
            // database write to continue after reporting a timeout to the model.
            output = await registry[name].run(args, { deadline });
          }
        } catch (error) {
          output = { error: error.message === 'MEMORY_WRITE_UNCERTAIN'
            ? 'write_outcome_uncertain_do_not_claim_success'
            : error.message === 'MEMORY_SCOPE_CHANGED' ? 'memory_changed_do_not_retry_this_turn' : 'tool_failed' };
        }
        results.set(call.id, { signature, output });
      }
      body.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output ?? null) });
    }
    if (rounds >= 4 || executions >= 8) body.tool_choice = 'none';
  }
}
