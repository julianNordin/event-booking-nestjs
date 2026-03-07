import { disconnectTestPrisma, testPrisma } from './prisma';
import { truncateAll } from './truncate';

// Before, not after. A test that fails mid-way leaves rows behind, and cleaning
// up afterwards means the *next* failure is caused by the previous one — the
// worst kind of test suite to debug. Cleaning beforehand also leaves the
// database populated when a test fails, which is exactly when you want to look
// at it.
beforeEach(async () => {
  await truncateAll(testPrisma());
});

afterAll(async () => {
  await disconnectTestPrisma();
});
