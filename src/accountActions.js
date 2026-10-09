const Account = require("./models/Account");
const LoginJob = require("./models/LoginJob");
const { cancelOwnerLoginJobs, loginControl } = require("./loginQueue");

async function deleteSavedAccounts(owner, accountIds) {
  const ownerId = String(owner);
  if (!ownerId || !Array.isArray(accountIds) || !accountIds.length) return 0;
  await cancelOwnerLoginJobs(ownerId);

  return loginControl.stop(ownerId, async () => {
    const filter = { owner: ownerId, _id: { $in: accountIds } };
    const result = await Account.deleteMany(filter).exec();
    await LoginJob.deleteMany({ owner: ownerId, accountId: { $in: accountIds } }).exec();
    return result.deletedCount;
  });
}

module.exports = { deleteSavedAccounts };
