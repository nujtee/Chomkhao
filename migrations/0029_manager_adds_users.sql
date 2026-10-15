-- Migration 0029: a MANAGER can add back-office users and give them any role up to MANAGER.
--
-- users.create + users.manage_roles (pick the role when adding someone), users.edit, users.reset_password
-- (send a new invite / reset link) and users.suspend. Still SUPER_ADMIN-only: the SUPER_ADMIN role itself
-- (granting it, or touching a SUPER_ADMIN account — user-management.service.ts), per-user permission overrides,
-- role permissions, delete / restore and force logout. SUPER_ADMIN accounts are not even listed for non-SUPER_ADMINs.
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role_manager', id FROM permissions
 WHERE code IN ('users.create', 'users.edit', 'users.manage_roles', 'users.reset_password', 'users.suspend');

-- Second line of defence for the hierarchy: the SUPER_ADMIN role is granted only by a SUPER_ADMIN
-- (granted_by NULL = set up outside the app, e.g. the first owner account).
CREATE TRIGGER trg_user_roles_super_admin_grant BEFORE INSERT ON user_roles
WHEN NEW.role_id = 'role_super_admin' AND NEW.granted_by IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = NEW.granted_by AND ur.role_id = 'role_super_admin')
BEGIN
  SELECT RAISE(ABORT, 'SUPER_ADMIN_GRANT_REQUIRES_SUPER_ADMIN');
END;
