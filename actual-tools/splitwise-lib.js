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
const { assertSplitwiseOk, cancelResponseBody } = require('./lib/splitwise-errors');

const API = 'https://secure.splitwise.com/api/v3.0';
const TOKEN_URL = 'https://secure.splitwise.com/oauth/token';
const REQUEST_TIMEOUT_MS = Number(process.env.SPLITWISE_TIMEOUT_MS || 15_000);
const MAX_EXPENSES = Number(process.env.SPLITWISE_MAX_EXPENSES || 20_000);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastNetworkError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok) return response;
      if (response.status < 500 && response.status !== 429) return response;
      if (attempt >= attempts - 1) return response;
      await cancelResponseBody(response);
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt);
    } catch (error) {
      lastNetworkError = error.name === 'AbortError'
        ? new Error(`Splitwise request timed out after ${REQUEST_TIMEOUT_MS}ms`)
        : error;
      if (attempt < attempts - 1) await sleep(250 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastNetworkError || new Error('Splitwise request failed');
}

function resolveGroup(groups, groupNameOrId) {
  const wanted = String(groupNameOrId || '').trim().toLowerCase();
  if (!wanted) throw new Error('Splitwise group name or id required');
  const byId = groups.filter((group) => String(group.id) === wanted);
  if (byId.length === 1) return byId[0];
  const exact = groups.filter((group) => String(group.name || '').trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = groups.filter((group) => String(group.name || '').toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`multiple Splitwise groups matched "${groupNameOrId}"; use the numeric id`);
  throw new Error(`no Splitwise group matched "${groupNameOrId}"`);
}

function oneCurrency(balances, context) {
  const rows = (balances || []).filter((balance) => Math.abs(Number(balance.amount) || 0) > 0.0001);
  const currencies = [...new Set(rows.map((balance) => balance.currency_code || 'UNKNOWN'))];
  if (currencies.length > 1) throw new Error(`${context} contains multiple currencies: ${currencies.join(', ')}`);
  return {
    amount: rows.reduce((sum, balance) => sum + Number(balance.amount), 0),
    currency: currencies[0] || null,
  };
}

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
  const r = await fetchWithRetry(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  await assertSplitwiseOk(r, { endpoint: 'oauth/token', method: 'POST' });
  const token = (await r.json()).access_token;
  if (!token) throw new Error('Splitwise token response did not include an access token');
  return token;
}

async function swApi(token, endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetchWithRetry(`${API}/${endpoint}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${token}` } });
  await assertSplitwiseOk(r, { endpoint, method: 'GET' });
  return r.json();
}

