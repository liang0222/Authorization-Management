-- v1.5 备份与灾备：新增三个权限码，并授予内置角色。
-- 只影响内置角色（roles.code 命中预设），自定义角色的显式授权保持不变。
INSERT INTO permissions (code, description) VALUES
  ('backup:read',    '查看备份目标、策略与作业'),
  ('backup:write',   '配置存储目标、发起备份、重传与校验'),
  ('backup:restore', '执行隔离恢复演练与生产恢复')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, x.permission_code
FROM roles r
JOIN (
  VALUES
    ('owner',    'backup:read'),
    ('owner',    'backup:write'),
    ('owner',    'backup:restore'),
    ('admin',    'backup:read'),
    ('admin',    'backup:write'),
    ('admin',    'backup:restore'),
    ('operator', 'backup:read'),
    ('viewer',   'backup:read')
) AS x(role_code, permission_code) ON r.code = x.role_code
ON CONFLICT (role_id, permission_code) DO NOTHING;
