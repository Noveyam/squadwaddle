import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SESSION_COMMAND } from '../src/discord.ts';

/** Official API: https://docs.discord.com/developers/interactions/application-commands#create-guild-application-command
 * POST upserts only this named guild command. Never bulk-overwrites unrelated commands.
 * Running this file without REGISTER_COMMANDS=yes performs no network call.
 */
export async function registerCommands(env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch): Promise<string> {
  if (env.REGISTER_COMMANDS !== 'yes') {
    throw new Error('No changes made. Set REGISTER_COMMANDS=yes only when you intend to register /session in the configured pilot guild.');
  }
  const application = env.DISCORD_APPLICATION_ID ?? '';
  const guild = env.PILOT_GUILD_ID ?? '';
  const token = env.DISCORD_BOT_TOKEN ?? '';
  if (!/^\d{17,20}$/.test(application) || !/^\d{17,20}$/.test(guild) || !token || /\s/.test(token)) {
    throw new Error('Set valid DISCORD_APPLICATION_ID, PILOT_GUILD_ID, and DISCORD_BOT_TOKEN in your local environment.');
  }
  let response: Response;
  try {
    response = await fetcher(`https://discord.com/api/v10/applications/${application}/guilds/${guild}/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
      body: JSON.stringify(SESSION_COMMAND), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
  } catch { throw new Error('Registration request failed. Check the app and network configuration; no automatic retry was made.'); }
  if (!response.ok) throw new Error(`Discord rejected registration (HTTP ${response.status}). No response body or token was logged.`);
  return 'Registered /session in the configured pilot guild.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(await registerCommands()); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Registration failed.'); process.exitCode = 1; }
}
