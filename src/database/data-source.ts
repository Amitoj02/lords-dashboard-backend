import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './data-source.options';

// The TypeORM CLI runs this file outside the Nest runtime, so load .env here.
loadEnv();

/**
 * DataSource instance consumed by the TypeORM CLI for migrations and by the
 * seed runner. The application itself connects via DatabaseModule.
 */
const dataSource = new DataSource(buildDataSourceOptions());

export default dataSource;
