// Dump AUTHORITATIVE per-person data straight from Splitwise, no reconstruction:
//   1. Each member's NET balance within each group (group.members[].balance)
//   2. Each friend's PAIRWISE balance with me, broken down per group (get_friends -> friend.groups[])
// Pairwise per-group balance is the true "what does X owe ME in this group".
const lib = require('./splitwise-lib.js');
const { getToken, oneCurrency, resolveGroup, swApi } = lib;

async function main() {
  const token = await getToken();
  const me = (await swApi(token, 'get_current_user')).user;
  console.log(`me = ${me.first_name} (${me.id})\n`);
  const groups = (await swApi(token, 'get_groups')).groups;
  const friends = (await swApi(token, 'get_friends')).friends;

  const args = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
  const WANT = args.length ? args : Object.values(lib.eventToGroup || {});
  if (!WANT.length) {
    console.log('No groups requested and splitwise-groups.json has no eventToGroup entries.');
    console.log('Usage: node sw-pairwise.js <group name|id> [...]');
    return;
  }
  for (const want of WANT) {
    const g = resolveGroup(groups, want);
    const nm = Object.fromEntries(g.members.map(m => [m.id, m.first_name]));
    console.log(`### ${g.name} (id ${g.id})`);
    console.log('  -- group member NET balances (positive = group owes them / they are a creditor) --');
    for (const m of g.members) {
      const balance = oneCurrency(m.balance, `${m.first_name || m.id} group balance`);
      if (Math.abs(balance.amount) > 0.005) console.log(`     ${(m.first_name + '').padEnd(12)} ${balance.amount.toFixed(2)} ${balance.currency || ''}`.trimEnd());
    }
    console.log('  -- PAIRWISE with me (from get_friends; positive = they owe me) --');
    for (const f of friends) {
      const fg = (f.groups || []).find(x => x.group_id === g.id);
      if (!fg) continue;
      const balance = oneCurrency(fg.balance, `${f.first_name || f.id} pairwise balance`);
      if (Math.abs(balance.amount) > 0.005) console.log(`     ${(f.first_name + '').padEnd(12)} ${balance.amount.toFixed(2)} ${balance.currency || ''}`.trimEnd());
    }
    console.log('');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
