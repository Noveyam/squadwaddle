import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleInteraction, handleVoiceRoomInteraction, EPHEMERAL, REPLAY_NOTICE, type PilotConfig } from './discord.ts';
import type { SessionStoreContract } from './types.ts';
import { VoicePilot, type VoicePilotDependencies } from './voice-pilot.ts';

/** Signature protocol: https://docs.discord.com/developers/interactions/overview
 * We verify the exact timestamp + raw request bytes, before any JSON parsing.
 * The five-minute freshness window is our local replay policy, not a Discord guarantee.
 */
export type ServerConfig = PilotConfig & { publicKey: string; host: string; port: number; dbPath: string };
const FRESHNESS_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const SNOWFLAKE = /^\d{17,20}$/;
const PAIR_FORMAT_ERROR = 'PILOT_ALLOWED_PAIRS must list comma-separated guild ID:channel ID pairs, with each channel listed once.';

function validSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

function validateAllowedPairs(pairs: PilotConfig['allowedPairs']): void {
  if (!Array.isArray(pairs) || !pairs.length ||
      pairs.some(pair => !validSnowflake(pair?.guildId) || !validSnowflake(pair?.channelId)) ||
      new Set(pairs.map(pair => pair.channelId)).size !== pairs.length) {
    throw new Error(PAIR_FORMAT_ERROR);
  }
}

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const required = (name: string, pattern: RegExp): string => {
    const value = env[name] ?? '';
    if (!pattern.test(value)) throw new Error(`${name} is missing or invalid.`);
    return value;
  };
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const applicationId = required('DISCORD_APPLICATION_ID', SNOWFLAKE);
  const allowedPairs = env.PILOT_ALLOWED_PAIRS === undefined
    ? [{ guildId: required('PILOT_GUILD_ID', SNOWFLAKE), channelId: required('PILOT_CHANNEL_ID', SNOWFLAKE) }]
    : env.PILOT_ALLOWED_PAIRS.split(',').map(entry => {
      const [guildId, channelId, extra] = entry.trim().split(':');
      if (extra !== undefined) throw new Error(PAIR_FORMAT_ERROR);
      return { guildId, channelId };
    });
  validateAllowedPairs(allowedPairs);
  const publish = env.PILOT_PUBLISH_ENABLED ?? 'yes';
  if (publish !== 'yes' && publish !== 'no') throw new Error('PILOT_PUBLISH_ENABLED must be yes or no.');
  return { applicationId, allowedPairs, publishingEnabled: publish === 'yes',
    publicKey: required('DISCORD_PUBLIC_KEY', /^[a-fA-F0-9]{64}$/), host: env.HOST || '127.0.0.1', port,
    dbPath: env.DB_PATH || './data/next-session.sqlite' };
}

function verificationKey(hex: string): KeyObject {
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error('A valid Discord application public key is required.');
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

export function verifyDiscordSignature(key: KeyObject, signature: unknown, timestamp: unknown, body: Buffer,
  nowMs = Date.now()): boolean {
  if (typeof signature !== 'string' || !/^[a-fA-F0-9]{128}$/.test(signature) ||
      typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(nowMs / 1000 - seconds) > FRESHNESS_SECONDS) return false;
  try { return verify(null, Buffer.concat([Buffer.from(timestamp, 'ascii'), body]), key, Buffer.from(signature, 'hex')); }
  catch { return false; }
}

class HttpError extends Error {
  status: number;
  constructor(status: number) { super('Invalid request'); this.status = status; }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(new HttpError(408)), 1500);
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); };
    const fail = (error: unknown) => { cleanup(); req.pause(); reject(error); };
    const aborted = () => fail(new HttpError(400));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(new HttpError(413));
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolveBody(Buffer.concat(chunks, size)); };
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted);
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

/** Responses are inline Discord callbacks. The default runtime has no outbound calls.
 * The local replay set covers all interactions while running. Successful Publish IDs also survive
 * a restart with file-backed SQLite. Delivery after the database commit remains unreconciled.
 * No interaction tokens, raw bodies, names, or request headers are logged or retained here.
 */
