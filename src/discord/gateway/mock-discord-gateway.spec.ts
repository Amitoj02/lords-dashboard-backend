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
});
