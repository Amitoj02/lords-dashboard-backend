#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Create the two least-privilege application accounts.
#
# The API used to connect as root, which meant an RCE or SQL-injection in the
# NestJS process inherited DROP/GRANT over the whole server. Split by what each
# process actually needs:
#
#   lords_app      DML only (SELECT/INSERT/UPDATE/DELETE) — the long-lived API.
#                  Cannot DROP a table, cannot read mysql.user, cannot GRANT.
#   lords_migrate  DDL on the one schema — used ONLY by the one-shot `migrate`
#                  container, which exits before the API starts.
#
# root still exists (the healthcheck pings with it) but nothing connects as root
# to serve traffic.
#
# ⚠️ docker-entrypoint-initdb.d runs ONLY when the data directory is empty, i.e.
# on the very first boot of a fresh db-data volume. Adding this to a stack whose
# volume already exists is a NO-OP and the accounts will not appear — see
# deploy/README.md for the one-off SQL to apply to an existing database.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${MYSQL_DATABASE:?MYSQL_DATABASE must be set}"
: "${APP_DB_USERNAME:?APP_DB_USERNAME must be set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
: "${MIGRATE_DB_USERNAME:?MIGRATE_DB_USERNAME must be set}"
: "${MIGRATE_DB_PASSWORD:?MIGRATE_DB_PASSWORD must be set}"

# The mysql entrypoint SOURCES a non-executable .sh (making its helper functions
# available) but EXECUTES an executable one in a subshell (where they are not).
# A bind mount can arrive either way depending on the host's file mode, so
# provide a fallback rather than depending on which path was taken.
if ! declare -F docker_process_sql >/dev/null 2>&1; then
	docker_process_sql() {
		mysql --protocol=socket -uroot -p"${MYSQL_ROOT_PASSWORD}" --database=mysql
	}
fi

echo "init: creating ${APP_DB_USERNAME} (DML) and ${MIGRATE_DB_USERNAME} (DDL) on ${MYSQL_DATABASE}"

# Host is '%' because these connect over the compose network from another
# container, never from localhost. The network itself is the perimeter: the db
# service publishes no host port in prod.
docker_process_sql <<-EOSQL
	CREATE USER IF NOT EXISTS '${APP_DB_USERNAME}'@'%'
	  IDENTIFIED BY '${APP_DB_PASSWORD}';
	GRANT SELECT, INSERT, UPDATE, DELETE
	  ON \`${MYSQL_DATABASE}\`.* TO '${APP_DB_USERNAME}'@'%';

	CREATE USER IF NOT EXISTS '${MIGRATE_DB_USERNAME}'@'%'
	  IDENTIFIED BY '${MIGRATE_DB_PASSWORD}';
	GRANT ALL PRIVILEGES
	  ON \`${MYSQL_DATABASE}\`.* TO '${MIGRATE_DB_USERNAME}'@'%';

	FLUSH PRIVILEGES;
EOSQL

echo "init: application accounts ready"
