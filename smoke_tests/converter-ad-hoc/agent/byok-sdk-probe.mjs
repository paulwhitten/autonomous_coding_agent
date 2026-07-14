// Probe: replicate the agent's exact SDK path (CopilotClient -> createSession
// -> send) with the BYOK env active, subscribing to ALL session events so we
// can see whether the headless/stdio server path honors the Azure provider or
// still hits GitHub Copilot (rate limit / error events).
//
// Run from agent/ AFTER byok_enable has exported COPILOT_PROVIDER_*.
import { CopilotClient } from '@github/copilot-sdk';

const model = process.env.PROBE_MODEL || 'gpt-4.1';
console.error(`[probe] model=${model}`);
console.error(`[probe] TYPE=${process.env.COPILOT_PROVIDER_TYPE} MODEL_ID=${process.env.COPILOT_PROVIDER_MODEL_ID} BASE=${process.env.COPILOT_PROVIDER_BASE_URL}`);

const client = new CopilotClient({ useLoggedInUser: false });
let gotAssistant = false;

// Build the per-session BYOK provider config from the same env byok_enable sets.
const provider = process.env.COPILOT_PROVIDER_BASE_URL
  ? {
      type: (process.env.COPILOT_PROVIDER_TYPE || 'openai'),
      baseUrl: process.env.COPILOT_PROVIDER_BASE_URL,
      apiKey: process.env.COPILOT_PROVIDER_API_KEY,
      wireApi: process.env.COPILOT_PROVIDER_WIRE_API || 'completions',
      azure: { apiVersion: process.env.COPILOT_PROVIDER_AZURE_API_VERSION || '2024-12-01-preview' },
    }
  : undefined;
console.error(`[probe] provider=${provider ? provider.type + ' ' + provider.baseUrl : 'none'}`);

try {
  await client.start();
  const session = await client.createSession({
    model,
    provider,
    streaming: false,
    onPermissionRequest: () => ({ result: 'allow' }),
  });
  console.error(`[probe] session created: ${session.sessionId}`);

  // Subscribe to every event type we care about.
  for (const ev of [
    'assistant.message', 'session.idle', 'session.error', 'error',
    'tool.execution', 'turn.completed', 'turn.failed',
  ]) {
    try {
      session.on(ev, (e) => {
        const blob = JSON.stringify(e?.data ?? e);
        const short = blob && blob.length > 300 ? blob.slice(0, 300) + '…' : blob;
        console.error(`[probe][event:${ev}] ${short}`);
        if (ev === 'assistant.message') gotAssistant = true;
      });
    } catch { /* event type may not exist; ignore */ }
  }

  console.error('[probe] sending prompt…');
  const msgId = await session.send({ prompt: 'Reply with exactly: PROBE_OK' });
  console.error(`[probe] send() returned messageId=${msgId}`);

  // Wait up to 45s for an assistant message, polling the flag.
  const deadline = Date.now() + 45000;
  while (!gotAssistant && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`[probe] gotAssistant=${gotAssistant}`);

  await client.deleteSession(session.sessionId).catch(() => {});
} catch (err) {
  console.error('[probe] ERROR:', String(err?.message || err));
  process.exitCode = 1;
} finally {
  await client.stop?.().catch(() => {});
}
