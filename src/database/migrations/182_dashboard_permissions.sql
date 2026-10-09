-- 182_dashboard_permissions.sql
-- Permission to open the main command-centre dashboard.
UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT 'dashboard.view'))
   )
 WHERE name IN ('Platform Admin', 'Finance Manager', 'Marketing Manager', 'Catalog Manager', 'Support Agent');