export function createInteractionServer(config: ServerConfig, store: SessionStoreContract,
  now: () => number = Date.now, voiceDependencies?: VoicePilotDependencies) {
  const key = verificationKey(config.publicKey); // Fail closed before opening a socket.
  if (!validSnowflake(config.applicationId)) throw new Error('DISCORD_APPLICATION_ID is missing or invalid.');
  validateAllowedPairs(config.allowedPairs);
  const voiceScopes = config.publishingEnabled === false ? [] : config.voiceScopes?.map(scope => ({ ...scope })) ?? [];
  if (voiceScopes.length && !voiceDependencies) throw new Error('Configured voice pilot scopes require an injected voice registry and REST transport.');
  const voicePilot = voiceScopes.length && voiceDependencies
    ? new VoicePilot(store, voiceScopes, config.allowedPairs, voiceDependencies, now) : undefined;
  const interactionConfig = { ...config, voiceScopes };
  const completed = new Map<string, number>();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') { json(res, 200, { ok: true }); return; }
      if (req.url !== '/interactions') { json(res, 404, { error: 'Not found' }); return; }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); json(res, 405, { error: 'Method not allowed' }); return; }
      const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (mediaType !== 'application/json' || req.headers['content-encoding']) throw new HttpError(415);
      const contentLength = req.headers['content-length'];
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) throw new HttpError(413);
      const body = await readBody(req);
      if (!verifyDiscordSignature(key, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], body, now())) {
        json(res, 401, { error: 'Invalid request signature' }); return;
      }
      let input: unknown;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { throw new HttpError(400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400);
      const payload = input as Record<string, unknown>;
      if (payload.application_id !== config.applicationId) throw new HttpError(401);
      if (payload.type === 1) { json(res, 200, handleInteraction(payload, store, config)); return; }
      if (typeof payload.id !== 'string' || !SNOWFLAKE.test(payload.id)) throw new HttpError(400);
      const time = now();
      for (const [id, expiresAt] of completed) if (time > expiresAt) completed.delete(id);
      if (completed.has(payload.id)) {
        json(res, 200, { type: 4, data: { flags: EPHEMERAL, allowed_mentions: { parse: [] },
          content: REPLAY_NOTICE } }); return;
      }
      if (completed.size >= 10_000) throw new HttpError(503);
      const data = payload.data as Record<string, unknown> | undefined;
      const componentId = payload.type === 3 && data?.component_type === 2 && typeof data.custom_id === 'string'
        ? data.custom_id : '';
      const expiresAt = Math.max(time, Number(req.headers['x-signature-timestamp']) * 1000) + FRESHNESS_SECONDS * 1000;
      if (componentId.startsWith('ns:voice-room:')) {
        // Claim the signed interaction before awaiting the injected transport.
        completed.set(payload.id, expiresAt);
        json(res, 200, await handleVoiceRoomInteraction(payload, interactionConfig, voicePilot));
        return;
      }
      const reply = handleInteraction(payload, store, interactionConfig, time);
      // Only a fresh, committed Publish returns a public card. Let a rolled-back write retry.
      if (!componentId.startsWith('ns:publish:') || (reply.type === 4 && ((reply.data.flags ?? 0) & EPHEMERAL) === 0)) {
        completed.set(payload.id, expiresAt);
      }
      json(res, 200, reply);
    } catch (error) {
      // Never echo exception details; signed content can still contain private user data.
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
        json(res, error instanceof HttpError ? error.status : 500, { error: 'Request could not be processed' });
      } else res.end();
    }
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  return Object.assign(server, { voicePilot });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = loadServerConfig();
    if (config.dbPath !== ':memory:') mkdirSync(dirname(resolve(config.dbPath)), { recursive: true, mode: 0o700 });
    const { SessionStore } = await import('./store.ts');
    const store = new SessionStore(config.dbPath);
    const server = createInteractionServer(config, store);
    server.listen(config.port, config.host, () => console.log(`SquadWaddle listening on ${config.host}:${config.port}; interactions at /interactions.`));
    server.on('error', () => { console.error('Server could not start. Check the configured host and port.'); store.close(); process.exitCode = 1; });
    const stop = () => server.close(() => { store.close(); process.exitCode = 0; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    // Config errors contain env names only. Do not print arbitrary store errors or stack traces.
    console.error(error instanceof Error && /^(DISCORD_|PILOT_|PORT |A valid Discord)/.test(error.message)
      ? error.message : 'Could not start SquadWaddle. Check configuration and database permissions.');
    process.exitCode = 1;
  }
}
