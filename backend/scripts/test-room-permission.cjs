const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DataSource } = require('typeorm');
const { SystemSettings } = require('../dist/entities/SystemSettings');
const data = require('../dist/data-source');
const { roomPermissionService: permission } = require('../dist/modules/room/room-permission.service');

test('configured viewer permissions are read through real TypeORM, including explicit denial', async () => {
  const db = new DataSource({ type: 'sqljs', entities: [SystemSettings], synchronize: true });
  await db.initialize();
  const original = data.AppDataSource;
  data.AppDataSource = db;
  permission.isRoomHost = async () => false;
  permission.isRoomModerator = async () => false;
  try {
    const repo = db.getRepository(SystemSettings);
    const settings = await repo.save(repo.create({ roomPermissionMatrix: { manageMovie: { user: true, admin: false } } }));
    assert.equal(await permission.canViewerPerform({ data: { role: 'user' } }, 'fixture', 'manageMovie'), true);
    assert.equal(await permission.canViewerPerform({ data: { role: 'user' } }, 'fixture', 'kickViewer'), false);
    assert.equal(await permission.canViewerPerform({ data: { role: 'admin' } }, 'fixture', 'manageMovie'), false);
    assert.equal(await permission.canViewerPerform({ data: { role: 'guest' } }, 'fixture', 'manageMovie'), false);
    settings.roomPermissionMatrix = { manageMovie: { user: false } };
    await repo.save(settings);
    assert.equal(await permission.canViewerPerform({ data: { role: 'user' } }, 'fixture', 'manageMovie'), false);
  } finally { data.AppDataSource = original; await db.destroy(); }
});
