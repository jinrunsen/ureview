#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
allow_active=false
case ${1:-} in
  '') ;;
  --allow-active) allow_active=true; shift ;;
  *) fail '用法：staging.sh [--allow-active]' ;;
esac
[[ $# == 0 ]] || fail '用法：staging.sh [--allow-active]'
load_config
base_image=$(running_image "$UREVIEW_PRODUCTION_COMPOSE_PROJECT")
base_id=$(running_image "$UREVIEW_PRODUCTION_COMPOSE_PROJECT" .Image)
base_revision=$(image_label "$base_id" org.opencontainers.image.revision)
[[ $(remote docker inspect "$base_image" --format '{{.Id}}') == "$base_id" ]] || fail '生产镜像标签与运行中的镜像不一致，请维护者核对。'
[[ $base_revision =~ ^[0-9a-f]{7,40}$ ]] || fail '基础镜像缺少有效 revision。'
git cat-file -e "$base_revision^{commit}" || fail '本地找不到基础镜像对应提交。'
git diff --quiet "$base_revision" HEAD -- package-lock.json || fail '依赖已变化，不能叠加编译产物。'
npm run build
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" packages/server/dist packages/server/migrations packages/server/package.json packages/web/dist packages/session-viewer/dist
release="staging-$sha"
new_image="ureview:$release"
remote mkdir -p "$UREVIEW_STAGING_DIR/releases/$release"
printf -v command '%q ' tar -xzf - -C "$UREVIEW_STAGING_DIR/releases/$release"
ssh "$UREVIEW_STAGING_SSH" "$command" < "$archive"
printf -v command '%q ' bash -s -- "$UREVIEW_STAGING_DIR/releases/$release" "$base_image" "$revision" "$new_image" "$release"
ssh "$UREVIEW_STAGING_SSH" "$command" <<'REMOTE'
set -euo pipefail
cd "$1"
[[ -z $(find . -name '._*' -print -quit) ]] || { echo '产物包含 AppleDouble 文件。' >&2; exit 1; }
cat > Dockerfile <<DOCKER
FROM $2
LABEL org.opencontainers.image.revision="$3"
LABEL org.opencontainers.image.version="$5"
LABEL ureview.base-image="$2"
RUN rm -rf /app/packages/server/dist /app/packages/server/migrations /app/packages/web/dist /app/packages/session-viewer/dist
COPY packages/server/dist /app/packages/server/dist
COPY packages/server/migrations /app/packages/server/migrations
COPY packages/server/package.json /app/packages/server/package.json
COPY packages/web/dist /app/packages/web/dist
COPY packages/session-viewer/dist /app/packages/session-viewer/dist
DOCKER
docker build -t "$4" . > build.log 2>&1
REMOTE
promote "$UREVIEW_STAGING_DIR" "$UREVIEW_STAGING_COMPOSE_PROJECT" "$UREVIEW_STAGING_ORIGIN" "$new_image" "$release" "$allow_active"
