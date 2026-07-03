// Minimal reproduction of the agent's SDK path to test BYOK in server/stdio mode.
// Mirrors session-manager.ts: new CopilotClient(), createSession({model}), send one prompt.
import { CopilotClient } from '@github/copilot-sdk';

const model = process.env.COPILOT_MODEL || 'gpt-4.1';
console.error(`[repro] BASE_URL=${process.env.COPILOT_PROVIDER_BASE_URL || '<unset>'} MODEL=${model}`);

const client = new CopilotClient(); // exactly what agent.ts does (no options)

try {
  const session = await client.createSession({ model, streaming: false, onPermissionRequest: async () => ({ result: 'allow' }) });
  console.error(`[repro] session created: ${session.sessionId}`);
  const res = await session.sendAndWait({ prompt: 'Reply with exactly: BYOK_OK' }, 60000);
  const text = res?.data?.content ?? (typeof res === 'string' ? res : JSON.stringify(res).slice(0, 400));
  console.error('[repro] RESPONSE:', text);
  console.error('[repro] RESULT: SUCCESS (no rate limit -> BYOK likely active)');
} catch (e) {
  console.error('[repro] ERROR:', String(e).slice(0, 500));
  console.error('[repro] RESULT: FAILED');
} finally {
  try { await client.stop?.(); } catch {}
  process.exit(0);
}
