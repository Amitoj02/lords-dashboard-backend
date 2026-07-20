#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Provision the deploy account on the production VPS. Run ON the box, as deploy:
#
#   cd ~/lords && ./deploy/bootstrap.sh
#
# Idempotent and safe to re-run: it never overwrites an existing .env,
# backup.env or rclone.conf, and re-running after a `git pull` is the intended
# way to pick up changes to the helper scripts and systemd units.
#
# Needs NO root. Everything lives under ~ — the deploy account already owns the
# docker socket, and `loginctl enable-linger deploy` lets its systemd user units
# run without a login session. Phase 3 steps 1-9 of the plan (the parts that DO
# need root: docker, ufw, sshd, swap, unattended-upgrades, qemu-guest-agent)
# are assumed already done.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${LORDS_APP_DIR:-$HOME/lords}"
BIN_DIR="$HOME/bin"
UNIT_DIR="$HOME/.config/systemd/user"
RCLONE_VERSION="${RCLONE_VERSION:-current}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[34m·\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/deploy" ] || die "run this from the synced app dir ($APP_DIR/deploy not found)"

# ── Preflight ───────────────────────────────────────────────────────────────
step "Preflight"
command -v docker >/dev/null || die "docker not installed (plan Phase 3 step 5)"
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin missing"
docker ps >/dev/null 2>&1 || die "cannot talk to the docker socket — is $USER in the docker group?"
ok "docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1), compose plugin present"

if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" = yes ]; then
	ok "systemd linger enabled (user timers run without a login session)"
else
	warn "linger is OFF — the backup timer will only run while you are logged in."
	warn "fix with: loginctl enable-linger $USER"
fi

mkdir -p "$BIN_DIR" "$UNIT_DIR"

# ── Helper scripts ──────────────────────────────────────────────────────────
step "Helper scripts → $BIN_DIR"
for script in lords-deploy lords-backup lords-restore-drill; do
	install -m 0755 "$APP_DIR/deploy/bin/$script" "$BIN_DIR/$script"
	ok "$script"
done

case ":$PATH:" in
	*":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
	*) warn "$BIN_DIR is not on PATH — add it to ~/.profile if you want to call these by name" ;;
esac

# ── rclone ──────────────────────────────────────────────────────────────────
step "rclone"
if command -v rclone >/dev/null; then
	ok "already installed ($(rclone version | head -1))"
else
	info "installing to $BIN_DIR (no root needed)"
	tmp="$(mktemp -d)"
	arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
	curl -fsSL "https://downloads.rclone.org/rclone-${RCLONE_VERSION}-linux-${arch}.zip" \
		-o "$tmp/rclone.zip" || die "rclone download failed"

	# `unzip` is NOT part of a minimal Debian 13 install and pulling it in would
	# need root, which nothing else here does. python3 is present (it is an
	# essential dependency of the base system) and its zipfile module is enough.
	if command -v unzip >/dev/null; then
		( cd "$tmp" && unzip -q rclone.zip )
	elif command -v python3 >/dev/null; then
		python3 -m zipfile -e "$tmp/rclone.zip" "$tmp/" || die "could not extract rclone"
	else
		die "need unzip or python3 to extract rclone"
	fi

	found="$(find "$tmp" -name rclone -type f -print -quit)"
	[ -n "$found" ] || die "rclone binary not found in the archive"
	install -m 0755 "$found" "$BIN_DIR/rclone"
	rm -rf "$tmp"
	"$BIN_DIR/rclone" version >/dev/null || die "rclone install failed"
	ok "installed $("$BIN_DIR/rclone" version | head -1)"
fi

# ── Secrets ─────────────────────────────────────────────────────────────────
step "Environment file"
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
	ok ".env already exists — left untouched"
else
	# Hex, not base64, for everything embedded in SQL or a MySQL connection
	# string: the initdb script interpolates the DB passwords into single-quoted
	# SQL literals, where a stray quote or backslash would break the statement
	# (or worse). Hex sidesteps quoting entirely. 48 hex chars = 192 bits.
	gen_hex() { openssl rand -hex "$1"; }

	info "generating secrets with openssl rand"
	sed \
		-e "s|DB_PASSWORD=‹GENERATED›|DB_PASSWORD=$(gen_hex 24)|" \
		-e "s|APP_DB_PASSWORD=‹GENERATED›|APP_DB_PASSWORD=$(gen_hex 24)|" \
		-e "s|MIGRATE_DB_PASSWORD=‹GENERATED›|MIGRATE_DB_PASSWORD=$(gen_hex 24)|" \
		-e "s|JWT_SECRET=‹GENERATED›|JWT_SECRET=$(gen_hex 48)|" \
		-e "s|ENCRYPTION_KEY=‹GENERATED›|ENCRYPTION_KEY=$(gen_hex 32)|" \
		"$APP_DIR/deploy/env.production.template" >"$ENV_FILE"
	chmod 600 "$ENV_FILE"
	ok "wrote $ENV_FILE (0600) with real generated secrets"
	warn "the ‹REQUIRED› placeholders are still there — fill them in before deploying"
