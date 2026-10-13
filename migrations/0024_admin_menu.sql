-- 0024 — Admin menu: Super Admin shows / hides sidebar items for everyone (Administration → Menu).
-- Additive only: one new table (empty = every item shown, as before) and one permission for SUPER_ADMIN.
-- Rollback: DROP TABLE admin_menu_hidden; DELETE FROM role_permissions / user_permissions / permissions
-- WHERE permission_id / id = 'perm_settings_admin_menu' (the sidebar then shows every item again).

-- Hidden sidebar items (admin page paths, e.g. 'marketing' items 'ga4'). Hiding only changes the menu:
-- what a user may open is still decided by their roles / permissions.
CREATE TABLE admin_menu_hidden (
  path      TEXT PRIMARY KEY CHECK (length(path) BETWEEN 1 AND 60 AND path NOT GLOB '*[^a-z0-9-]*'),
  hidden_by TEXT REFERENCES users (id),
  hidden_at TEXT NOT NULL
) STRICT;

INSERT INTO permissions (id, code, module, description) VALUES
  ('perm_settings_admin_menu', 'settings.admin_menu', 'settings', 'Show or hide admin menu items for every user');

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_super_admin', 'perm_settings_admin_menu');
