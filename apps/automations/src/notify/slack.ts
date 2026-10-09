import type { Env } from '../env.js';

/** One message to the run-alerts channel. Counts and run ids only. */
export async function postSlack(
  env: Env,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL) return;
  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL, text }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!res.ok || !body.ok)
    throw new Error(`Slack post failed: ${body.error ?? res.status}`);
}

/** Healthchecks.io-style ping; `/fail` marks the run failed. */
export async function pingHealthcheck(
  env: Env,
  ok: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!env.HEALTHCHECK_URL) return;
  const url = env.HEALTHCHECK_URL.replace(/\/$/, '') + (ok ? '' : '/fail');
  await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(10_000) });
}