let _cachedGroups = null;
let _cachedCurrentUser = null;
async function getGroupDebts(groupNameOrId) {
  const token = await getToken();
  const me = _cachedCurrentUser || ((_cachedCurrentUser = (await swApi(token, 'get_current_user')).user));
  const myId = me.id;
  if (!_cachedGroups) _cachedGroups = (await swApi(token, 'get_groups')).groups;
  const g = resolveGroup(_cachedGroups, groupNameOrId);
  const names = Object.fromEntries((g.members || []).map(m => [m.id, `${m.first_name || ''} ${m.last_name || ''}`.trim()]));
  const myBalance = oneCurrency((g.members.find(m => m.id === myId) || {}).balance, `group ${g.name} balance`);
  const sd = g.simplified_debts || [];
  const debtCurrencies = [...new Set(sd.map((debt) => debt.currency_code || myBalance.currency || 'UNKNOWN'))];
  if (debtCurrencies.length > 1) throw new Error(`group ${g.name} simplified debts contain multiple currencies`);
  const currency = debtCurrencies[0] || myBalance.currency;
  const owedToMe = sd.filter(x => x.to === myId).map(x => ({ name: names[x.from] || String(x.from), slug: slugForName(names[x.from]), amount: Number(x.amount), currency }));
  const iOwe = sd.filter(x => x.from === myId).map(x => ({ name: names[x.to] || String(x.to), slug: slugForName(names[x.to]), amount: Number(x.amount), currency }));
  return { id: g.id, name: g.name, myBalance: myBalance.amount, currency, owedToMe, iOwe };
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
  const g = resolveGroup(_cachedGroups, groupNameOrId);
  const me = _cachedCurrentUser || ((_cachedCurrentUser = (await swApi(token, 'get_current_user')).user));
  if (!_cachedFriends) _cachedFriends = (await swApi(token, 'get_friends')).friends;
  const friendIds = new Set(_cachedFriends.map((friend) => String(friend.id)));
  const missingMembers = (g.members || []).filter((member) => String(member.id) !== String(me.id) && !friendIds.has(String(member.id)));
  if (missingMembers.length) {
    throw new Error(`get_friends omitted ${missingMembers.length} member(s) from group ${g.name}; pairwise snapshot is incomplete`);
  }

  const owedToMe = [], iOweThem = [];
  let total = 0, oweTotal = 0, currency = null;
  for (const f of _cachedFriends) {
    const fg = (f.groups || []).find(x => x.group_id === g.id);
    if (!fg) continue;
    const pair = oneCurrency(fg.balance, `${f.first_name || f.id} balance in ${g.name}`);
    if (pair.currency && currency && pair.currency !== currency) throw new Error(`group ${g.name} pairwise balances contain multiple currencies`);
    currency = currency || pair.currency;
    const bal = +pair.amount.toFixed(2);
    const name = `${f.first_name || ''} ${f.last_name || ''}`.trim();
    if (bal > 0.005) { owedToMe.push({ name, slug: slugForName(name), amount: bal, currency }); total += bal; }
    else if (bal < -0.005) { iOweThem.push({ name, slug: slugForName(name), amount: -bal, currency }); oweTotal += -bal; }
  }
  owedToMe.sort((a, b) => b.amount - a.amount);
  iOweThem.sort((a, b) => b.amount - a.amount);
  return { id: g.id, name: g.name, currency, owedToMe, iOweThem, total: +total.toFixed(2), oweTotal: +oweTotal.toFixed(2), multiPayer: 0 };
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
  const me = _cachedCurrentUser || ((_cachedCurrentUser = (await swApi(token, 'get_current_user')).user));
  const myId = me.id;
  if (!_cachedGroups) _cachedGroups = (await swApi(token, 'get_groups')).groups;
  const g = resolveGroup(_cachedGroups, groupNameOrId);
  const memberName = {};
  for (const m of g.members || []) memberName[m.id] = `${m.first_name || ''} ${m.last_name || ''}`.trim();

  // Pull every expense in the group (paginate; get_expenses defaults to 20).
  const all = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const page = (await swApi(token, 'get_expenses', { group_id: g.id, limit: pageSize, offset })).expenses || [];
    all.push(...page);
    if (page.length < pageSize) break;
    if (all.length >= MAX_EXPENSES) throw new Error(`group ${g.name} exceeds the ${MAX_EXPENSES}-expense safety limit`);
  }

  const uidOf = (u) => u.user_id || (u.user && u.user.id);
  const nameOf = (u) => {
    const id = uidOf(u);
    if (memberName[id]) return memberName[id];
    return u.user ? `${u.user.first_name || ''} ${u.user.last_name || ''}`.trim() : String(id);
  };

  const owedToMe = {}, iOwe = {}, perItems = {}, personNames = {};
  const mySpendItems = [];
  let liveCount = 0;
  let currency = null;
  for (const e of all) {
    if (e.deleted_at) continue;
    const expenseCurrency = e.currency_code || null;
    if (expenseCurrency && currency && expenseCurrency !== currency) {
      throw new Error(`group ${g.name} expenses contain multiple currencies`);
    }
    currency = currency || expenseCurrency;
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
        currency: expenseCurrency,
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
        const personName = nameOf(d);
        const slug = (slugForName(personName) || String(did)).toLowerCase();
        if (personNames[slug] && personNames[slug] !== personName) throw new Error(`person slug collision for ${slug}`);
        personNames[slug] = personName;
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
        const personName = nameOf(c);
        const slug = (slugForName(personName) || String(cid)).toLowerCase();
        if (personNames[slug] && personNames[slug] !== personName) throw new Error(`person slug collision for ${slug}`);
        personNames[slug] = personName;
        iOwe[slug] = (iOwe[slug] || 0) + amt;
        (perItems[slug] = perItems[slug] || []).push({ id: String(e.id), date: (e.date || '').slice(0, 10), desc: e.description || '', amount: -(+amt.toFixed(2)), kind: isSettle ? 'settle' : 'expense' });
      }
    }
  }

  const perPerson = {};
  for (const slug of new Set([...Object.keys(owedToMe), ...Object.keys(iOwe)])) {
    const o = +(owedToMe[slug] || 0).toFixed(2);
    const i = +(iOwe[slug] || 0).toFixed(2);
    perPerson[slug] = { name: personNames[slug] || slug, owedToMe: o, iOwe: i, net: +(o - i).toFixed(2), items: (perItems[slug] || []).sort((a, b) => (a.date < b.date ? 1 : -1)) };
  }
  return { id: g.id, name: g.name, myId, currency, perPerson, mySpendItems, expenseCount: liveCount };
}

module.exports = {
  getGroupDebts,
  getDirectOwed,
  getItemizedOwed,
  getToken,
  swApi,
  eventToGroup,
  fetchWithRetry,
  oneCurrency,
  resolveGroup,
  slugForName,
};
