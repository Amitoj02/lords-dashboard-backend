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
  { code: 'rank.delete', label: 'Rank deleted', defaultSeverity: AuditSeverity.Warn },
  { code: 'medal.award', label: 'Medal awarded', defaultSeverity: AuditSeverity.Info },
  { code: 'member.role.change', label: 'Member role changed', defaultSeverity: AuditSeverity.Warn },
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
  { code: 'event.completed', label: 'Event completed', defaultSeverity: AuditSeverity.Info },
  {
    code: 'event.password.reveal',
    label: 'Event password revealed',
    defaultSeverity: AuditSeverity.Warn,
  },
  { code: 'gallery.approve', label: 'Gallery item approved', defaultSeverity: AuditSeverity.Info },
  { code: 'gallery.decline', label: 'Gallery item declined', defaultSeverity: AuditSeverity.Info },
  { code: 'discord.sync', label: 'Discord sync', defaultSeverity: AuditSeverity.Info },
  {
    code: 'discord.sync.failed',
    label: 'Discord sync failed',
    defaultSeverity: AuditSeverity.Error,
  },
  { code: 'settings.update', label: 'Settings updated', defaultSeverity: AuditSeverity.Info },
  { code: 'user.ban', label: 'User banned', defaultSeverity: AuditSeverity.Warn },
  { code: 'auth.sign_in', label: 'User signed in', defaultSeverity: AuditSeverity.Info },
];

export async function seedAuditActions(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(AuditAction);
  for (const action of ACTIONS) {
    await ensure(repo, { code: action.code }, action);
  }
}
