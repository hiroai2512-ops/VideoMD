'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BillingMonitor, applyBillingMessage } = require('../src/billing.cjs');
const config = { budgetId: 'test-budget', currency: 'JPY' };
const month = '2026-10-01T07:00:00Z';
function payload(costAmount, overrides = {}) {
  return { budgetId: config.budgetId, currencyCode: 'JPY', costAmount, costIntervalStart: month, ...overrides };
}
function apply(state, cost, overrides) { return applyBillingMessage(state, payload(cost, overrides), config); }

test('999円では通知せず、1000円で一度、3100円ですべての未到達額を記録する', () => {
  const zero = {};
  const first = apply(zero, 999);
  assert.deepEqual(zero, {});
  assert.equal(first.notifications.length, 0);
  const second = apply(first.state, 1000);
  assert.deepEqual(second.notifications[0].milestones, [1000]);
  const third = apply(second.state, 3100);
  assert.deepEqual(third.notifications[0].milestones, [2000, 3000]);
  assert.deepEqual(third.state.history.map(n => n.amount), [1000, 2000, 3000]);
  assert.equal(second.state.history.length, 1);
});

test('重複・順序逆転・料金訂正・再起動で到達を重複通知しない', () => {
  let state = apply({}, 3100, { publishedAt: '2026-10-03T00:00:00Z' }).state;
  assert.equal(apply(state, 3100).notifications.length, 0);
  const older = apply(state, 1000, { publishedAt: '2026-10-02T00:00:00Z' });
  assert.equal(older.state.cost, 3100);
  assert.equal(older.notifications.length, 0);
  state = apply(older.state, 900, { publishedAt: '2026-10-04T00:00:00Z' }).state;
  assert.equal(state.cost, 900);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(apply(state, 3100).notifications.length, 0);
  assert.deepEqual(apply(state, 4100).notifications[0].milestones, [4000]);
});

test('月替わりで別台帳となり、旧月再送で表示月が巻き戻らない', () => {
  const october = apply({}, 1000).state;
  const november = apply(october, 1000, { costIntervalStart: '2026-11-01T07:00:00Z' });
  assert.deepEqual(november.notifications[0].milestones, [1000]);
  const old = apply(november.state, 1000);
  assert.equal(old.notifications.length, 0);
  assert.equal(old.state.period, '2026-11-01T07:00:00.000Z');
  const late = apply(old.state, 2000);
  assert.equal(late.state.cost, 1000);
  assert.deepEqual(late.notifications[0].milestones, [2000]);
  assert.equal(Object.keys(late.state.periods).length, 2);
});

test('通貨・budget ID・非有限/負値/異常巨大額・期間を検証する', () => {
  for (const override of [{ currencyCode: 'USD' }, { budgetId: 'other' }, { costAmount: NaN },
    { costAmount: Infinity }, { costAmount: -1 }, { costAmount: '1000' },
    { costAmount: 1e100 }, { costIntervalStart: 'yesterday' }, { costIntervalStart: null },
    { costIntervalStart: '2026-02-30T07:00:00Z' }, { costIntervalStart: '2026-10-01T24:00:00Z' },
    { publishedAt: 'yesterday' }, { receivedAt: { secret: 'bad' } }]) {
    assert.throws(() => applyBillingMessage({}, payload(1000, override), config));
  }
  assert.throws(() => applyBillingMessage({}, null, config));
  assert.throws(() => applyBillingMessage({}, payload(1000), { ...config, currency: 'USD' }));
  assert.throws(() => applyBillingMessage({ budgetId: 'other', currency: 'JPY' }, payload(1000), config));
});

