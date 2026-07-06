// Dump AUTHORITATIVE per-person data straight from Splitwise, no reconstruction:
//   1. Each member's NET balance within each group (group.members[].balance)
//   2. Each friend's PAIRWISE balance with me, broken down per group (get_friends -> friend.groups[])
// Pairwise per-group balance is the true "what does X owe ME in this group".
const lib = require('./splitwise-lib.js');

async function main() {
  // reuse the private helpers via a tiny re-impl using the same token path
  const API = 'https://secure.splitwise.com/api/v3.0';
  const TOKEN_URL = 'https://secure.splitwise.com/oauth/token';
  async function getToken() {
    if (process.env.SPLITWISE_API_KEY) return process.env.SPLITWISE_API_KEY;
    const key = process.env.SPLITWISE_CONSUMER_KEY, secret = process.env.SPLITWISE_CONSUMER_SECRET;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: key, client_secret: secret });
    const r = await fetch(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return (await r.json()).access_token;
  }
  async function api(token, ep, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${API}/${ep}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${ep}: ${r.status} ${await r.text()}`);
    return r.json();
  }

  const token = await getToken();
  const me = (await api(token, 'get_current_user')).user;
  console.log(`me = ${me.first_name} (${me.id})\n`);
  const groups = (await api(token, 'get_groups')).groups;
  const friends = (await api(token, 'get_friends')).friends;

  const args = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
  const WANT = args.length ? args : Object.values(lib.eventToGroup || {});
  if (!WANT.length) {
    console.log('No groups requested and splitwise-groups.json has no eventToGroup entries.');
    console.log('Usage: node sw-pairwise.js <group name|id> [...]');
    return;
  }
  for (const want of WANT) {
    const g = groups.find(x => (x.name || '').toLowerCase().includes(want));
    if (!g) { console.log(`### ${want}: NOT FOUND\n`); continue; }
    const nm = Object.fromEntries(g.members.map(m => [m.id, m.first_name]));
    console.log(`### ${g.name} (id ${g.id})`);
    console.log('  -- group member NET balances (positive = group owes them / they are a creditor) --');
    for (const m of g.members) {
      const bal = (m.balance || []).reduce((s, b) => s + Number(b.amount), 0);
      if (Math.abs(bal) > 0.005) console.log(`     ${(m.first_name + '').padEnd(12)} ${bal.toFixed(2)}`);
    }
    console.log('  -- PAIRWISE with me (from get_friends; positive = they owe me) --');
    for (const f of friends) {
      const fg = (f.groups || []).find(x => x.group_id === g.id);
      if (!fg) continue;
      const bal = (fg.balance || []).reduce((s, b) => s + Number(b.amount), 0);
      if (Math.abs(bal) > 0.005) console.log(`     ${(f.first_name + '').padEnd(12)} ${bal.toFixed(2)}`);
    }
    console.log('');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
