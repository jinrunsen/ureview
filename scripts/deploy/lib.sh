#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

load_config() {
  local config=${UREVIEW_STAGING_ENV:-$HOME/.config/ureview/staging.env}
  [[ -f "$config" ]] || fail '缺少预发配置文件，请向维护者索取；可用 UREVIEW_STAGING_ENV 指定路径。'
  # shellcheck disable=SC1090
  source "$config"
  local key
  for key in UREVIEW_STAGING_ORIGIN UREVIEW_STAGING_SSH UREVIEW_STAGING_DIR UREVIEW_STAGING_COMPOSE_PROJECT UREVIEW_PRODUCTION_ORIGIN UREVIEW_PRODUCTION_DIR UREVIEW_PRODUCTION_COMPOSE_PROJECT; do
    [[ -n ${!key:-} ]] || fail "缺少配置：$key"
  done
  [[ $UREVIEW_STAGING_DIR != "$UREVIEW_PRODUCTION_DIR" && $UREVIEW_STAGING_COMPOSE_PROJECT != "$UREVIEW_PRODUCTION_COMPOSE_PROJECT" && $UREVIEW_STAGING_ORIGIN != "$UREVIEW_PRODUCTION_ORIGIN" ]] || fail '预发与生产必须使用独立目录、项目和地址。'
  cd "$(git rev-parse --show-toplevel)"
  [[ -z $(git status --porcelain) ]] || fail '工作区必须干净，请先提交改动。'
  revision=$(git rev-parse HEAD)
  sha=$(git rev-parse --short HEAD)
}

remote() {
  local command
  printf -v command '%q ' "$@"
  ssh "$UREVIEW_STAGING_SSH" "$command"
}

running_image() {
  local result
  result=$(remote docker inspect "$1-server-1" --format "{{.State.Running}} {{${2:-.Config.Image}}}")
  [[ $result == true\ * ]] || fail 'server 容器未运行。'
  printf '%s\n' "${result#true }"
}

image_label() { remote docker inspect "$1" --format "{{index .Config.Labels \"$2\"}}"; }

promote() {
  local command
  printf -v command '%q ' bash -s -- deploy "$@"
  ssh "$UREVIEW_STAGING_SSH" "$command" < scripts/deploy/lib.sh
}

# 同一份部署逻辑经标准输入在目标主机执行。
if [[ ( ${BASH_SOURCE[0]:-} == "$0" || -z ${BASH_SOURCE[0]:-} ) && ${1:-} == deploy ]]; then
  shift
  directory=$1 project=$2 origin=$3 new_image=$4 release=$5 allow_active=$6
  umask 077
  cd "$directory"
  exec 9>.deploy.lock
  flock -n 9 || fail '该环境已有部署正在执行。'
  compose=(docker compose -p "$project" -f docker-compose.yml)
  db=$("${compose[@]}" ps -q db)
  [[ -n $db ]] || fail '数据库容器未运行。'
  # 旧版本尚未创建导入表，升级前没有该类任务。
  imports_exist=$(docker exec "$db" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"' sh "SELECT to_regclass('public.rule_library_imports') IS NOT NULL")
  import_count=0
  if [[ $imports_exist == t ]]; then
    import_count=$(docker exec "$db" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"' sh "SELECT count(*) FROM rule_library_imports WHERE status IN ('queued','planning','generating')")
  fi
  active=$(docker exec "$db" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"' sh "SELECT (SELECT count(*) FROM reviews WHERE status IN ('queued','running'))+(SELECT count(*) FROM agent_sessions WHERE status='running')+(SELECT count(*) FROM reading_documents WHERE status IN ('queued','running'))+(SELECT count(*) FROM managed_rule_sessions WHERE generation_id IS NOT NULL)")
  active=$((active + import_count))
  [[ $active == 0 || $allow_active == true ]] || fail "仍有 $active 个进行中的任务，未部署。"
  backup="backups/$release-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  cp .env docker-compose.yml "$backup/"
  docker exec "$db" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
  restore() {
    trap - ERR INT TERM
    cp "$backup/docker-compose.yml" docker-compose.yml
    "${compose[@]}" up -d --no-deps --no-build server
    fail '新版本未就绪，已恢复原 compose 并重启；数据库备份保留。'
  }
  trap restore ERR INT TERM
  python3 - "$new_image" <<'PY'
import re, sys
from pathlib import Path
p = Path('docker-compose.yml')
s = p.read_text()
m = re.search(r'^  server:\s*\n(?:(?: {4}[^\n]*|[ \t]*)\n)*', s, re.M)
assert m, '找不到 server 服务'
block, count = re.subn(r'^    image:.*$', '    image: ' + sys.argv[1], m[0], flags=re.M)
assert count == 1, 'server 必须恰好有一个 image 字段'
p.write_text(s[:m.start()] + block + s[m.end():])
PY
  "${compose[@]}" up -d --no-deps --no-build server
  healthy=false
  for ((attempt=0; attempt<40; attempt++)); do
    if curl --connect-timeout 3 --max-time 5 -fsS "$origin/health" > "$backup/health-after.json" 2>/dev/null; then healthy=true; break; fi
    sleep 3
  done
  [[ $healthy == true ]] || restore
  trap - ERR INT TERM
  printf '镜像：%s\n备份：%s/%s\n' "$new_image" "$directory" "$backup"
  printf '回滚命令：cd %q && cp %q docker-compose.yml && docker compose -p %q -f docker-compose.yml up -d --no-deps --no-build server\n' "$directory" "$backup/docker-compose.yml" "$project"
fi
