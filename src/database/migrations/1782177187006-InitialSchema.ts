import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1782177187006 implements MigrationInterface {
  name = 'InitialSchema1782177187006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`discord_identities\` (\`id\` varchar(36) NOT NULL, \`discord_user_id\` varchar(20) NOT NULL, \`discord_tag\` varchar(64) NULL, \`discord_username\` varchar(64) NULL, \`global_name\` varchar(64) NULL, \`email\` varchar(255) NULL, \`avatar_url\` varchar(512) NULL, \`access_token\` text NULL, \`refresh_token\` text NULL, \`token_expires_at\` datetime(6) NULL, \`scopes\` varchar(255) NULL, \`guild_member\` tinyint NOT NULL DEFAULT 0, \`last_sign_in_at\` datetime(6) NULL, \`last_sign_in_ip\` varchar(45) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_e4fe01b5499a8292b386bfafdf\` (\`discord_user_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`ranks\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`name\` varchar(60) NOT NULL, \`chevrons\` tinyint UNSIGNED NOT NULL DEFAULT '0', \`precedence\` int NOT NULL, \`discord_role_name\` varchar(80) NULL, \`discord_role_id\` varchar(20) NULL, \`linked\` tinyint NOT NULL DEFAULT 0, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_50b2f0a10137279e0b70416a9a\` (\`regiment_id\`, \`precedence\`), UNIQUE INDEX \`IDX_1f397ff9017de3ba6ac31a0699\` (\`regiment_id\`, \`name\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`members\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`discord_identity_id\` varchar(36) NULL, \`rank_id\` char(12) NOT NULL, \`name\` varchar(120) NOT NULL, \`in_game_name\` varchar(120) NULL, \`role\` enum ('Owner', 'Admin', 'Moderator', 'Member', 'Mercenary', 'Applicant') NOT NULL DEFAULT 'Applicant', \`status\` enum ('Active', 'Inactive', 'Pending') NOT NULL DEFAULT 'Pending', \`platform\` enum ('steam', 'xbox', 'ps') NULL, \`timezone\` varchar(40) NULL, \`discord_linked\` tinyint NOT NULL DEFAULT 0, \`public_profile\` tinyint NOT NULL DEFAULT 1, \`avatar_url\` varchar(512) NULL, \`banner_url\` varchar(512) NULL, \`standing\` varchar(40) NULL, \`joined_at\` datetime(6) NULL, \`last_seen_at\` datetime(6) NULL, \`suspended_until\` datetime(6) NULL, \`banned_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`deleted_at\` datetime(6) NULL, INDEX \`IDX_accd93971fb3c5cd788335d015\` (\`role\`), INDEX \`IDX_d75eefa29c161d6add2a30a10e\` (\`status\`), UNIQUE INDEX \`REL_6e0b49ba170f0a110c27d8b5d9\` (\`discord_identity_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`accent_tones\` (\`key\` varchar(20) NOT NULL, \`label\` varchar(40) NOT NULL, \`hex\` char(7) NOT NULL, \`sort_order\` tinyint UNSIGNED NOT NULL, PRIMARY KEY (\`key\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`regiments\` (\`id\` char(12) NOT NULL, \`name\` varchar(120) NOT NULL, \`short_tag\` varchar(6) NOT NULL, \`mission_statement\` varchar(400) NULL, \`accent_tone\` varchar(20) NOT NULL DEFAULT 'brass', \`crest_url\` varchar(512) NULL, \`banner_url\` varchar(512) NULL, \`established_year\` smallint UNSIGNED NULL, \`discord_invite_url\` varchar(255) NULL, \`discord_server_id\` varchar(20) NULL, \`discord_server_name\` varchar(120) NULL, \`setup_step\` tinyint UNSIGNED NOT NULL DEFAULT '1', \`setup_complete\` tinyint NOT NULL DEFAULT 0, \`owner_member_id\` char(12) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`dissolved_at\` datetime(6) NULL, UNIQUE INDEX \`IDX_3ada956a6b22140bbfacd7fbd4\` (\`short_tag\`), UNIQUE INDEX \`IDX_73aa91c5cbb4f2aa08b950453e\` (\`discord_server_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`regiment_settings\` (\`regiment_id\` char(12) NOT NULL, \`public_roster\` tinyint NOT NULL DEFAULT 1, \`public_gallery\` tinyint NOT NULL DEFAULT 1, \`public_events\` tinyint NOT NULL DEFAULT 1, \`public_stats\` tinyint NOT NULL DEFAULT 1, \`open_recruitment\` tinyint NOT NULL DEFAULT 1, \`show_officers_mess_on_landing\` tinyint NOT NULL DEFAULT 1, \`allow_mercenaries\` tinyint NOT NULL DEFAULT 1, \`auto_approve_trusted_members\` tinyint NOT NULL DEFAULT 0, \`gallery_max_image_size_mb\` int NOT NULL DEFAULT '12', \`gallery_max_video_size_mb\` int NOT NULL DEFAULT '80', \`gallery_max_items_per_submission\` int NOT NULL DEFAULT '10', \`gallery_allowed_image_types\` json NULL, \`gallery_allowed_video_types\` json NULL, \`event_default_timezone\` varchar(40) NOT NULL DEFAULT 'UTC', \`event_default_start_time\` varchar(5) NULL, \`event_default_notify_before\` json NULL, \`audit_retention_months\` int NOT NULL DEFAULT '12', \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (\`regiment_id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`notifications\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`title\` varchar(160) NOT NULL, \`body\` text NOT NULL, \`tone\` enum ('info', 'warn', 'ok') NOT NULL DEFAULT 'info', \`author_label\` varchar(120) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`notification_reads\` (\`notification_id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, \`read_at\` datetime(6) NOT NULL, INDEX \`IDX_9615bdb2455ce385890ba0c20c\` (\`member_id\`), PRIMARY KEY (\`notification_id\`, \`member_id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`service_record_entries\` (\`id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`occurred_at\` datetime(6) NOT NULL, \`type\` varchar(40) NOT NULL, \`event\` varchar(160) NOT NULL, \`note\` text NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`account_deletion_requests\` (\`id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, \`confirm_token\` varchar(64) NOT NULL, \`acknowledge_permanent\` tinyint NOT NULL, \`acknowledge_data_downloaded\` tinyint NOT NULL, \`discord_reauthenticated_at\` datetime(6) NULL, \`status\` enum ('pending_discord_confirmation', 'confirmed', 'executed', 'cancelled') NOT NULL DEFAULT 'pending_discord_confirmation', \`requested_at\` datetime(6) NOT NULL, \`confirmed_at\` datetime(6) NULL, \`executed_at\` datetime(6) NULL, INDEX \`IDX_dc0c2c9924dd5f65f6053692cb\` (\`member_id\`), UNIQUE INDEX \`IDX_71f22dbfcf5f7842fb2eae4318\` (\`confirm_token\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`medals\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`title\` varchar(120) NOT NULL, \`glyph\` varchar(4) NOT NULL, \`ribbon\` enum ('blue', 'red', 'gold', 'green', 'tricolor') NOT NULL, \`description\` varchar(400) NULL, \`precedence\` int NOT NULL DEFAULT '0', \`discord_role_name\` varchar(80) NULL, \`discord_role_id\` varchar(20) NULL, \`linked\` tinyint NOT NULL DEFAULT 0, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_d8af5991441b8ae4af4262d2a1\` (\`regiment_id\`, \`title\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`member_medals\` (\`id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, \`medal_id\` char(12) NOT NULL, \`detail\` varchar(255) NULL, \`awarded_by_member_id\` char(12) NULL, \`awarded_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`IDX_6e382b4b28b63e0f14cd52a999\` (\`medal_id\`), UNIQUE INDEX \`IDX_b2d56e7f424f02f8f74187ca03\` (\`member_id\`, \`medal_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`events\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`created_by_member_id\` char(12) NULL, \`title\` varchar(160) NOT NULL, \`description\` text NULL, \`banner_url\` varchar(512) NULL, \`starts_at\` datetime(6) NOT NULL, \`ends_at\` datetime(6) NULL, \`timezone\` varchar(40) NOT NULL DEFAULT 'UTC', \`is_recurring\` tinyint NOT NULL DEFAULT 0, \`recurrence_rule\` varchar(120) NULL, \`server_name\` varchar(120) NULL, \`server_password\` text NULL, \`server_region\` varchar(40) NULL, \`status\` enum ('upcoming', 'ongoing', 'previous') NOT NULL DEFAULT 'upcoming', \`expected_attendance\` int NULL, \`attendance_goal\` int NULL, \`outcome\` varchar(160) NULL, \`twitch_url\` varchar(255) NULL, \`started_at\` datetime(6) NULL, \`in_line_count\` int NULL, \`is_draft\` tinyint NOT NULL DEFAULT 0, \`is_archived\` tinyint NOT NULL DEFAULT 0, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`deleted_at\` datetime(6) NULL, INDEX \`IDX_da080c835c9fc4e0aa5e8fe264\` (\`starts_at\`), INDEX \`IDX_9decac599b25b3df4f32ded9d3\` (\`regiment_id\`, \`status\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`gallery_items\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`author_member_id\` char(12) NOT NULL, \`event_id\` char(12) NULL, \`moderated_by_member_id\` char(12) NULL, \`title\` varchar(160) NOT NULL, \`caption\` varchar(512) NULL, \`type\` enum ('image', 'video', 'link') NOT NULL, \`link_url\` varchar(512) NULL, \`thumbnail_url\` varchar(512) NULL, \`status\` enum ('pending', 'approved', 'declined') NOT NULL DEFAULT 'pending', \`decline_reason\` varchar(255) NULL, \`is_draft\` tinyint NOT NULL DEFAULT 0, \`submitted_at\` datetime(6) NOT NULL, \`approved_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`deleted_at\` datetime(6) NULL, INDEX \`IDX_d0a278020390abed3249ad08f1\` (\`author_member_id\`), INDEX \`IDX_3842078cc96a817511673e5c4c\` (\`regiment_id\`, \`status\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`gallery_likes\` (\`gallery_item_id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, \`liked_at\` datetime(6) NOT NULL, INDEX \`IDX_f3c93346d0faf9f58558cb6629\` (\`member_id\`), PRIMARY KEY (\`gallery_item_id\`, \`member_id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`gallery_tagged_members\` (\`gallery_item_id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, INDEX \`IDX_d47e98c3f94f6471564389b8db\` (\`member_id\`), PRIMARY KEY (\`gallery_item_id\`, \`member_id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`gallery_files\` (\`id\` char(12) NOT NULL, \`gallery_item_id\` char(12) NOT NULL, \`file_name\` varchar(255) NOT NULL, \`url\` varchar(512) NULL, \`media_type\` enum ('image', 'video') NOT NULL, \`size_bytes\` bigint UNSIGNED NULL, \`width\` int NULL, \`height\` int NULL, \`duration_seconds\` int NULL, \`caption\` varchar(255) NULL, \`thumbnail_color\` char(7) NULL, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`event_tags\` (\`event_id\` char(12) NOT NULL, \`tag\` varchar(40) NOT NULL, PRIMARY KEY (\`event_id\`, \`tag\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`event_rsvps\` (\`id\` char(12) NOT NULL, \`event_id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, \`status\` enum ('interested', 'tentative', 'declined', 'neutral') NOT NULL, \`reminder_offset_minutes\` int NULL, \`responded_at\` datetime(6) NULL, \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_b9e8884da00efd9fbc13f3b540\` (\`member_id\`), UNIQUE INDEX \`IDX_1d4845cabaac61a065b68528b1\` (\`event_id\`, \`member_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`event_platforms\` (\`event_id\` char(12) NOT NULL, \`platform\` enum ('steam', 'xbox', 'ps') NOT NULL, PRIMARY KEY (\`event_id\`, \`platform\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`event_notify_offsets\` (\`event_id\` char(12) NOT NULL, \`minutes\` int NOT NULL, PRIMARY KEY (\`event_id\`, \`minutes\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`event_attendees\` (\`event_id\` char(12) NOT NULL, \`member_id\` char(12) NOT NULL, \`checked_in_at\` datetime(6) NULL, INDEX \`IDX_25b3ba40ac3341413d909d1b9f\` (\`member_id\`), PRIMARY KEY (\`event_id\`, \`member_id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`discord_connections\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`bot_version\` varchar(20) NULL, \`connection_status\` enum ('idle', 'checking', 'connected', 'error') NOT NULL DEFAULT 'idle', \`bot_role_position\` int NULL, \`total_roles\` int NULL, \`roles_under_authority\` int NULL, \`members_visible\` int NULL, \`last_heartbeat_at\` datetime(6) NULL, \`last_full_sync_at\` datetime(6) NULL, \`uptime_seconds\` bigint UNSIGNED NULL, \`permissions\` json NULL, \`required_permissions\` json NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_47d36dfd5800e747e436901476\` (\`regiment_id\`), UNIQUE INDEX \`REL_47d36dfd5800e747e436901476\` (\`regiment_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`bot_operations\` (\`id\` char(12) NOT NULL, \`discord_connection_id\` char(12) NOT NULL, \`occurred_at\` datetime(6) NOT NULL, \`operation\` varchar(255) NOT NULL, \`success\` tinyint NOT NULL, \`resolvable\` tinyint NOT NULL DEFAULT 0, PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`role_permissions\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`role\` enum ('Owner', 'Admin', 'Moderator', 'Member', 'Mercenary', 'Applicant') NOT NULL, \`capability\` varchar(60) NOT NULL, \`granted\` tinyint NOT NULL DEFAULT 0, UNIQUE INDEX \`IDX_7eafc810c29ab08b8e1e2a9ad0\` (\`regiment_id\`, \`role\`, \`capability\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`audit_log_entries\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`regiment_id\` char(12) NOT NULL, \`request_id\` varchar(64) NULL, \`occurred_at\` datetime(6) NOT NULL, \`actor_member_id\` char(12) NULL, \`actor_type\` enum ('member', 'bot', 'system') NOT NULL, \`actor_label\` varchar(120) NULL, \`actor_ip\` varchar(45) NULL, \`action\` varchar(64) NOT NULL, \`severity\` enum ('info', 'warn', 'err') NOT NULL DEFAULT 'info', \`target_type\` varchar(32) NULL, \`target_id\` varchar(64) NULL, \`target_member_id\` char(12) NULL, \`target_label\` varchar(120) NULL, \`detail\` text NULL, \`before_value\` json NULL, \`after_value\` json NULL, \`discord_sync_status\` enum ('pending', 'synced', 'failed', 'not_applicable') NULL, \`anonymised_at\` datetime(6) NULL, INDEX \`IDX_c75796d990c79d87bc868b8e28\` (\`action\`), INDEX \`IDX_edc21a1b74a05198ef1836725a\` (\`severity\`), INDEX \`IDX_2206ccb8c578c2cb9ed9d087e8\` (\`regiment_id\`, \`occurred_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`audit_actions\` (\`code\` varchar(64) NOT NULL, \`label\` varchar(120) NOT NULL, \`default_severity\` enum ('info', 'warn', 'err') NOT NULL DEFAULT 'info', PRIMARY KEY (\`code\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`applications\` (\`id\` char(12) NOT NULL, \`regiment_id\` char(12) NOT NULL, \`discord_identity_id\` varchar(36) NULL, \`promoted_member_id\` char(12) NULL, \`decided_by_member_id\` char(12) NULL, \`applicant_name\` varchar(120) NOT NULL, \`discord_tag\` varchar(64) NULL, \`in_game_name\` varchar(120) NOT NULL, \`platform\` enum ('steam', 'xbox', 'ps') NOT NULL, \`applicant_type\` enum ('Applicant', 'Mercenary') NOT NULL DEFAULT 'Applicant', \`timezone\` varchar(40) NULL, \`why_join\` text NOT NULL, \`how_found\` enum ('discord', 'friend', 'youtube', 'reddit', 'ingame', 'other') NOT NULL, \`prior_experience\` varchar(600) NULL, \`age_confirmed\` tinyint NOT NULL DEFAULT 0, \`age_confirmed_at\` datetime(6) NULL, \`status\` enum ('pending', 'approved', 'declined', 'held') NOT NULL DEFAULT 'pending', \`is_reapplication\` tinyint NOT NULL DEFAULT 0, \`discord_in_server\` tinyint NOT NULL DEFAULT 0, \`mutual_events_count\` int NOT NULL DEFAULT '0', \`moderator_note\` text NULL, \`discord_dm_message\` text NULL, \`decline_reason\` varchar(255) NULL, \`is_draft\` tinyint NOT NULL DEFAULT 0, \`submitted_at\` datetime(6) NOT NULL, \`decided_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_e00fbd700a2bfe9ef811efc0c4\` (\`discord_identity_id\`), INDEX \`IDX_83bce80883215e6643c60560a2\` (\`regiment_id\`, \`status\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`ranks\` ADD CONSTRAINT \`FK_4a7114fb3ec445a0e8482e416b2\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`members\` ADD CONSTRAINT \`FK_d7438ae4609c094c856dbb2a3ec\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`members\` ADD CONSTRAINT \`FK_6e0b49ba170f0a110c27d8b5d9a\` FOREIGN KEY (\`discord_identity_id\`) REFERENCES \`discord_identities\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`members\` ADD CONSTRAINT \`FK_4c80ec095927d933f9e9781cd28\` FOREIGN KEY (\`rank_id\`) REFERENCES \`ranks\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiments\` ADD CONSTRAINT \`FK_0951f5839ad93c1920e207a8356\` FOREIGN KEY (\`accent_tone\`) REFERENCES \`accent_tones\`(\`key\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiments\` ADD CONSTRAINT \`FK_8e799b5c6734a2708d69355246b\` FOREIGN KEY (\`owner_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` ADD CONSTRAINT \`FK_9171904809f0f0cf9616a8c3e6f\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`notifications\` ADD CONSTRAINT \`FK_cff35d7cc13dc54da053b8cd4a2\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`notification_reads\` ADD CONSTRAINT \`FK_30122217fe6ea5e114793efd4d5\` FOREIGN KEY (\`notification_id\`) REFERENCES \`notifications\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`notification_reads\` ADD CONSTRAINT \`FK_9615bdb2455ce385890ba0c20c3\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`service_record_entries\` ADD CONSTRAINT \`FK_41979f5d8a5c9653fa276f634a0\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`service_record_entries\` ADD CONSTRAINT \`FK_261cf55432ee7afccd8871b2dbd\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`account_deletion_requests\` ADD CONSTRAINT \`FK_dc0c2c9924dd5f65f6053692cb6\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`medals\` ADD CONSTRAINT \`FK_4d4fe1e425ce5b5aa70d1c94183\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`member_medals\` ADD CONSTRAINT \`FK_db6b044c2419a867711f9034a7a\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`member_medals\` ADD CONSTRAINT \`FK_6e382b4b28b63e0f14cd52a999c\` FOREIGN KEY (\`medal_id\`) REFERENCES \`medals\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`member_medals\` ADD CONSTRAINT \`FK_ec0c2e763602b5d97cbe63a60b3\` FOREIGN KEY (\`awarded_by_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`events\` ADD CONSTRAINT \`FK_3ea6f200e3bcc5f1aaa4d32abfd\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`events\` ADD CONSTRAINT \`FK_5653becd652fbf5121c492731f5\` FOREIGN KEY (\`created_by_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` ADD CONSTRAINT \`FK_262b6bfcb33dafa6106dbe0063b\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` ADD CONSTRAINT \`FK_d0a278020390abed3249ad08f1b\` FOREIGN KEY (\`author_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` ADD CONSTRAINT \`FK_ec38fd08b3f1bde8837007116c1\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` ADD CONSTRAINT \`FK_e65bb1b281373c77cfa918009f6\` FOREIGN KEY (\`moderated_by_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_likes\` ADD CONSTRAINT \`FK_6de095f29df1df6546f362f84c8\` FOREIGN KEY (\`gallery_item_id\`) REFERENCES \`gallery_items\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_likes\` ADD CONSTRAINT \`FK_f3c93346d0faf9f58558cb66295\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_tagged_members\` ADD CONSTRAINT \`FK_3f343805c2130e43853509b0fd7\` FOREIGN KEY (\`gallery_item_id\`) REFERENCES \`gallery_items\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_tagged_members\` ADD CONSTRAINT \`FK_d47e98c3f94f6471564389b8dbc\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_files\` ADD CONSTRAINT \`FK_39e1b66e44c5d9d2aef7f9e5cd8\` FOREIGN KEY (\`gallery_item_id\`) REFERENCES \`gallery_items\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_tags\` ADD CONSTRAINT \`FK_640b9db5340d03f53d02a4dca1d\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_rsvps\` ADD CONSTRAINT \`FK_db0b9c02cf734572db6a58b7fd2\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_rsvps\` ADD CONSTRAINT \`FK_b9e8884da00efd9fbc13f3b5402\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_platforms\` ADD CONSTRAINT \`FK_f8f188f2d42f9cc247894e82d10\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_notify_offsets\` ADD CONSTRAINT \`FK_f20fb601621090728f214a0f7b8\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_attendees\` ADD CONSTRAINT \`FK_c296e70709cd6f4cb6b4e3e7e2a\` FOREIGN KEY (\`event_id\`) REFERENCES \`events\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_attendees\` ADD CONSTRAINT \`FK_25b3ba40ac3341413d909d1b9f9\` FOREIGN KEY (\`member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_connections\` ADD CONSTRAINT \`FK_47d36dfd5800e747e4369014761\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`bot_operations\` ADD CONSTRAINT \`FK_1dbe93fbca29c2f7c70162f1d34\` FOREIGN KEY (\`discord_connection_id\`) REFERENCES \`discord_connections\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`role_permissions\` ADD CONSTRAINT \`FK_962644dd7645bfda41037f3cda5\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`audit_log_entries\` ADD CONSTRAINT \`FK_23e54732c863d7c5375661faa99\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`audit_log_entries\` ADD CONSTRAINT \`FK_86d534f0a7c3b3760540d6ae203\` FOREIGN KEY (\`actor_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`audit_log_entries\` ADD CONSTRAINT \`FK_5a47a86d25ce568f671154e0247\` FOREIGN KEY (\`target_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`applications\` ADD CONSTRAINT \`FK_bc32cb4e5362b6bc160ecfb68be\` FOREIGN KEY (\`regiment_id\`) REFERENCES \`regiments\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`applications\` ADD CONSTRAINT \`FK_e00fbd700a2bfe9ef811efc0c4d\` FOREIGN KEY (\`discord_identity_id\`) REFERENCES \`discord_identities\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`applications\` ADD CONSTRAINT \`FK_47d934801454441b6408325b609\` FOREIGN KEY (\`promoted_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`applications\` ADD CONSTRAINT \`FK_5ee46b9af260d79b1fbb71be91f\` FOREIGN KEY (\`decided_by_member_id\`) REFERENCES \`members\`(\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`applications\` DROP FOREIGN KEY \`FK_5ee46b9af260d79b1fbb71be91f\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`applications\` DROP FOREIGN KEY \`FK_47d934801454441b6408325b609\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`applications\` DROP FOREIGN KEY \`FK_e00fbd700a2bfe9ef811efc0c4d\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`applications\` DROP FOREIGN KEY \`FK_bc32cb4e5362b6bc160ecfb68be\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`audit_log_entries\` DROP FOREIGN KEY \`FK_5a47a86d25ce568f671154e0247\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`audit_log_entries\` DROP FOREIGN KEY \`FK_86d534f0a7c3b3760540d6ae203\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`audit_log_entries\` DROP FOREIGN KEY \`FK_23e54732c863d7c5375661faa99\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`role_permissions\` DROP FOREIGN KEY \`FK_962644dd7645bfda41037f3cda5\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`bot_operations\` DROP FOREIGN KEY \`FK_1dbe93fbca29c2f7c70162f1d34\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`discord_connections\` DROP FOREIGN KEY \`FK_47d36dfd5800e747e4369014761\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_attendees\` DROP FOREIGN KEY \`FK_25b3ba40ac3341413d909d1b9f9\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_attendees\` DROP FOREIGN KEY \`FK_c296e70709cd6f4cb6b4e3e7e2a\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_notify_offsets\` DROP FOREIGN KEY \`FK_f20fb601621090728f214a0f7b8\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_platforms\` DROP FOREIGN KEY \`FK_f8f188f2d42f9cc247894e82d10\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_rsvps\` DROP FOREIGN KEY \`FK_b9e8884da00efd9fbc13f3b5402\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_rsvps\` DROP FOREIGN KEY \`FK_db0b9c02cf734572db6a58b7fd2\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`event_tags\` DROP FOREIGN KEY \`FK_640b9db5340d03f53d02a4dca1d\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_files\` DROP FOREIGN KEY \`FK_39e1b66e44c5d9d2aef7f9e5cd8\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_tagged_members\` DROP FOREIGN KEY \`FK_d47e98c3f94f6471564389b8dbc\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_tagged_members\` DROP FOREIGN KEY \`FK_3f343805c2130e43853509b0fd7\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_likes\` DROP FOREIGN KEY \`FK_f3c93346d0faf9f58558cb66295\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_likes\` DROP FOREIGN KEY \`FK_6de095f29df1df6546f362f84c8\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` DROP FOREIGN KEY \`FK_e65bb1b281373c77cfa918009f6\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` DROP FOREIGN KEY \`FK_ec38fd08b3f1bde8837007116c1\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` DROP FOREIGN KEY \`FK_d0a278020390abed3249ad08f1b\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`gallery_items\` DROP FOREIGN KEY \`FK_262b6bfcb33dafa6106dbe0063b\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`events\` DROP FOREIGN KEY \`FK_5653becd652fbf5121c492731f5\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`events\` DROP FOREIGN KEY \`FK_3ea6f200e3bcc5f1aaa4d32abfd\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`member_medals\` DROP FOREIGN KEY \`FK_ec0c2e763602b5d97cbe63a60b3\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`member_medals\` DROP FOREIGN KEY \`FK_6e382b4b28b63e0f14cd52a999c\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`member_medals\` DROP FOREIGN KEY \`FK_db6b044c2419a867711f9034a7a\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`medals\` DROP FOREIGN KEY \`FK_4d4fe1e425ce5b5aa70d1c94183\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`account_deletion_requests\` DROP FOREIGN KEY \`FK_dc0c2c9924dd5f65f6053692cb6\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`service_record_entries\` DROP FOREIGN KEY \`FK_261cf55432ee7afccd8871b2dbd\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`service_record_entries\` DROP FOREIGN KEY \`FK_41979f5d8a5c9653fa276f634a0\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`notification_reads\` DROP FOREIGN KEY \`FK_9615bdb2455ce385890ba0c20c3\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`notification_reads\` DROP FOREIGN KEY \`FK_30122217fe6ea5e114793efd4d5\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`notifications\` DROP FOREIGN KEY \`FK_cff35d7cc13dc54da053b8cd4a2\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiment_settings\` DROP FOREIGN KEY \`FK_9171904809f0f0cf9616a8c3e6f\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiments\` DROP FOREIGN KEY \`FK_8e799b5c6734a2708d69355246b\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`regiments\` DROP FOREIGN KEY \`FK_0951f5839ad93c1920e207a8356\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`members\` DROP FOREIGN KEY \`FK_4c80ec095927d933f9e9781cd28\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`members\` DROP FOREIGN KEY \`FK_6e0b49ba170f0a110c27d8b5d9a\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`members\` DROP FOREIGN KEY \`FK_d7438ae4609c094c856dbb2a3ec\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`ranks\` DROP FOREIGN KEY \`FK_4a7114fb3ec445a0e8482e416b2\``,
    );
    await queryRunner.query(`DROP INDEX \`IDX_83bce80883215e6643c60560a2\` ON \`applications\``);
    await queryRunner.query(`DROP INDEX \`IDX_e00fbd700a2bfe9ef811efc0c4\` ON \`applications\``);
    await queryRunner.query(`DROP TABLE \`applications\``);
    await queryRunner.query(`DROP TABLE \`audit_actions\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_2206ccb8c578c2cb9ed9d087e8\` ON \`audit_log_entries\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_edc21a1b74a05198ef1836725a\` ON \`audit_log_entries\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_c75796d990c79d87bc868b8e28\` ON \`audit_log_entries\``,
    );
    await queryRunner.query(`DROP TABLE \`audit_log_entries\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_7eafc810c29ab08b8e1e2a9ad0\` ON \`role_permissions\``,
    );
    await queryRunner.query(`DROP TABLE \`role_permissions\``);
    await queryRunner.query(`DROP TABLE \`bot_operations\``);
    await queryRunner.query(
      `DROP INDEX \`REL_47d36dfd5800e747e436901476\` ON \`discord_connections\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_47d36dfd5800e747e436901476\` ON \`discord_connections\``,
    );
    await queryRunner.query(`DROP TABLE \`discord_connections\``);
    await queryRunner.query(`DROP INDEX \`IDX_25b3ba40ac3341413d909d1b9f\` ON \`event_attendees\``);
    await queryRunner.query(`DROP TABLE \`event_attendees\``);
    await queryRunner.query(`DROP TABLE \`event_notify_offsets\``);
    await queryRunner.query(`DROP TABLE \`event_platforms\``);
    await queryRunner.query(`DROP INDEX \`IDX_1d4845cabaac61a065b68528b1\` ON \`event_rsvps\``);
    await queryRunner.query(`DROP INDEX \`IDX_b9e8884da00efd9fbc13f3b540\` ON \`event_rsvps\``);
    await queryRunner.query(`DROP TABLE \`event_rsvps\``);
    await queryRunner.query(`DROP TABLE \`event_tags\``);
    await queryRunner.query(`DROP TABLE \`gallery_files\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_d47e98c3f94f6471564389b8db\` ON \`gallery_tagged_members\``,
    );
    await queryRunner.query(`DROP TABLE \`gallery_tagged_members\``);
    await queryRunner.query(`DROP INDEX \`IDX_f3c93346d0faf9f58558cb6629\` ON \`gallery_likes\``);
    await queryRunner.query(`DROP TABLE \`gallery_likes\``);
    await queryRunner.query(`DROP INDEX \`IDX_3842078cc96a817511673e5c4c\` ON \`gallery_items\``);
    await queryRunner.query(`DROP INDEX \`IDX_d0a278020390abed3249ad08f1\` ON \`gallery_items\``);
    await queryRunner.query(`DROP TABLE \`gallery_items\``);
    await queryRunner.query(`DROP INDEX \`IDX_9decac599b25b3df4f32ded9d3\` ON \`events\``);
    await queryRunner.query(`DROP INDEX \`IDX_da080c835c9fc4e0aa5e8fe264\` ON \`events\``);
    await queryRunner.query(`DROP TABLE \`events\``);
    await queryRunner.query(`DROP INDEX \`IDX_b2d56e7f424f02f8f74187ca03\` ON \`member_medals\``);
    await queryRunner.query(`DROP INDEX \`IDX_6e382b4b28b63e0f14cd52a999\` ON \`member_medals\``);
    await queryRunner.query(`DROP TABLE \`member_medals\``);
    await queryRunner.query(`DROP INDEX \`IDX_d8af5991441b8ae4af4262d2a1\` ON \`medals\``);
    await queryRunner.query(`DROP TABLE \`medals\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_71f22dbfcf5f7842fb2eae4318\` ON \`account_deletion_requests\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_dc0c2c9924dd5f65f6053692cb\` ON \`account_deletion_requests\``,
    );
    await queryRunner.query(`DROP TABLE \`account_deletion_requests\``);
    await queryRunner.query(`DROP TABLE \`service_record_entries\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_9615bdb2455ce385890ba0c20c\` ON \`notification_reads\``,
    );
    await queryRunner.query(`DROP TABLE \`notification_reads\``);
    await queryRunner.query(`DROP TABLE \`notifications\``);
    await queryRunner.query(`DROP TABLE \`regiment_settings\``);
    await queryRunner.query(`DROP INDEX \`IDX_73aa91c5cbb4f2aa08b950453e\` ON \`regiments\``);
    await queryRunner.query(`DROP INDEX \`IDX_3ada956a6b22140bbfacd7fbd4\` ON \`regiments\``);
    await queryRunner.query(`DROP TABLE \`regiments\``);
    await queryRunner.query(`DROP TABLE \`accent_tones\``);
    await queryRunner.query(`DROP INDEX \`REL_6e0b49ba170f0a110c27d8b5d9\` ON \`members\``);
    await queryRunner.query(`DROP INDEX \`IDX_d75eefa29c161d6add2a30a10e\` ON \`members\``);
    await queryRunner.query(`DROP INDEX \`IDX_accd93971fb3c5cd788335d015\` ON \`members\``);
    await queryRunner.query(`DROP TABLE \`members\``);
    await queryRunner.query(`DROP INDEX \`IDX_1f397ff9017de3ba6ac31a0699\` ON \`ranks\``);
    await queryRunner.query(`DROP INDEX \`IDX_50b2f0a10137279e0b70416a9a\` ON \`ranks\``);
    await queryRunner.query(`DROP TABLE \`ranks\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_e4fe01b5499a8292b386bfafdf\` ON \`discord_identities\``,
    );
    await queryRunner.query(`DROP TABLE \`discord_identities\``);
  }
}
