import { Role } from '@prisma/client';
import { canChangeRole, canCreateRole, canManageUser, canViewUser } from './users.policy';

// V1.3-1:users.policy 4 个纯函数完整角色矩阵单测。
// 3 actor × 3 target = 9 组合 × 4 函数 = 36 个判定点;表格化避免重复代码。
//
// 设计要点(对齐 CLAUDE.md §13 / ARCHITECTURE.md §7.11):
//   - SUPER_ADMIN 业务 API 不可被创建 / 提升,只有 prisma/seed.ts 能产生
//   - ADMIN 仅能看到 / 管理 / 创建 USER
//   - USER 不能进入管理可见 / 管理 / 创建范围

const ROLES: Role[] = [Role.SUPER_ADMIN, Role.ADMIN, Role.USER];

type MatrixCase = [actor: Role, target: Role, expected: boolean];

describe('users.policy', () => {
  describe('canViewUser', () => {
    const cases: MatrixCase[] = [
      [Role.SUPER_ADMIN, Role.SUPER_ADMIN, true],
      [Role.SUPER_ADMIN, Role.ADMIN, true],
      [Role.SUPER_ADMIN, Role.USER, true],
      [Role.ADMIN, Role.SUPER_ADMIN, false],
      [Role.ADMIN, Role.ADMIN, false],
      [Role.ADMIN, Role.USER, true],
      [Role.USER, Role.SUPER_ADMIN, false],
      [Role.USER, Role.ADMIN, false],
      [Role.USER, Role.USER, false],
    ];

    it.each(cases)('actor=%s target=%s -> %s', (actor, target, expected) => {
      expect(canViewUser(actor, target)).toBe(expected);
    });

    it('matrix is exhaustive (3x3 = 9 cases)', () => {
      expect(cases).toHaveLength(ROLES.length * ROLES.length);
    });
  });

  describe('canManageUser', () => {
    const cases: MatrixCase[] = [
      [Role.SUPER_ADMIN, Role.SUPER_ADMIN, true],
      [Role.SUPER_ADMIN, Role.ADMIN, true],
      [Role.SUPER_ADMIN, Role.USER, true],
      [Role.ADMIN, Role.SUPER_ADMIN, false],
      [Role.ADMIN, Role.ADMIN, false],
      [Role.ADMIN, Role.USER, true],
      [Role.USER, Role.SUPER_ADMIN, false],
      [Role.USER, Role.ADMIN, false],
      [Role.USER, Role.USER, false],
    ];

    it.each(cases)('actor=%s target=%s -> %s', (actor, target, expected) => {
      expect(canManageUser(actor, target)).toBe(expected);
    });

    it('matrix is exhaustive (3x3 = 9 cases)', () => {
      expect(cases).toHaveLength(ROLES.length * ROLES.length);
    });
  });

  describe('canCreateRole', () => {
    // 业务 API 永远不能创建 SUPER_ADMIN。
    const cases: MatrixCase[] = [
      [Role.SUPER_ADMIN, Role.SUPER_ADMIN, false],
      [Role.SUPER_ADMIN, Role.ADMIN, true],
      [Role.SUPER_ADMIN, Role.USER, true],
      [Role.ADMIN, Role.SUPER_ADMIN, false],
      [Role.ADMIN, Role.ADMIN, false],
      [Role.ADMIN, Role.USER, true],
      [Role.USER, Role.SUPER_ADMIN, false],
      [Role.USER, Role.ADMIN, false],
      [Role.USER, Role.USER, false],
    ];

    it.each(cases)('actor=%s targetRole=%s -> %s', (actor, target, expected) => {
      expect(canCreateRole(actor, target)).toBe(expected);
    });

    it('SUPER_ADMIN target is rejected for every actor', () => {
      for (const actor of ROLES) {
        expect(canCreateRole(actor, Role.SUPER_ADMIN)).toBe(false);
      }
    });

    it('matrix is exhaustive (3x3 = 9 cases)', () => {
      expect(cases).toHaveLength(ROLES.length * ROLES.length);
    });
  });

  describe('canChangeRole', () => {
    // 改角色:仅 SUPER_ADMIN 可改;且永远禁止把任何人提升为 SUPER_ADMIN。
    const cases: MatrixCase[] = [
      [Role.SUPER_ADMIN, Role.SUPER_ADMIN, false],
      [Role.SUPER_ADMIN, Role.ADMIN, true],
      [Role.SUPER_ADMIN, Role.USER, true],
      [Role.ADMIN, Role.SUPER_ADMIN, false],
      [Role.ADMIN, Role.ADMIN, false],
      [Role.ADMIN, Role.USER, false],
      [Role.USER, Role.SUPER_ADMIN, false],
      [Role.USER, Role.ADMIN, false],
      [Role.USER, Role.USER, false],
    ];

    it.each(cases)('actor=%s newRole=%s -> %s', (actor, newRole, expected) => {
      expect(canChangeRole(actor, newRole)).toBe(expected);
    });

    it('SUPER_ADMIN newRole is rejected for every actor', () => {
      for (const actor of ROLES) {
        expect(canChangeRole(actor, Role.SUPER_ADMIN)).toBe(false);
      }
    });

    it('non-SUPER_ADMIN actor is rejected for every newRole', () => {
      for (const actor of [Role.ADMIN, Role.USER]) {
        for (const newRole of ROLES) {
          expect(canChangeRole(actor, newRole)).toBe(false);
        }
      }
    });

    it('matrix is exhaustive (3x3 = 9 cases)', () => {
      expect(cases).toHaveLength(ROLES.length * ROLES.length);
    });
  });
});
