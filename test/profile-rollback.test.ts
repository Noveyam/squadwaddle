import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/store.ts';
import type { Actor, SessionInput } from '../src/types.ts';

test('an isolated pre-cutover backup can be cut over again without restoring legacy names or consent', t => {
  const directory = mkdtempSync(join(tmpdir(), 'squadwaddle-restore-'));
  const source = join(directory, 'original.sqlite');
  const backup = join(directory, 'pre-cutover.sqlite');
  const candidate = join(directory, 'restore-candidate.sqlite');
  const clock = () => new Date('2026-12-01T12:00:00Z');
  const first: Actor = { guildId: 'fictional-guild-a', channelId: 'fictional-channel-a', userId: 'same-player' };
  const second: Actor = { guildId: 'fictional-guild-b', channelId: 'fictional-channel-b', userId: first.userId };
  const session: SessionInput = { activity: 'Expedition practice', startAt: '2026-12-11T18:30:00Z',
    endAt: '2026-12-11T20:30:00Z', timeZone: 'UTC', expectations: 'Finish on time.', platformNotes: '' };
  const legacy = new SessionStore(source, clock);
  t.after(() => { legacy.close(); rmSync(directory, { recursive: true, force: true }); });
  legacy.saveProfile(first, 'FictionalLegacy#1111');
  const published = legacy.publish(first, legacy.createDraft(first, session, true).id);
  const draft = legacy.createDraft(second, session, true);
  const staleRevision = legacy.getDraft(second, draft.id).revision;
  legacy.close();
  copyFileSync(source, backup);

  const active = new SessionStore(source, clock, { guildScopedProfiles: true });
  try {
    active.saveProfile(first, 'FictionalPostCutover#2222');
    active.setSharing(first, published.id, true);

    copyFileSync(backup, candidate);
    // Apply the guild-scoped transition before bringing up any interaction endpoint.
    const restored = new SessionStore(candidate, clock, { guildScopedProfiles: true });
    try {
      assert.equal(restored.getProfile(first).bungieName, null);
      assert.equal(restored.getProfile(second).bungieName, null);
      assert.deepEqual(restored.listSessions(first).map(row => row.id), [published.id]);
      assert.deepEqual(restored.getSharedNames(first, published.id).map(member => member.bungieName), [null]);
      assert.throws(() => restored.getSharedNames(second, published.id), { code: 'NOT_FOUND' });
      const preview = restored.getDraft(second, draft.id);
      assert.equal(preview.shareName, false);
      assert.equal(preview.revision, staleRevision + 1);
      assert.throws(() => restored.publish(second, draft.id, undefined, staleRevision), { code: 'STALE_DRAFT' });
      assert.throws(() => restored.setSharing(first, published.id, true), { code: 'PROFILE_REQUIRED' });
    } finally {
      restored.close();
    }

    assert.equal(active.getProfile(first).bungieName, 'FictionalPostCutover#2222');
    assert.equal(active.getProfile(second).bungieName, null);
    assert.equal(active.getSharedNames(first, published.id)[0].bungieName, 'FictionalPostCutover#2222');
  } finally {
    active.close();
  }
});
