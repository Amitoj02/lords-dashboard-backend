import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/**
 * Catches every thrown error and renders a consistent JSON envelope.
 * Internal errors never leak stack traces or driver details to the client;
 * they are logged server-side and surfaced as a generic 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'InternalServerError';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        message = (body.message as string | string[]) ?? exception.message;
        error = (body.error as string) ?? exception.name;
      }
      if (error === 'InternalServerError') error = exception.name;
    } else if (exception instanceof QueryFailedError) {
      // Map common MySQL integrity errors to a 409 without leaking SQL.
      const driverCode = (exception as QueryFailedError & { code?: string }).code;
      if (driverCode === 'ER_DUP_ENTRY') {
        status = HttpStatus.CONFLICT;
        message = 'A record with the same unique value already exists';
        error = 'Conflict';
      } else {
        message = 'Database request failed';
        error = 'DatabaseError';
      }
      this.logger.error(`QueryFailedError: ${exception.message}`);
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled exception: ${exception.message}`, exception.stack);
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`${request.method} ${request.url} -> ${status}`);
    }

    response.status(status).json(body);
  }
}
