'use strict';

const STEP = 1000;
const MAX_MILESTONES = 10000;
const SUBSCRIPTION = /^projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,30})\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/;

function validBudgetId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour < 24 && minute < 60 && second < 60;
}

/** Pure reducer. The budget ID supplied by the transport comes from Pub/Sub attributes. */
function applyBillingMessage(previous = {}, payload, { budgetId, currency = 'JPY' } = {}) {
  if (!validBudgetId(budgetId) || currency !== 'JPY') throw new Error('料金通知の設定が不正です。');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.budgetId !== budgetId || payload.currencyCode !== currency
      || typeof payload.costAmount !== 'number' || !Number.isFinite(payload.costAmount)
      || payload.costAmount < 0) throw new Error('料金通知の対象・通貨・金額が不正です。');
  const start = payload.costIntervalStart;
  if (!validTimestamp(start)) throw new Error('料金通知の期間が不正です。');
  if (payload.receivedAt != null && !validTimestamp(payload.receivedAt)) throw new Error('料金通知の受信日時が不正です。');
  const period = new Date(start).toISOString();
  const count = Math.floor(payload.costAmount / STEP);
  // Refuse unreasonable input rather than silently losing individual milestone records.
  if (count > MAX_MILESTONES) throw new Error('料金通知の金額が処理範囲を超えています。');
  if (previous?.budgetId && (previous.budgetId !== budgetId || previous.currency !== currency)) {
    throw new Error('料金通知の保存台帳と設定が一致しません。');
  }
  const state = structuredClone(previous || {});
  state.budgetId = budgetId;
  state.currency = currency;
  state.periods ||= {};
  state.history ||= [];
  // Preserve the active ledger when reading a state saved before the periods map existed.
  if (state.period && !state.periods[state.period]) {
    state.periods[state.period] = { cost: state.cost || 0, notifiedMilestones: state.notifiedMilestones || [] };
  }
  const ledger = state.periods[period] ||= { cost: 0, notifiedMilestones: [] };
  const notified = new Set(ledger.notifiedMilestones);
  const milestones = [];
  for (let i = 1; i <= count; i++) {
    const amount = i * STEP;
    if (!notified.has(amount)) {
      notified.add(amount);
      milestones.push(amount);
      state.history.push({ kind: 'cloud-billing', budgetId, period, currency, amount,
        cost: payload.costAmount, receivedAt: payload.receivedAt || null });
    }
  }
  ledger.notifiedMilestones = [...notified].sort((a, b) => a - b);
  // Publish time distinguishes out-of-order delivery from a later billing correction.
  const publishedAt = payload.publishedAt;
  if (publishedAt != null && !validTimestamp(publishedAt)) {
    throw new Error('料金通知の発行日時が不正です。');
  }
  if (!ledger.publishedAt || !publishedAt || Date.parse(publishedAt) >= Date.parse(ledger.publishedAt)) {
    ledger.cost = payload.costAmount;
    ledger.receivedAt = payload.receivedAt || null;
    if (publishedAt) ledger.publishedAt = publishedAt;
  }
  if (!state.period || Date.parse(period) >= Date.parse(state.period)) {
    state.period = period;
    state.cost = ledger.cost;
    state.receivedAt = ledger.receivedAt;
    state.notifiedMilestones = [...ledger.notifiedMilestones];
  }
  const notifications = milestones.length ? [{ kind: 'cloud-billing', budgetId, period, currency,
    cost: payload.costAmount, milestones, title: 'Cloud Billing 利用料金',
    body: `${period.slice(0, 7)}の利用料金が${milestones.length > 3
      ? `${milestones[0].toLocaleString('ja-JP')}～${milestones.at(-1).toLocaleString('ja-JP')}円（${milestones.length}件）`
      : milestones.map(n => n.toLocaleString('ja-JP') + '円').join('・')}に到達しました。請求確定額・税とは異なります。` }] : [];
  return { state, notifications };
}

class BillingMonitor {
  constructor({ subscription, budgetId, getToken, loadState, saveState, onUpdate = () => {},
    onNotify = () => {}, fetchImpl = globalThis.fetch }) {
    if (typeof subscription !== 'string' || !SUBSCRIPTION.test(subscription)
        || subscription.split('/')[3].toLowerCase().startsWith('goog') || !validBudgetId(budgetId)) {
      throw new Error('料金通知のサブスクリプションまたは予算IDが不正です。');
    }
    for (const fn of [getToken, loadState, saveState, onUpdate, onNotify, fetchImpl]) {
      if (typeof fn !== 'function') throw new Error('料金通知の処理設定が不正です。');
    }
    Object.assign(this, { subscription, budgetId, getToken, loadState, saveState, onUpdate, onNotify, fetchImpl });
    this.inflight = null;
  }

  poll() {
    if (!this.inflight) this.inflight = this.pull().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async request(action, body, token) {
    let response;
    try {
      const resource = this.subscription.split('/').map(encodeURIComponent).join('/');
      response = await this.fetchImpl(`https://pubsub.googleapis.com/v1/${resource}:${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
      });
    } catch { throw new Error('料金通知サービスに接続できませんでした。'); }
    if (!response.ok) throw new Error('料金通知サービスの認証または受信に失敗しました。');
    return response;
  }

  async pull() {
    let token;
    try { token = await this.getToken(); } catch { throw new Error('料金通知の認証に失敗しました。'); }
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('料金通知の認証に失敗しました。');
    const response = await this.request('pull', { maxMessages: 10 }, token);
    let result;
    try { result = await response.json(); } catch { throw new Error('料金通知の受信形式が不正です。'); }
    const received = result.receivedMessages || [];
    if (!Array.isArray(received) || received.length > 10) throw new Error('料金通知の受信形式が不正です。');
    let state = await this.loadState() || {};
    let processed = 0;
    for (const envelope of received) {
      let payload;
      try {
        const encoded = envelope.message.data;
        if (typeof envelope.ackId !== 'string' || !envelope.ackId || envelope.ackId.length > 4096
            || typeof encoded !== 'string' || encoded.length > 65536
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error();
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64')));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
        payload.budgetId = envelope.message.attributes?.budgetId;
        payload.publishedAt = envelope.message.publishTime;
        payload.receivedAt = new Date().toISOString();
      } catch { throw new Error('料金通知の受信形式が不正です。'); }
      const update = applyBillingMessage(state, payload, { budgetId: this.budgetId, currency: 'JPY' });
      // Durably store every milestone BEFORE acknowledging or presenting notifications.
      try { await this.saveState(update.state); } catch { throw new Error('料金通知の履歴を保存できませんでした。再受信します。'); }
      state = update.state;
      await this.onUpdate(structuredClone(state));
      for (const notification of update.notifications) await this.onNotify(notification);
      await this.request('acknowledge', { ackIds: [envelope.ackId] }, token);
      processed++;
    }
    return { state, processed };
  }
}

module.exports = { BillingMonitor, applyBillingMessage };
