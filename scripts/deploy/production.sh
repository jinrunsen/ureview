#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
[[ $# == 0 ]] || fail '用法：production.sh（不允许跳过进行中任务检查）'
load_config
staging_image=$(running_image "$UREVIEW_STAGING_COMPOSE_PROJECT" .Image)
staging_revision=$(image_label "$staging_image" org.opencontainers.image.revision)
[[ $staging_revision == "$revision" ]] || fail '请先部署当前提交到预发并完成验证。'
base_image=$(image_label "$staging_image" ureview.base-image)
production_image=$(running_image "$UREVIEW_PRODUCTION_COMPOSE_PROJECT")
[[ $base_image == "$production_image" ]] || fail '生产基础镜像已变，请重新部署预发并验证。'
release="$(date +%Y%m%d)-$sha"
new_image="ureview:$release"
remote docker tag "$staging_image" "$new_image"
promote "$UREVIEW_PRODUCTION_DIR" "$UREVIEW_PRODUCTION_COMPOSE_PROJECT" "$UREVIEW_PRODUCTION_ORIGIN" "$new_image" "$release" false
