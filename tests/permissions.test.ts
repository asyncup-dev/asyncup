import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildOpenApi } from '../src/api/spec/openapi.js';
import { ROUTES } from '../src/api/spec/routes.js';
import { COMMAND_PERMISSIONS, OPEN_COMMANDS } from '../src/core/commands.js';
import { BUILT_IN_ROLES, can, canSomewhere, PERMISSIONS, resolveAccess, standupsWith, type Permission } from '../src/core/permissions.js';
import { makeStack, seedStandup } from './helpers.js';

const WORKSPACE_ONLY = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => PERMISSIONS[p].workspaceOnly);

describe('built-in roles', () => {
  it('give admins everything and keep workspace powers away from managers', () => {
    expect(BUILT_IN_ROLES.admin.permissions).toEqual(Object.keys(PERMISSIONS) as Permission[]);
    for (const role of [BUILT_IN_ROLES.manager, BUILT_IN_ROLES.viewer, BUILT_IN_ROLES.member]) {
      expect(role.permissions.filter((p) => WORKSPACE_ONLY.includes(p))).toEqual([]);
    }
    expect(BUILT_IN_ROLES.member.permissions.every((p) => BUILT_IN_ROLES.viewer.permissions.includes(p))).toBe(true);
    expect(BUILT_IN_ROLES.viewer.permissions.every((p) => BUILT_IN_ROLES.manager.permissions.includes(p))).toBe(true);
  });
});

describe('access checks', () => {
  const access = { workspace: new Set<Permission>(['export']), standups: new Map([[1, new Set<Permission>(['people.manage'])], [2, new Set<Permission>()]]) };

  it('answers per standup, with workspace grants covering every standup', () => {
    expect(can(access, 'export')).toBe(true);
    expect(can(access, 'export', 9)).toBe(true);
    expect(can(access, 'people.manage', 1)).toBe(true);
    expect(can(access, 'people.manage', 2)).toBe(false);
    expect(can(access, 'people.manage')).toBe(false);
    expect(canSomewhere(access, 'people.manage')).toBe(true);
    expect(canSomewhere(access, 'export')).toBe(true);
    expect(canSomewhere(access, 'settings.manage')).toBe(false);
    expect(standupsWith(access, 'people.manage')).toEqual([1]);
  });

  it('works out Member on rosters and Manager where someone administers', async () => {
    const { repo } = await makeStack();
    const s = await seedStandup(repo);
    const other = await repo.createStandup({ tenantId: s.tenantId, spaceName: 'spaces/other', name: 'Other', timezone: s.timezone });
    await repo.addAdmin(other.id, 'users/alice', 'Alice');

    const alice = await resolveAccess(repo, { tenantId: s.tenantId, userName: 'users/alice' }, false);
    expect(alice.workspace.size).toBe(0);
    expect([...alice.standups.get(s.id)!]).toEqual(BUILT_IN_ROLES.member.permissions);
    expect([...alice.standups.get(other.id)!]).toEqual(BUILT_IN_ROLES.manager.permissions);
    expect((await resolveAccess(repo, { tenantId: s.tenantId, userName: null }, false)).standups.size).toBe(0);
    expect([...(await resolveAccess(repo, { tenantId: s.tenantId, userName: 'users/alice' }, true)).workspace]).toEqual(BUILT_IN_ROLES.admin.permissions);
  });
});

describe('nothing is left unchecked', () => {
  it('names a permission for every admin and manager route, and standup routes only use standup permissions', () => {
    for (const r of ROUTES) {
      if (r.access === 'manager' || r.access === 'admin') expect({ route: `${r.method} ${r.path}`, permission: r.permission }).toEqual({ route: `${r.method} ${r.path}`, permission: expect.any(String) });
      if (r.permission && r.path.startsWith('/standups/:id') && r.method !== 'delete') expect(PERMISSIONS[r.permission].workspaceOnly).toBe(false);
    }
    const op = (buildOpenApi() as any).paths['/standups/{id}/export.csv'].get;
    expect(op['x-permission']).toBe('export');
    expect(op.description).toContain('Needs the “Export” permission (`export`).');
  });

  it('gives every Chat command either open access or a permission', () => {
    const source = readFileSync(new URL('../src/core/commands.ts', import.meta.url), 'utf8');
    const main = source.slice(source.indexOf('switch (command) {'), source.indexOf('Unknown command'));
    const verbs = [...main.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]!);
    expect(verbs.length).toBeGreaterThan(20);
    for (const verb of verbs) expect({ verb, covered: OPEN_COMMANDS.has(verb) || verb in COMMAND_PERMISSIONS }).toEqual({ verb, covered: true });
  });
});
