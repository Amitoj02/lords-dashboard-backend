import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator';

interface HealthPayload {
  status: string;
  database: string;
  uptime: number;
  timestamp: string;
}

/**
 * Two probes with deliberately different failure semantics.
 *
 * `/health/live` answers "is this process alive" and touches nothing else — it is
 * what the container healthcheck hits. A database blip must NOT mark the
 * container unhealthy, or the orchestrator restarts a perfectly good API and
 * turns a brief DB hiccup into a restart storm.
 *
 * `/health/ready` answers "can this instance actually serve traffic" and DOES
 * check the database, returning 503 when it cannot. That is what an external
 * uptime monitor should watch.
 *
 * The bare `/health` route is retained for backwards compatibility (existing
 * compose healthchecks, the deploy runbook's smoke test) and behaves like
 * `/health/ready` in body shape but, as before, always returns 200 — callers
 * that relied on parsing `database: 'down'` keep working.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async probeDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private payload(databaseUp: boolean): HealthPayload {
    return {
      status: databaseUp ? 'ok' : 'degraded',
      database: databaseUp ? 'up' : 'down',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — process is up. No dependencies checked.' })
  @ApiOkResponse({ description: 'The process is alive.' })
  live(): Omit<HealthPayload, 'database'> {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe — 503 when the database is unreachable.' })
  @ApiOkResponse({ description: 'Service is ready to accept traffic.' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable.' })
  async ready(): Promise<HealthPayload> {
    const databaseUp = await this.probeDatabase();
    if (!databaseUp) {
      throw new ServiceUnavailableException(this.payload(false));
    }
    return this.payload(true);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Legacy combined probe — always 200; inspect `database`.' })
  @ApiOkResponse({ description: 'Service is up; `database` reports reachability.' })
  async check(): Promise<HealthPayload> {
    return this.payload(await this.probeDatabase());
  }
}
