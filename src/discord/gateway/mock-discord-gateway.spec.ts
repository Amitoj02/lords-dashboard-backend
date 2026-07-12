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
