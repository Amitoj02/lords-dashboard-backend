import { DataSource } from 'typeorm';
import { AuditSeverity } from '../../common/enums';
import { AuditAction } from '../../audit/entities/audit-action.entity';
import { ensure } from './seed.util';

const ACTIONS = [
  {
    code: 'application.approve',
    label: 'Application approved',
    defaultSeverity: AuditSeverity.Info,
  },
  {
    code: 'application.decline',
    label: 'Application declined',
    defaultSeverity: AuditSeverity.Info,
  },
  { code: 'application.hold', label: 'Application held', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.change', label: 'Rank changed', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.create', label: 'Rank created', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.update', label: 'Rank updated', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.reorder', label: 'Ranks reordered', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.delete', label: 'Rank deleted', defaultSeverity: AuditSeverity.Warn },
  { code: 'medal.award', label: 'Medal awarded', defaultSeverity: AuditSeverity.Info },
  { code: 'medal.remove', label: 'Medal removed', defaultSeverity: AuditSeverity.Warn },
  { code: 'medal.create', label: 'Medal created', defaultSeverity: AuditSeverity.Info },
  { code: 'medal.update', label: 'Medal updated', defaultSeverity: AuditSeverity.Info },
  { code: 'medal.delete', label: 'Medal deleted', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.rank.change', label: 'Member rank changed', defaultSeverity: AuditSeverity.Info },
  { code: 'member.role.change', label: 'Member role changed', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.suspend', label: 'Member suspended', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.ban', label: 'Member banned', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.unban', label: 'Member unbanned', defaultSeverity: AuditSeverity.Info },
  {
    code: 'member.deletion.request',
    label: 'Account deletion requested',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'member.status.auto_inactive',
    label: 'Member auto-marked inactive',
    defaultSeverity: AuditSeverity.Info,
  },
  {
    code: 'role.permission.change',
    label: 'Role permission changed',
    defaultSeverity: AuditSeverity.Warn,
  },
  { code: 'event.create', label: 'Event created', defaultSeverity: AuditSeverity.Info },
  { code: 'event.update', label: 'Event updated', defaultSeverity: AuditSeverity.Info },
  { code: 'event.publish', label: 'Event published', defaultSeverity: AuditSeverity.Info },
  { code: 'event.archive', label: 'Event archived', defaultSeverity: AuditSeverity.Info },
  { code: 'event.delete', label: 'Event deleted', defaultSeverity: AuditSeverity.Warn },
  { code: 'event.completed', label: 'Event completed', defaultSeverity: AuditSeverity.Info },
  {
    code: 'event.password.reveal',
    label: 'Event password revealed',
    defaultSeverity: AuditSeverity.Warn,
  },
  { code: 'gallery.submit', label: 'Gallery item submitted', defaultSeverity: AuditSeverity.Info },
  { code: 'gallery.approve', label: 'Gallery item approved', defaultSeverity: AuditSeverity.Info },
  { code: 'gallery.decline', label: 'Gallery item declined', defaultSeverity: AuditSeverity.Info },
  { code: 'gallery.delete', label: 'Gallery item deleted', defaultSeverity: AuditSeverity.Warn },
  {
    code: 'notification.create',
    label: 'Field dispatch sent',
    defaultSeverity: AuditSeverity.Info,
  },
  { code: 'discord.sync', label: 'Discord sync', defaultSeverity: AuditSeverity.Info },
  {
    code: 'discord.sync.failed',
    label: 'Discord sync failed',
    defaultSeverity: AuditSeverity.Error,
  },
  {
    code: 'discord.connection.update',
    label: 'Discord connection updated',
    defaultSeverity: AuditSeverity.Info,
  },
  {
    code: 'discord.resync',
    label: 'Discord resync requested',
    defaultSeverity: AuditSeverity.Info,
  },
  {
    code: 'discord.announce',
    label: 'Discord announcement broadcast',
    defaultSeverity: AuditSeverity.Info,
  },
  {
    code: 'discord.member.kick',
    label: 'Member kicked from Discord',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'discord.operation.resolve',
    label: 'Bot operation resolved',
    defaultSeverity: AuditSeverity.Info,
  },
  { code: 'settings.update', label: 'Settings updated', defaultSeverity: AuditSeverity.Info },
  {
    code: 'settings.permissions.update',
    label: 'Permission matrix updated',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'settings.transfer_ownership',
    label: 'Ownership transferred',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'settings.transfer_discord',
    label: 'Discord server rebound',
    defaultSeverity: AuditSeverity.Warn,
  },
  { code: 'settings.dissolve', label: 'Regiment dissolved', defaultSeverity: AuditSeverity.Error },
  { code: 'user.ban', label: 'User banned', defaultSeverity: AuditSeverity.Warn },
  { code: 'auth.sign_in', label: 'User signed in', defaultSeverity: AuditSeverity.Info },
];

export async function seedAuditActions(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(AuditAction);
  for (const action of ACTIONS) {
    await ensure(repo, { code: action.code }, action);
  }
}
