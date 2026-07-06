// splitwise-lib.js — shared READ-ONLY helpers for Splitwise authoritative balances.
// Auth: mints a bearer token from SPLITWISE_CONSUMER_KEY/SECRET (client_credentials),
//       or uses SPLITWISE_API_KEY if set. No writes, ever.
//
// Exposes:
//   getGroupDebts(groupNameOrId) -> { id, name, myBalance, owedToMe:[{name,slug,amount}], iOwe:[...] }
//   eventToGroup  — maps a CONTEXT #ev-<slug> to its Splitwise group name
//   slugForName(fullName) -> person slug (best-effort)
//
// All amounts are returned as NUMBERS in dollars (Splitwise native), matching simplified_debts.

const fs = require('fs');
const path = require('path');

const API = 'https://secure.splitwise.com/api/v3.0';
const TOKEN_URL = 'https://secure.splitwise.com/oauth/token';

// Your #ev-<slug> -> Splitwise group names and surname aliases live OUTSIDE the code
// so this repo can be open-sourced. Real values go in splitwise-groups.json
// (gitignored); see splitwise-groups.example.json. Absent => harmless empty maps.
const _cfg = (() => {
  try {
    const p = process.env.SPLITWISE_GROUPS_PATH || path.join(__dirname, 'splitwise-groups.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) { return {}; }
})();

// #ev-<slug>  ->  Splitwise group name (substring match, case-insensitive)
const eventToGroup = _cfg.eventToGroup && typeof _cfg.eventToGroup === 'object' ? _cfg.eventToGroup : {};

// Surname/alias -> slug (first-name match is tried first in slugForName)
const SURNAME = Array.isArray(_cfg.surname) ? _cfg.surname : [];

function slugForName(fullName) {
  const low = String(fullName || '').trim().toLowerCase();
  if (!low) return null;
  const first = low.split(/\s+/)[0];
  // first name is usually the slug (alex, sam, jordan, ...)
  if (/^[a-z]+$/.test(first)) {
    for (const [sub, slug] of SURNAME) if (low.includes(sub)) return slug;
    return first;
  }
  for (const [sub, slug] of SURNAME) if (low.includes(sub)) return slug;
  return first || null;
}

async function getToken() {
  if (process.env.SPLITWISE_API_KEY) return process.env.SPLITWISE_API_KEY;
  const key = process.env.SPLITWISE_CONSUMER_KEY, secret = process.env.SPLITWISE_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('Missing SPLITWISE_API_KEY or SPLITWISE_CONSUMER_KEY/SECRET');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: key, client_secret: secret });
  const r = await fetch(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw new Error(`token failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function swApi(token, endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API}/${endpoint}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${endpoint} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

let _cachedGroups = null;
async function getGroupDebts(groupNameOrId) {
  const token = await getToken();
  const me = (await swApi(token, 'get_current_user')).user;
  const myId = me.id;
  if (!_cachedGroups) _cachedGroups = (await swApi(token, 'get_groups')).groups;
  const gf = String(groupNameOrId).toLowerCase();
  const g = _cachedGroups.find(x => String(x.id) === gf || (x.name || '').toLowerCase().includes(gf));
  if (!g) throw new Error(`no Splitwise group matched "${groupNameOrId}"`);
  const names = Object.fromEntries((g.members || []).map(m => [m.id, `${m.first_name || ''} ${m.last_name || ''}`.trim()]));
  const myBalance = ((g.members.find(m => m.id === myId) || {}).balance || [])
    .reduce((s, b) => s + Number(b.amount), 0);
  const sd = g.simplified_debts || [];
  const owedToMe = sd.filter(x => x.to === myId).map(x => ({ name: names[x.from] || String(x.from), slug: slugForName(names[x.from]), amount: Number(x.amount) }));
  const iOwe = sd.filter(x => x.from === myId).map(x => ({ name: names[x.to] || String(x.to), slug: slugForName(names[x.to]), amount: Number(x.amount) }));
  return { id: g.id, name: g.name, myBalance, owedToMe, iOwe };
}

// Direct pairwise = the TRUE "who owes ME", read straight from Splitwise's own per-friend,
// per-group balance (get_friends -> friend.groups[].balance). This is authoritative and needs
// NO reconstruction (positive = they owe me, negative = I owe them). Do NOT recompute this from
// line items — that produced phantom debts (see CONTEXT §8, 2026-06-29 pairwise-recon lesson).
// Returns { id, name, owedToMe:[{name,slug,amount}], iOweThem:[...], total, oweTotal }.
let _cachedFriends = null;
async function getDirectOwed(groupNameOrId) {
  const token = await getToken();
  if (!_cachedGroups) _cachedGroups = (await swApi(token, 'get_groups')).groups;
  const gf = String(groupNameOrId).toLowerCase();
  const g = _cachedGroups.find(x => String(x.id) === gf || (x.name || '').toLowerCase().includes(gf));
  if (!g) throw new Error(`no Splitwise group matched "${groupNameOrId}"`);
  if (!_cachedFriends) _cachedFriends = (await swApi(token, 'get_friends')).friends;

  const owedToMe = [], iOweThem = [];
  let total = 0, oweTotal = 0;
  for (const f of _cachedFriends) {
    const fg = (f.groups || []).find(x => x.group_id === g.id);
    if (!fg) continue;
    const bal = +(((fg.balance || []).reduce((s, b) => s + Number(b.amount), 0))).toFixed(2);
    const name = `${f.first_name || ''} ${f.last_name || ''}`.trim();
    if (bal > 0.005) { owedToMe.push({ name, slug: slugForName(name), amount: bal }); total += bal; }
    else if (bal < -0.005) { iOweThem.push({ name, slug: slugForName(name), amount: -bal }); oweTotal += -bal; }
  }
  owedToMe.sort((a, b) => b.amount - a.amount);
  iOweThem.sort((a, b) => b.amount - a.amount);
  return { id: g.id, name: g.name, owedToMe, iOweThem, total: +total.toFixed(2), oweTotal: +oweTotal.toFixed(2), multiPayer: 0 };
}

// Itemized per-expense metadata — reads Splitwise's per-expense `net_balance`
// (paid_share - owed_share) for every member, so it captures:
//   • group members who aren't my "friend" (get_friends can omit them)
//   • partial splits that don't involve everyone (only listed users participate)
//   • settle-ups (payment:true) which net balances down
//   • my own share of every expense (for spend accounting)
// This is useful for itemization and spend mirroring, but it is NOT the
// authoritative "who owes me" number. For per-person debts use getDirectOwed(),
// which reads Splitwise's pairwise friend/group balances. Returns:
//   { id, name, myId, perPerson:{slug:{name,owedToMe,iOwe,net,items:[...]}},
//     mySpendItems:[{id,date,desc,category,myShare,paidByMe,payer}], expenseCount }
const num = (x) => Number(x || 0);
async function getItemizedOwed(groupNameOrId) {
  const token = await getToken();
  const me = (await swApi(token, 'get_current_user')).user;
  const myId = me.id;
  if (!_cachedGroups) _cachedGroups = (await swApi(token, 'get_groups')).groups;
  const gf = String(groupNameOrId).toLowerCase();
  const g = _cachedGroups.find((x) => String(x.id) === gf || (x.name || '').toLowerCase().includes(gf));
  if (!g) throw new Error(`no Splitwise group matched "${groupNameOrId}"`);
  const memberName = {};
  for (const m of g.members || []) memberName[m.id] = `${m.first_name || ''} ${m.last_name || ''}`.trim();

  // Pull every expense in the group (paginate; get_expenses defaults to 20).
  const all = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const page = (await swApi(token, 'get_expenses', { group_id: g.id, limit: pageSize, offset })).expenses || [];
    all.push(...page);
    if (page.length < pageSize) break;
    if (offset > 5000) break; // hard stop
  }

  const uidOf = (u) => u.user_id || (u.user && u.user.id);
  const nameOf = (u) => {
    const id = uidOf(u);
    if (memberName[id]) return memberName[id];
    return u.user ? `${u.user.first_name || ''} ${u.user.last_name || ''}`.trim() : String(id);
  };

  const owedToMe = {}, iOwe = {}, perItems = {};
  const mySpendItems = [];
  let liveCount = 0;
  for (const e of all) {
    if (e.deleted_at) continue;
    liveCount++;
    const users = e.users || [];
    const meU = users.find((u) => uidOf(u) === myId);
    // A settle-up nets balances but is NOT consumption. Splitwise's own settle-ups
    // set payment:true, but users also log manual "Settle all balances" rows with
    // payment:false — catch those by description so they never become fake spend.
    const isPayment = !!e.payment;
    const isSettle = isPayment || /settle|^payment$|reimburs|paid\s+back/i.test(e.description || '');
    const myShare = meU ? num(meU.owed_share) : 0;
    const iPaid = meU ? num(meU.paid_share) > 0.005 : false;
    const creditors = users.filter((u) => num(u.net_balance) > 0.005);
    const debtors = users.filter((u) => num(u.net_balance) < -0.005);
    const totalCred = creditors.reduce((s, u) => s + num(u.net_balance), 0) || 1;
    const mainPayer = creditors.slice().sort((a, b) => num(b.net_balance) - num(a.net_balance))[0];

    // My consumption for spend accounting (settle-ups aren't spend).
    if (!isSettle && myShare > 0.005) {
      mySpendItems.push({
        id: String(e.id), date: (e.date || '').slice(0, 10), desc: e.description || '',
        category: (e.category && e.category.name) || null, cost: num(e.cost),
        myShare: +myShare.toFixed(2), paidByMe: iPaid,
        payer: mainPayer ? nameOf(mainPayer) : (iPaid ? me.first_name : null),
      });
    }

    const myNet = meU ? num(meU.net_balance) : 0;
    if (myNet > 0.005) {
      // I'm a creditor on this expense — split my receivable across its debtors.
      for (const d of debtors) {
        const did = uidOf(d);
        if (did === myId) continue;
        const amt = -num(d.net_balance) * (myNet / totalCred);
        if (amt <= 0.005) continue;
        const slug = (slugForName(nameOf(d)) || String(did)).toLowerCase();
        owedToMe[slug] = (owedToMe[slug] || 0) + amt;
        (perItems[slug] = perItems[slug] || []).push({ id: String(e.id), date: (e.date || '').slice(0, 10), desc: e.description || '', amount: +amt.toFixed(2), kind: isSettle ? 'settle' : 'expense' });
      }
    } else if (myNet < -0.005) {
      // I'm a debtor — I owe each creditor their proportional slice.
      for (const c of creditors) {
        const cid = uidOf(c);
        if (cid === myId) continue;
        const amt = -myNet * (num(c.net_balance) / totalCred);
        if (amt <= 0.005) continue;
        const slug = (slugForName(nameOf(c)) || String(cid)).toLowerCase();
        iOwe[slug] = (iOwe[slug] || 0) + amt;
        (perItems[slug] = perItems[slug] || []).push({ id: String(e.id), date: (e.date || '').slice(0, 10), desc: e.description || '', amount: -(+amt.toFixed(2)), kind: isSettle ? 'settle' : 'expense' });
      }
    }
  }

  const perPerson = {};
  for (const slug of new Set([...Object.keys(owedToMe), ...Object.keys(iOwe)])) {
    const o = +(owedToMe[slug] || 0).toFixed(2);
    const i = +(iOwe[slug] || 0).toFixed(2);
    perPerson[slug] = { name: slug, owedToMe: o, iOwe: i, net: +(o - i).toFixed(2), items: (perItems[slug] || []).sort((a, b) => (a.date < b.date ? 1 : -1)) };
  }
  return { id: g.id, name: g.name, myId, perPerson, mySpendItems, expenseCount: liveCount };
}

module.exports = { getGroupDebts, getDirectOwed, getItemizedOwed, eventToGroup, slugForName };
