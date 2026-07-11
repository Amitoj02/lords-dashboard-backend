import { MockDiscordGateway } from './mock-discord-gateway';

describe('MockDiscordGateway', () => {
  let gateway: MockDiscordGateway;

  beforeEach(() => {
    gateway = new MockDiscordGateway();
  });

  it('reports itself connected with a role catalogue', async () => {
    const status = await gateway.getStatus();
    expect(status.connected).toBe(true);
    const roles = await gateway.listRoles();
    expect(roles.length).toBeGreaterThan(0);
  });

  it('tracks role assignment + removal in-memory', async () => {
    await gateway.assignRole('user-1', 'role-a');
    let member = await gateway.fetchMember('user-1');
    expect(member?.roles).toContain('role-a');

    await gateway.removeRole('user-1', 'role-a');
    member = await gateway.fetchMember('user-1');
    expect(member?.roles).not.toContain('role-a');
  });

  it('forgets a member on kick', async () => {
    await gateway.assignRole('user-2', 'role-b');
    await gateway.kickMember('user-2', 'test');
    expect(await gateway.fetchMember('user-2')).toBeNull();
  });

  it('invokes the registered join handler on simulateMemberJoin', async () => {
    const handler = jest.fn();
    gateway.registerMemberJoinHandler(handler);
    await gateway.simulateMemberJoin('user-3');
    expect(handler).toHaveBeenCalledWith('user-3');
  });
});
