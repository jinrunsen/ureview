#!/usr/bin/env bash
# Deterministic lint gate for .feature files (writing-features skill).
#
# Direct mode:  lint-feature.sh a.feature [b.feature ...]
# Hook mode:    no args — reads Claude Code PostToolUse JSON on stdin,
#               extracts tool_input.file_path, exits 0 for non-.feature files.
#
# Exit codes: 0 = clean / not applicable, 2 = findings (printed to stderr).
set -u

files=()
if [ $# -gt 0 ]; then
  files=("$@")
else
  input=$(cat 2>/dev/null || true)
  f=""
  if command -v jq >/dev/null 2>&1; then
    f=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
  fi
  if [ -z "$f" ]; then
    f=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  fi
  [ -z "$f" ] && exit 0
  case "$f" in
    *.feature) files=("$f") ;;
    *) exit 0 ;;
  esac
fi

bad=0
for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "lint-feature: no such file: $f" >&2
    bad=1
    continue
  fi

  # Check 1 — tag lines must sit immediately above Feature:/Scenario: (or stack
  # on another tag line). Anything else — a step, a blank line, EOF — including
  # tags placed AFTER the keyword (invalid Gherkin, behave ParserError), fails.
  awk '
    expect && $0 !~ /^[[:space:]]*(@|Feature:|Scenario:|Scenario Outline:|Examples:)/ {
      print FILENAME ":" nr ": 标签行未紧邻 Feature:/Scenario: 上一行"; bad = 1
    }
    { expect = ($0 ~ /^[[:space:]]*@/); nr = NR }
    END { if (expect) { print FILENAME ":" nr ": 文件末尾悬空标签行"; bad = 1 } exit bad }
  ' "$f" 1>&2 || bad=1

  # Check 2 — every scenario's EFFECTIVE tags (Feature-level ∪ scenario-level)
  # carry exactly one @layer:, one @level:, one @spec:; and @level:/@spec: are
  # never hoisted to the Feature: line.
  awk '
    function count(s, re,  n) { n = 0; while (match(s, re)) { n++; s = substr(s, RSTART + RLENGTH) }; return n }
    /^[[:space:]]*@/ { pend = pend " " $0; next }
    /^[[:space:]]*Feature:/ {
      feat = pend; pend = ""
      if (count(feat, "@level:") + count(feat, "@spec:") > 0) { print FILENAME ":" NR ": @level:/@spec: 不得上提到 Feature 级"; bad = 1 }
      next
    }
    /^[[:space:]]*Scenario( Outline)?:/ {
      eff = feat " " pend; pend = ""
      if (count(eff, "@layer:") != 1) { print FILENAME ":" NR ": @layer: 数量 != 1"; bad = 1 }
      if (count(eff, "@level:") != 1) { print FILENAME ":" NR ": @level: 数量 != 1"; bad = 1 }
      if (count(eff, "@spec:")  != 1) { print FILENAME ":" NR ": @spec: 数量 != 1"; bad = 1 }
      next
    }
    { pend = "" }
    END { exit bad }
  ' "$f" 1>&2 || bad=1
done

if [ "$bad" -ne 0 ]; then
  echo "lint-feature: FAILED — fix the findings above. Rules: .claude/rules/feature-writing.md" >&2
  exit 2
fi
exit 0
