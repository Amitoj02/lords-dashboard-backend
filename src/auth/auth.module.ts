import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../config/configuration';
import { DiscordModule } from '../discord/discord.module';
import { DiscordBotSettings } from '../discord/entities/discord-bot-settings.entity';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DiscordOAuthService } from './discord-oauth.service';
import { GuildMembershipService } from './guild-membership.service';
import { MockDiscordOAuthService } from './mock-discord-oauth.service';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { GuildGateGuard } from './guards/guild-gate.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    // DiscordBotSettings is registered (not just imported as a type) because the
    // guild gate's master switch lives on it and GuildMembershipService reads it
    // directly — DiscordModule exports only the sync service and the gateway.
    TypeOrmModule.forFeature([DiscordIdentity, Member, Regiment, DiscordBotSettings]),
    PassportModule,
    // Provides DiscordGateway so sign-in can resolve guild membership via the bot
    // (T-0050) rather than the OAuth `guilds` scope. DiscordModule does not import
    // AuthModule, so this is a one-way edge (no circular dependency).
    DiscordModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const jwt = config.get('jwt', { infer: true });
        return {
          secret: jwt.secret,
          // expiresIn is a `ms` StringValue (e.g. '7d') sourced from env.
          signOptions: { expiresIn: jwt.expiresIn as JwtSignOptions['expiresIn'] },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Deliberately NOT injected by JwtStrategy or SessionContextService: an
    // ordinary authenticated request must never be able to trigger a Discord
    // call (T-0167). Only sign-in and GET /auth/guild-status reach it.
    GuildMembershipService,
    // Swap the real Discord OAuth client for the in-process mock when
    // `discord.mock` is set. AuthService depends on DiscordOAuthService by
    // class token, so nothing downstream knows which implementation it got.
    {
      provide: DiscordOAuthService,
      useFactory: (config: ConfigService<AppConfig, true>) =>
        config.get('discord', { infer: true }).mock
          ? new MockDiscordOAuthService(config)
          : new DiscordOAuthService(config),
      inject: [ConfigService],
    },
    JwtStrategy,
    // Protect every route by default; @Public() opts out.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Enforce the guild-membership gate server-side (LDA-M5). Registered AFTER
    // JwtAuthGuard so request.user is populated; @AllowWhenGated() opts routes out.
    { provide: APP_GUARD, useClass: GuildGateGuard },
  ],
  exports: [AuthService, GuildMembershipService],
})
export class AuthModule {}
