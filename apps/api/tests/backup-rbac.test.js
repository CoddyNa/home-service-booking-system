const { requireRoles } = require('../src/middleware/role');

describe('backup administrator role guard', () => {
  test.each(['customer', 'provider', 'support_agent', 'staff', 'auditor'])('%s cannot pass the admin-only backup route guard', (role) => {
    const req = { session: { userId: 12, role }, originalUrl: '/api/admin/backups' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireRoles('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: insufficient role' });
    expect(next).not.toHaveBeenCalled();
  });

  test('admin is allowed through the backup route guard', () => {
    const next = jest.fn();
    requireRoles('admin')({ session: { userId: 1, role: 'admin' } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
