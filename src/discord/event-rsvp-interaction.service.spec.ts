import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { SessionContextService } from '../auth/session-context.service';
import { AuthzService } from '../authz/authz.service';
import { Capability, EventStatus, MemberRole, RsvpStatus } from '../common/enums';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { RegimentEvent } from '../events/entities/event.entity';
import { DiscordSyncService } from './discord-sync.service';
import { rsvpCustomId } from './embeds/event-components';
import { EventRsvpInteractionService } from './event-rsvp-interaction.service';
import { DiscordBotSettings } from './entities/discord-bot-settings.entity';
import { DiscordButtonPress, DiscordGateway } from './gateway/discord-gateway';

const REGIMENT = 'Rgmt00000001';
const EVENT_ID = 'evt000000001';
const MEMBER = 'Mmbr00000001';
const DISCORD_USER = '100000000000000001';

const press = (overrides: Partial<DiscordButtonPress> = {}): DiscordButtonPress => ({
  customId: rsvpCustomId(EVENT_ID, RsvpStatus.Interested),
  discordUserId: DISCORD_USER,
  channelId: 'c1',
  messageId: 'msg-9',
  ...overrides,
});

describe('EventRsvpInteractionService (T-0205)', () => {
  let service: EventRsvpInteractionService;

  const gateway = { registerInteractionHandler: jest.fn() };
  const eventsRepo = { findOne: jest.fn() };
  const rsvpsRepo = {
    findOne: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve(x)),
  };
  const identitiesRepo = { findOne: jest.fn() };
  const settingsRepo = { findOne: jest.fn() };
  const sessions = { resolve: jest.fn() };
  const authz = { can: jest.fn() };
  const sync = { enqueueEventAnnouncementRefresh: jest.fn().mockResolvedValue(null) };

  beforeEach(async () => {
    jest.clearAllMocks();
    eventsRepo.findOne.mockResolvedValue({
      id: EVENT_ID,
      regimentId: REGIMENT,
      title: 'Line Battle',
      status: EventStatus.Upcoming,
    });
    settingsRepo.findOne.mockResolvedValue({ regimentId: REGIMENT, botEnabled: true });
    identitiesRepo.findOne.mockResolvedValue({ id: 'identity-1', discordUserId: DISCORD_USER });
    sessions.resolve.mockResolvedValue({
      identityId: 'identity-1',
      discordUserId: DISCORD_USER,
      memberId: MEMBER,
      role: MemberRole.Member,
      regimentId: REGIMENT,
      sessionsValidFromSec: 0,
    });
    authz.can.mockResolvedValue(true);
    rsvpsRepo.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventRsvpInteractionService,
        { provide: DiscordGateway, useValue: gateway },
        { provide: getRepositoryToken(RegimentEvent), useValue: eventsRepo },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvpsRepo },
        { provide: getRepositoryToken(DiscordIdentity), useValue: identitiesRepo },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: settingsRepo },
        { provide: SessionContextService, useValue: sessions },
        { provide: AuthzService, useValue: authz },
        { provide: DiscordSyncService, useValue: sync },
      ],
    }).compile();
    service = module.get(EventRsvpInteractionService);
  });

  it('subscribes to button presses on init', () => {
    service.onModuleInit();
    expect(gateway.registerInteractionHandler).toHaveBeenCalledTimes(1);
  });

  it('ignores a press it does not own, so another handler can claim it', async () => {
    await expect(service.handle(press({ customId: 'gallery-approve:1' }))).resolves.toBeNull();
    expect(eventsRepo.findOne).not.toHaveBeenCalled();
  });

  describe('a member pressing a button', () => {
    it('writes the RSVP and re-renders the announcement', async () => {
      const reply = await service.handle(press());

      expect(rsvpsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: EVENT_ID,
          memberId: MEMBER,
          status: RsvpStatus.Interested,
        }),
      );
      expect(sync.enqueueEventAnnouncementRefresh).toHaveBeenCalledWith(REGIMENT, EVENT_ID);
      expect(reply?.content).toContain('Attending');
      expect(reply?.content).toContain('Line Battle');
    });

    it('KEEPS the reminder lead time the member set on the website', async () => {
      // A press means "I am coming", not "forget the preference I configured".
      rsvpsRepo.findOne.mockResolvedValue({
        eventId: EVENT_ID,
        memberId: MEMBER,
        status: RsvpStatus.Tentative,
        reminderOffsetMinutes: 30,
        respondedAt: null,
      });

      await service.handle(press({ customId: rsvpCustomId(EVENT_ID, RsvpStatus.Declined) }));

      const saved = rsvpsRepo.save.mock.calls[0][0] as EventRsvp;
      expect(saved.status).toBe(RsvpStatus.Declined);
      expect(saved.reminderOffsetMinutes).toBe(30);
      expect(saved.respondedAt).toBeInstanceOf(Date);
    });

    it('lets a member change their mind as often as they like', async () => {
      await service.handle(press({ customId: rsvpCustomId(EVENT_ID, RsvpStatus.Interested) }));
      rsvpsRepo.findOne.mockResolvedValue({ eventId: EVENT_ID, memberId: MEMBER });
      await service.handle(press({ customId: rsvpCustomId(EVENT_ID, RsvpStatus.Declined) }));
      await service.handle(press({ customId: rsvpCustomId(EVENT_ID, RsvpStatus.Tentative) }));

      expect(rsvpsRepo.save).toHaveBeenCalledTimes(3);
      expect((rsvpsRepo.save.mock.calls[2][0] as EventRsvp).status).toBe(RsvpStatus.Tentative);
    });
  });

  describe('authorization — the same gates the HTTP route applies', () => {
    it('refuses a Discord account with no identity, and does NOT create a member', async () => {
      // Pressing a button in a public channel must never be a way onto the
      // roster; that is what the enlistment flow is for.
      identitiesRepo.findOne.mockResolvedValue(null);

      const reply = await service.handle(press());

      expect(reply?.content).toContain('Only enrolled members can RSVP');
      expect(rsvpsRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a banned or suspended member — the session resolver already says no', async () => {
      // Re-implementing "is this person allowed to act" here would be a second
      // answer to that question, and a second answer is how a ban gets defeated
      // by a side door.
      sessions.resolve.mockResolvedValue(null);

      const reply = await service.handle(press());

      expect(reply?.content).toContain('Only enrolled members can RSVP');
      expect(rsvpsRepo.save).not.toHaveBeenCalled();
    });

    it('refuses an identity with no roster member', async () => {
      sessions.resolve.mockResolvedValue({
        identityId: 'identity-1',
        discordUserId: DISCORD_USER,
        memberId: null,
        role: MemberRole.Applicant,
        regimentId: REGIMENT,
        sessionsValidFromSec: 0,
      });

      expect((await service.handle(press()))?.content).toContain('Only enrolled members can RSVP');
      expect(rsvpsRepo.save).not.toHaveBeenCalled();
    });

    it('honours the permission matrix, not just membership', async () => {
      // A button that ignored rsvp_to_events would silently out-rank the
      // settings screen the regiment actually edits.
      authz.can.mockResolvedValue(false);

      const reply = await service.handle(press());

      expect(authz.can).toHaveBeenCalledWith(REGIMENT, MemberRole.Member, Capability.RsvpToEvents);
      expect(reply?.content).toContain('not permitted');
      expect(rsvpsRepo.save).not.toHaveBeenCalled();
    });

    it('goes dead when the bot master switch is off', async () => {
      // An announcement outlives the setting that produced it. A regiment that
      // switched the bot off switched off its ability to write roster state
      // from Discord.
      settingsRepo.findOne.mockResolvedValue({ regimentId: REGIMENT, botEnabled: false });

      await expect(service.handle(press())).resolves.toBeNull();
      expect(rsvpsRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('events that cannot take an RSVP', () => {
    it('says so for an event that no longer exists', async () => {
      eventsRepo.findOne.mockResolvedValue(null);
      expect((await service.handle(press()))?.content).toBe('That event no longer exists.');
    });

    it('refuses an event that has already finished', async () => {
      // The buttons are disabled when an event ends, so this only fires if that
      // edit failed — which is exactly when it matters.
      eventsRepo.findOne.mockResolvedValue({
        id: EVENT_ID,
        regimentId: REGIMENT,
        title: 'Line Battle',
        status: EventStatus.Previous,
      });

      expect((await service.handle(press()))?.content).toContain('already finished');
      expect(rsvpsRepo.save).not.toHaveBeenCalled();
    });

    it('still accepts an RSVP to an event that is UNDER WAY', async () => {
      // Turning up late is normal; only "ended" closes the door.
      eventsRepo.findOne.mockResolvedValue({
        id: EVENT_ID,
        regimentId: REGIMENT,
        title: 'Line Battle',
        status: EventStatus.Ongoing,
      });

      await service.handle(press());
      expect(rsvpsRepo.save).toHaveBeenCalled();
    });

    it('refuses an event belonging to a different regiment', async () => {
      eventsRepo.findOne.mockResolvedValue({
        id: EVENT_ID,
        regimentId: 'Rgmt00000002',
        title: 'Line Battle',
        status: EventStatus.Upcoming,
      });
      settingsRepo.findOne.mockResolvedValue({ regimentId: 'Rgmt00000002', botEnabled: true });

      expect((await service.handle(press()))?.content).toContain('different regiment');
      expect(rsvpsRepo.save).not.toHaveBeenCalled();
    });
  });
});