function envelope(cost = 1000) {
  const data = payload(cost); delete data.budgetId;
  return { ackId: 'ack-test', message: { data: Buffer.from(JSON.stringify(data)).toString('base64'),
    attributes: { budgetId: config.budgetId }, publishTime: '2026-10-03T00:00:00.123456789Z' } };
}
function monitorHarness({ messages = [envelope()], failSave = false, failAck = false } = {}) {
  const calls = []; let saved = {};
  const options = {
    subscription: 'projects/example-project/subscriptions/billing-notices', budgetId: config.budgetId,
    getToken: async () => 'private-token', loadState: async () => structuredClone(saved),
    saveState: async state => { calls.push('save'); if (failSave) throw new Error(); saved = structuredClone(state); },
    onUpdate: state => { calls.push('update'); assert.equal(state.history.length, saved.history.length); },
    onNotify: notice => { calls.push('notify'); assert.equal(notice.kind, 'cloud-billing'); },
    fetchImpl: async (url, request) => {
      assert.equal(request.headers.Authorization, 'Bearer private-token');
      assert.equal(request.method, 'POST');
      if (url.endsWith(':pull')) {
        calls.push('pull'); assert.deepEqual(JSON.parse(request.body), { maxMessages: 10 });
        return { ok: true, json: async () => ({ receivedMessages: messages }) };
      }
      calls.push('ack'); assert.deepEqual(JSON.parse(request.body), { ackIds: ['ack-test'] });
      return { ok: !failAck };
    }
  };
  return { monitor: new BillingMonitor(options), options, calls, getSaved: () => saved };
}

test('正式attributes・base64 JSONを処理し、保存と通知後にackする', async () => {
  const h = monitorHarness();
  const result = await h.monitor.poll();
  assert.equal(result.processed, 1);
  assert.deepEqual(h.calls, ['pull', 'save', 'update', 'notify', 'ack']);
  assert.ok(!JSON.stringify(h.getSaved()).includes('private-token'));
  await h.monitor.poll();
  assert.equal(h.calls.filter(n => n === 'notify').length, 1);
});

test('保存失敗時にack・通知をしない', async () => {
  const h = monitorHarness({ failSave: true });
  await assert.rejects(h.monitor.poll(), /保存/);
  assert.deepEqual(h.calls, ['pull', 'save']);
});

test('ack失敗・再送でも到達通知を二重表示しない', async () => {
  const h = monitorHarness({ failAck: true });
  await assert.rejects(h.monitor.poll());
  await assert.rejects(h.monitor.poll());
  assert.equal(h.calls.filter(n => n === 'notify').length, 1);
  assert.equal(h.getSaved().history.length, 1);
});

test('不正JSON/base64/UTF8/属性・通貨をackしない', async () => {
  for (const data of ['!!!!', Buffer.from('{oops').toString('base64'), Buffer.from([0xff]).toString('base64')]) {
    const bad = envelope(); bad.message.data = data;
    const h = monitorHarness({ messages: [bad] });
    await assert.rejects(h.monitor.poll()); assert.deepEqual(h.calls, ['pull']);
  }
  const wrong = envelope(); wrong.message.attributes.budgetId = 'other';
  const h = monitorHarness({ messages: [wrong] });
  await assert.rejects(h.monitor.poll()); assert.deepEqual(h.calls, ['pull']);
});

test('空レスポンスと重複pollを扱い、認証エラーで秘密を公開しない', async () => {
  const h = monitorHarness({ messages: [] });
  const first = h.monitor.poll();
  assert.equal(first, h.monitor.poll());
  assert.equal((await first).processed, 0);
  const failed = new BillingMonitor({ ...h.options, getToken: async () => { throw new Error('private-token'); } });
  await assert.rejects(failed.poll(), error => !error.message.includes('private-token'));
});

test('サブスクリプションパスを厳密に検証する', () => {
  const h = monitorHarness();
  for (const subscription of ['https://evil.test', 'projects/example-project/subscriptions/billing/extra',
    'projects/example-project/subscriptions/../bad', 'projects/example-project/subscriptions/goog-reserved',
    'projects/example-project/subscriptions/x?secret', 'projects/x/subscriptions/billing']) {
    assert.throws(() => new BillingMonitor({ ...h.options, subscription }));
  }
});