fi

if [ -f "$APP_DIR/backup.env" ]; then
	ok "backup.env already exists — left untouched"
else
	install -m 0600 "$APP_DIR/deploy/backup.env.template" "$APP_DIR/backup.env"
	ok "wrote backup.env (0600)"
fi

# ── rclone config ───────────────────────────────────────────────────────────
step "rclone config"
RCLONE_CONF="$HOME/.config/rclone/rclone.conf"
mkdir -p "$(dirname "$RCLONE_CONF")"
if [ -f "$RCLONE_CONF" ]; then
	ok "rclone.conf already exists — left untouched"
else
	cat >"$RCLONE_CONF" <<'EOF'
# Cloudflare R2, for database backups.
#
# Use a SEPARATE token from the media bucket's: this one needs Object Read &
# Write on lords-backups only. A media-bucket key must never be able to read or
# delete the backups.
#
# region MUST be the literal "auto" for R2.
[r2]
type = s3
provider = Cloudflare
region = auto
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
access_key_id = <R2 backups token access key id>
secret_access_key = <R2 backups token secret>
no_check_bucket = true
EOF
	chmod 600 "$RCLONE_CONF"
	ok "wrote rclone.conf template (0600)"
	warn "fill in the R2 account id and the lords-backups token before enabling the timer"
fi

# ── systemd user units ──────────────────────────────────────────────────────
step "systemd user units"
for unit in lords-backup.service lords-backup.timer; do
	install -m 0644 "$APP_DIR/deploy/systemd/$unit" "$UNIT_DIR/$unit"
	ok "$unit"
done
systemctl --user daemon-reload
ok "daemon-reload"

# The timer is NOT enabled here on purpose: enabling it before rclone.conf holds
# real credentials just guarantees a failing unit and a misleading first alert.
if systemctl --user is-enabled lords-backup.timer >/dev/null 2>&1; then
	ok "lords-backup.timer already enabled"
	systemctl --user list-timers lords-backup.timer --no-pager | sed -n '2p' | sed 's/^/    /'
else
	info "timer not enabled yet — enable it once rclone.conf has real credentials:"
	info "  systemctl --user enable --now lords-backup.timer"
fi

# ── Validate ────────────────────────────────────────────────────────────────
step "Validation"
cd "$APP_DIR"

# Checked BEFORE the compose parse, and separately from it. Compose only asserts
# that a ${VAR:?} is non-empty — the placeholder text is non-empty, so a .env
# full of ‹REQUIRED› markers sails through `compose config` and then fails at
# runtime as an invalid Discord client or a 401 from R2. Grep for the markers.
# `grep -v ':#'` drops the header comments that explain the markers — otherwise
# the file's own documentation counts itself as unfinished configuration.
PLACEHOLDERS="$(grep -n '‹' "$ENV_FILE" | grep -v '^[0-9]*:[[:space:]]*#' || true)"
UNSET_COUNT="$(printf '%s' "$PLACEHOLDERS" | grep -c . || true)"
if [ "$UNSET_COUNT" -gt 0 ]; then
	warn "$UNSET_COUNT value(s) in .env still need you:"
	printf '%s\n' "$PLACEHOLDERS" | cut -d= -f1 | cut -d: -f2- | sed 's/^/      /'
else
	ok "no placeholder values left in .env"
fi

if docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null 2>"$APP_DIR/.compose-err"; then
	if [ "$UNSET_COUNT" -eq 0 ]; then
		ok "compose config parses and every required variable is set"
	else
		info "compose config parses (but see the placeholders above — it cannot detect those)"
	fi
	rm -f "$APP_DIR/.compose-err"
else
	warn "compose config is not yet satisfiable:"
	grep -oE 'required variable [A-Z_]+ is missing[^"]*|error[^"]*' "$APP_DIR/.compose-err" \
		| sort -u | sed 's/^/      /' | head -20
	rm -f "$APP_DIR/.compose-err"
	info "this is expected until the ‹REQUIRED› values in .env are filled in"
fi

step "Bootstrap complete"
cat <<EOF

  Remaining steps that need you (see deploy/README.md):

    1. Fill the ‹REQUIRED› values in   $ENV_FILE
    2. Fill the R2 backup token in     $RCLONE_CONF
    3. docker login ghcr.io -u <you> --password-stdin   (PAT with read:packages)
    4. Add the Cloudflare DNS records for the apex and www
    5. ~/bin/lords-deploy   via   ssh, or run the deploy workflow

EOF
