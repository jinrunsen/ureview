#!/bin/sh
set -eu

# 新安装由 PostgreSQL entrypoint 执行；已有卷在停止服务后手动执行一次。
# 迁移与日常查询都使用这个非超级用户，管理凭据不交给应用容器。
psql --username "${POSTGRES_USER:-ureview}" --dbname "${POSTGRES_DB:-ureview}" \
  --set=ON_ERROR_STOP=1 --set=application_password="${UREVIEW_DATABASE_PASSWORD:-ureview}" <<'SQL'
SELECT 'CREATE ROLE ureview_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ureview_app') \gexec
ALTER ROLE ureview_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SELECT format('ALTER ROLE ureview_app PASSWORD %L', :'application_password') \gexec
SELECT format('ALTER DATABASE %I OWNER TO ureview_app', current_database()) \gexec
ALTER SCHEMA public OWNER TO ureview_app;
SELECT format('ALTER TABLE %I.%I OWNER TO ureview_app', schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO ureview_app', sequence_schema, sequence_name)
FROM information_schema.sequences WHERE sequence_schema = 'public' \gexec
SQL
