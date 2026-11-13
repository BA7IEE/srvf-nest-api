import { OrganizationsService } from './organizations.service';

it('uses the caller transaction for descendant expansion and keeps the ordinary read fallback', async () => {
  const rootRead = jest.fn().mockResolvedValue([{ descendantId: 'root' }]);
  const txRead = jest.fn().mockResolvedValue([{ descendantId: 'root' }, { descendantId: 'child' }]);
  const service = new OrganizationsService(
    { organizationClosure: { findMany: rootRead } } as never,
    {} as never,
    {} as never,
  );
  const tx = { organizationClosure: { findMany: txRead } };
  await expect(service.queryDescendantOrgIds('root', tx as never)).resolves.toEqual([
    'root',
    'child',
  ]);
  expect(rootRead).not.toHaveBeenCalled();
  expect(txRead).toHaveBeenCalledWith({
    where: { ancestorId: 'root' },
    select: { descendantId: true },
  });
  await expect(service.queryDescendantOrgIds('root')).resolves.toEqual(['root']);
});
