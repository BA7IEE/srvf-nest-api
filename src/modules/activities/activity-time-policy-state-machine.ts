/** D1-1: lifecycle edges only; no authorization or clock assumptions. */
export function canTransitionTimePolicyVersion(current: unknown, next: unknown): boolean {
  return (current === 'draft' && next === 'active') || (current === 'active' && next === 'retired');
}
