import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Member bio + social links on the public profile (T-0216).
 *
 * ── A COLUMN FOR THE BIO, A TABLE FOR THE LINKS ─────────────────────────────
 * `members.bio` is one member-authored paragraph and belongs on the row it
 * describes. It is `text` rather than a varchar because the length ceiling is a
 * PRODUCT rule (280 characters, so the blurb stays one paragraph beside the
 * avatar) enforced in the DTO — a product rule that moves must not need a
 * migration. NULL is "never wrote one"; whitespace-only input is folded to NULL
 * in the service, so blank has exactly one representation.
 *
 * `member_social_links` is a table and not seven more nullable columns because
 * the set of networks is OPEN. Columns would make adding one a migration, would
 * spend seven slots on a row most members leave entirely empty, and could not
 * carry per-link ordering.
 *
 * ── WHAT IS STORED IS A HANDLE, NOT A URL, AND THAT IS THE POINT ────────────
 * `handle` is an account name; the outbound URL is composed server-side from a
 * hardcoded origin per platform (`src/members/social-platforms.ts`). A member
 * therefore cannot publish an arbitrary outbound link on a crawlable page —
 * phishing, malware, SEO spam or a `javascript:` payload — no matter what they
 * type. varchar(190) is deliberately far wider than any handle rule allows so a
 * network's ceiling can be raised without touching the schema.
 *
 * `platform` is varchar, not ENUM: SCHEMA.md §2 reserves ENUM for closed sets,
 * and this set will gain a member the week one of these networks stops
 * mattering. The unique index is (member_id, platform) — one account per network
 * per member — which is also why handle casing, preserved for display, never
 * affects the key.
 *
 * No `regiment_id`: a child reached only through a regiment-scoped parent,
 * exactly like `gallery_files`. The member carries the tenancy.
 *
 * ON DELETE CASCADE covers a HARD delete. Members are soft-deleted, so the GDPR
 * erasure path hard-deletes these rows inside its own transaction — the
 * constraint is the backstop for a real row removal, not the mechanism.
 *
 * Additive only. Nothing here rewrites an existing row — every member gets
 * `bio = NULL` and no links until they write some — and `down()` is a true
 * inverse in reverse order: it drops a table and a column that did not exist
 * before this migration. Production has been live since 2026-07-20.
 */
export class MemberBioAndSocialLinks1784900006000 implements MigrationInterface {
  name = 'MemberBioAndSocialLinks1784900006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `members` ADD `bio` text NULL AFTER `banner_url`');

    await queryRunner.query(
      'CREATE TABLE `member_social_links` (' +
        '`id` char(12) NOT NULL, ' +
        '`member_id` char(12) NOT NULL, ' +
        '`platform` varchar(40) NOT NULL, ' +
        '`handle` varchar(190) NOT NULL, ' +
        '`precedence` int NOT NULL DEFAULT 0, ' +
        '`created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ' +
        'UNIQUE INDEX `UQ_member_social_link` (`member_id`, `platform`), ' +
        'PRIMARY KEY (`id`)' +
        ') ENGINE=InnoDB',
    );

    await queryRunner.query(
      'ALTER TABLE `member_social_links` ADD CONSTRAINT `FK_member_social_links_member` ' +
        'FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `member_social_links` DROP FOREIGN KEY `FK_member_social_links_member`',
    );
    // DROP TABLE takes `UQ_member_social_link` with it — no separate DROP INDEX.
    await queryRunner.query('DROP TABLE `member_social_links`');
    await queryRunner.query('ALTER TABLE `members` DROP COLUMN `bio`');
  }
}
