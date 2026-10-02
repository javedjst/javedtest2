export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type Permission =
  | 'inbox:read'
  | 'draft:create'
  | 'message:send'
  | 'task:write'
  | 'meeting:write'
  | 'integration:manage'
  | 'user:manage'
  | 'policy:manage'
  | 'audit:read'
  | 'memory:purge_org';

const MEMBER: Permission[] = ['inbox:read', 'draft:create', 'message:send', 'task:write', 'meeting:write'];

const GRANTS: Record<Role, Permission[]> = {
  viewer: ['inbox:read', 'draft:create'],
  member: MEMBER,
  admin: [...MEMBER, 'integration:manage', 'user:manage', 'policy:manage', 'audit:read'],
  owner: [...MEMBER, 'integration:manage', 'user:manage', 'policy:manage', 'audit:read', 'memory:purge_org'],
};

export const can = (role: Role, perm: Permission) => GRANTS[role].includes(perm);

export function assertCan(role: Role, perm: Permission): void {
  if (!can(role, perm)) throw new HttpError(403, `Missing permission ${perm}`);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
