// Read the built-in role definitions from the exact runtime source checkout.
const { RBAC_SEED_CATALOG: catalog } = require('/app/prisma/seed.ts');
const roles = [
  catalog.roles.attendanceFinalReviewer,
  ...catalog.roles.activityResponsibility.filter((r) =>
    ['activity-owner', 'attendance-first-reviewer'].includes(r.code),
  ),
];
const codes = new Set(roles.flatMap((r) => r.permissionCodes));
const defs = Object.values(catalog.permissions)
  .flat()
  .filter((p) => codes.has(p.code));
console.log(JSON.stringify({ roles, defs }));
