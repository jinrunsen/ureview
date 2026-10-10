ALTER TABLE auth_users ADD COLUMN username text;

-- 原始前缀全部预留，重复前缀的后缀不能占用其他账号的原始前缀。
CREATE TEMP TABLE auth_username_prefixes ON COMMIT DROP AS
SELECT id,lower(split_part(email,'@',1)) AS prefix,created_at FROM auth_users;

DO $$
DECLARE
    account record;
    candidate text;
    suffix bigint;
BEGIN
    FOR account IN SELECT * FROM auth_username_prefixes ORDER BY created_at,id LOOP
        candidate := account.prefix;
        suffix := 1;
        WHILE EXISTS (SELECT 1 FROM auth_users WHERE username=candidate) LOOP
            LOOP
                suffix := suffix+1;
                candidate := left(account.prefix,254-length(suffix::text)-1)||'-'||suffix;
                EXIT WHEN NOT EXISTS (SELECT 1 FROM auth_username_prefixes WHERE prefix=candidate);
            END LOOP;
        END LOOP;
        UPDATE auth_users SET username=candidate WHERE id=account.id;
    END LOOP;
END
$$;

ALTER TABLE auth_users
    ALTER COLUMN username SET NOT NULL,
    ADD CONSTRAINT auth_users_username_key UNIQUE (username),
    ADD CONSTRAINT auth_users_username_check CHECK (
        length(username) BETWEEN 1 AND 254 AND username=lower(username) AND username !~ '[[:space:]@]'
    ),
    ALTER COLUMN email DROP NOT NULL,
    DROP CONSTRAINT auth_users_email_key;
