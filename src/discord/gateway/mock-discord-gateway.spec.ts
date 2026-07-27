import { MockDiscordGateway } from './mock-discord-gateway';

describe('MockDiscordGateway', () => {
  let gateway: MockDiscordGateway;

  beforeEach(() => {
    gateway = new MockDiscordGateway();
  });

  it('reports itself connected with a role + channel catalogue', async () => {
    const status = await gateway.getStatus();
    expect(status.connected).toBe(true);
    const roles = await gateway.listRoles();
    expect(roles.length).toBeGreaterThan(0);
    const channels = await gateway.listChannels();
    expect(channels.length).toBeGreaterThan(0);
  });

  it('returns canned live runtime metrics for type parity (T-0076)', async () => {
    const status = await gateway.getStatus();
    // Every metric field is present and non-null in mock mode (never throws).
    expect(typeof status.wsPing).toBe('number');
    expect(typeof status.uptimeMs).toBe('number');
    expect(typeof status.memoryBytes).toBe('number');
    expect(typeof status.cpu).toBe('number');
    expect(status.readyAt).toEqual(expect.any(String));
    // User/role counts still come from the in-memory guild (no new query).
    expect(status.membersVisible).toBeGreaterThanOrEqual(1);
    expect(status.totalRoles).toBeGreaterThan(0);
  });

  it('treats the seeded owner persona as already in the guild (T-0052)', async () => {
    // The dev-owner snowflake is pre-joined so mock sign-in resolves
    // guildMember=true without a prior assignRole/simulateMemberJoin.
    const owner = await gateway.fetchMember('100000000000000001');
    expect(owner).not.toBeNull();
    expect(owner?.id).toBe('100000000000000001');
  });

  it('returns null for a user who is not in the guild', async () => {
    // e.g. a fresh `recruit` persona — not pre-joined, never assigned a role.
    await expect(gateway.fetchMember('200000000000000042')).resolves.toBeNull();
  });

  it('tracks role assignment + removal in-memory', async () => {
    await gateway.assignRole('user-1', 'role-a');
    let member = await gateway.fetchMember('user-1');
    expect(member?.roles).toContain('role-a');

    await gateway.removeRole('user-1', 'role-a');
    member = await gateway.fetchMember('user-1');
    expect(member?.roles).not.toContain('role-a');
  });

  it('invokes the registered join handler on simulateMemberJoin', async () => {
    const handler = jest.fn();
    gateway.registerMemberJoinHandler(handler);
    await gateway.simulateMemberJoin('user-3');
    expect(handler).toHaveBeenCalledWith('user-3');
  });

  it('invokes the registered leave handler on simulateMemberLeave (T-0169)', async () => {
    const handler = jest.fn();
    gateway.registerMemberLeaveHandler(handler);
    await gateway.simulateMemberJoin('user-4');
    await gateway.simulateMemberLeave('user-4');

    expect(handler).toHaveBeenCalledWith('user-4');
    // The in-memory guild forgets the member too, so a lookup racing the event
    // cannot contradict the departure the mock just announced.
    await expect(gateway.fetchMember('user-4')).resolves.toBeNull();
  });

  describe('recorded sent messages (T-0172)', () => {
    it('records a plain-text channel post with no embeds', async () => {
      const { messageId } = await gateway.sendChannelMessage('channel-1', 'hello');

      expect(gateway.sentMessages).toEqual([
        {
          kind: 'channel',
          target: 'channel-1',
          content: 'hello',
          embeds: [],
          // Recorded as EMPTY rather than absent (T-0205), so "this message
          // pinged nobody" is an assertion you can actually write.
          components: [],
          mentions: {},
          messageId,
        },
      ]);
    });

    it('records the EMBED so its shape is assertable under DISCORD_BOT_MOCK', async () => {
      // Without this the mock kept nothing at all, so an embed-only message was
      // observable only as a log line — nothing could prove what was sent.
      const embed = { title: 'New event: Muster', color: 0x3b5bdb };

      await gateway.sendChannelMessage('channel-1', '', [embed]);

      expect(gateway.sentMessages[0].content).toBe('');
      expect(gateway.sentMessages[0].embeds).toEqual([embed]);
    });

    it('records a DM against the target user and returns a message id', async () => {
      const { messageId } = await gateway.sendDirectMessage('user-9', '', [{ title: 'Declined' }]);

      expect(gateway.sentMessages[0]).toEqual(
        expect.objectContaining({ kind: 'dm', target: 'user-9', messageId }),
      );
    });

    it('mints a distinct id per message even within the same millisecond', async () => {
      const a = await gateway.sendChannelMessage('c', 'one');
      const b = await gateway.sendChannelMessage('c', 'two');

      expect(a.messageId).not.toBe(b.messageId);
    });

    it('clears the buffer on reset so a suite can start from empty', async () => {
      await gateway.sendChannelMessage('c', 'x');
      gateway.resetSentMessages();
      expect(gateway.sentMessages).toHaveLength(0);
    });
  });

  it('fans an event out to EVERY registered handler (T-0169)', async () => {
    // Onboarding and the membership verdict writer both subscribe to
    // GuildMemberAdd; neither may silently displace the other.
    const first = jest.fn();
    const second = jest.fn();
    gateway.registerMemberJoinHandler(first);
    gateway.registerMemberJoinHandler(second);

    await gateway.simulateMemberJoin('user-5');

    expect(first).toHaveBeenCalledWith('user-5');
    expect(second).toHaveBeenCalledWith('user-5');
  });
});
