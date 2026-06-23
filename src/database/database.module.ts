import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../config/configuration';
import { buildDataSourceOptions } from './data-source.options';

/**
 * Wires TypeORM into the Nest runtime using the same options builder the CLI
 * uses. `autoLoadEntities` registers every entity declared via
 * `TypeOrmModule.forFeature(...)` in feature modules.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => {
        const db = configService.get('database', { infer: true });
        return {
          ...buildDataSourceOptions(),
          host: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.database,
          logging: db.logging,
          autoLoadEntities: true,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
