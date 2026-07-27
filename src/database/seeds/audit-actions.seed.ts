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
  {
    code: 'application.block',
    label: 'Applicant blocked from applying',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'application.unblock',
    label: 'Applicant re-enabled for applying',
    defaultSeverity: AuditSeverity.Info,
  },
  { code: 'rank.change', label: 'Rank changed', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.create', label: 'Rank created', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.update', label: 'Rank updated', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.reorder', label: 'Ranks reordered', defaultSeverity: AuditSeverity.Info },
  { code: 'rank.delete', label: 'Rank deleted', defaultSeverity: AuditSeverity.Warn },
  { code: 'medal.award', label: 'Medal awarded', defaultSeverity: AuditSeverity.Info },
  { code: 'medal.remove', label: 'Medal removed', defaultSeverity: AuditSeverity.Warn },
  { code: 'medal.create', label: 'Medal created', defaultSeverity: AuditSeverity.Info },
  { code: 'medal.update', label: 'Medal updated', defaultSeverity: AuditSeverity.Info },
  { code: 'medal.reorder', label: 'Medals reordered', defaultSeverity: AuditSeverity.Info },
  { code: 'medal.delete', label: 'Medal deleted', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.rank.change', label: 'Member rank changed', defaultSeverity: AuditSeverity.Info },
  { code: 'member.role.change', label: 'Member role changed', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.suspend', label: 'Member suspended', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.ban', label: 'Member banned', defaultSeverity: AuditSeverity.Warn },
  { code: 'member.unban', label: 'Member unbanned', defaultSeverity: AuditSeverity.Info },
  { code: 'member.unsuspend', label: 'Member unsuspended', defaultSeverity: AuditSeverity.Info },
  {
    code: 'member.derive_from_discord',
    // Warn, not Info, even though the two writes it makes (rank + medals) are
    // each Info on their own: this one grants standing an admin did not name,
    // read out of a guild's role state, so it is the entry you want to be able
    // to find later when someone asks where a rank came from.
    label: 'Member rank/medals derived from Discord',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'member.deletion.request',
    label: 'Account deletion requested',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'member.deletion.execute',
    label: 'Account deletion executed',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'member.deletion.cancel',
    label: 'Account deletion cancelled',
    defaultSeverity: AuditSeverity.Info,
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
  { code: 'event.unarchive', label: 'Event unarchived', defaultSeverity: AuditSeverity.Info },
  { code: 'event.delete', label: 'Event deleted', defaultSeverity: AuditSeverity.Warn },
  {
    code: 'event.delete-series',
    label: 'Event series deleted',
    defaultSeverity: AuditSeverity.Warn,
  },
  { code: 'event.completed', label: 'Event completed', defaultSeverity: AuditSeverity.Info },
  {
    code: 'event.reanchor',
    label: 'Event re-anchored to its timezone',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'event.password.reveal',
    label: 'Event password revealed',
    defaultSeverity: AuditSeverity.Warn,
  },
  { code: 'gallery.submit', label: 'Gallery item submitted', defaultSeverity: AuditSeverity.Info },
  { code: 'gallery.approve', label: 'Gallery item approved', defaultSeverity: AuditSeverity.Info },
  { code: 'gallery.update', label: 'Gallery item updated', defaultSeverity: AuditSeverity.Info },
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
    code: 'discord.member.ban_role',
    label: 'Ban role applied on Discord (managed roles stripped)',
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
  // `settings.transfer_ownership` and `settings.transfer_discord` were dropped
  // in T-0170 with the endpoints that wrote them. Historical rows are safe:
  // severity is denormalised onto each audit row at write time and no read path
  // joins this catalog for a label, so the ledger still renders them correctly.
  { code: 'settings.dissolve', label: 'Regiment dissolved', defaultSeverity: AuditSeverity.Error },
  { code: 'user.ban', label: 'User banned', defaultSeverity: AuditSeverity.Warn },
  { code: 'auth.sign_in', label: 'User signed in', defaultSeverity: AuditSeverity.Info },
  // Public presentation + legal copy (T-0147 / T-0149). Editing a legal
  // document is Warn, not Info: the privacy policy is a compliance artefact,
  // so "who changed it and when" must stand out in the ledger.
  {
    code: 'regiment.presentation.update',
    label: 'Public presentation updated',
    defaultSeverity: AuditSeverity.Info,
  },
  {
    code: 'regiment.document.update',
    label: 'Legal document updated',
    defaultSeverity: AuditSeverity.Warn,
  },
  // Bulk Discord role re-link (T-0158 / T-0160). ONE row per bulk action, not
  // one per member — a 600-member fan-out must not flood the ledger.
  {
    code: 'discord.role.relink',
    label: 'Discord role re-linked in bulk',
    defaultSeverity: AuditSeverity.Warn,
  },
  {
    code: 'discord.role.relink.cancel',
    label: 'Bulk Discord role re-link cancelled',
    defaultSeverity: AuditSeverity.Warn,
  },
];

export async function seedAuditActions(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(AuditAction);
  for (const action of ACTIONS) {
    await ensure(repo, { code: action.code }, action);
  }
}
