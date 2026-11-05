import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DialogBroker } from '../server/gateway/dialogs.ts';
import { parseClientCommand } from '../server/gateway/protocol.ts';

const brokers = [];
function make(overrides = {}) {
  const emitted = [];
  const sent = [];
  const state = { listeners: true };
  const broker = new DialogBroker({
    conversationId: 'c1',
    emit: (e) => emitted.push(e),
    sendToWorker: (record) => sent.push(record),
    hasListeners: () => state.listeners,
    timeoutMs: 10_000,
    graceMs: 10_000,
    ...overrides,
  });
  brokers.push(broker);
  return { broker, emitted, sent, state };
}
afterEach(() => brokers.splice(0).forEach((b) => b.dispose()));
const req = (extra) => ({
  type: 'extension_ui_request',
  id: 'd1',
  method: 'confirm',
  title: 'Sure?',
  message: 'really',
  ...extra,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a dialog request is registered, emitted and listed for reconnecting clients', () => {
  const { broker, emitted } = make();
  assert.equal(broker.handleRequest(req()), true);
  assert.equal(emitted[0].type, 'dialog_request');
  assert.deepEqual(
    {
      id: emitted[0].dialogId,
      method: emitted[0].method,
      title: emitted[0].title,
      message: emitted[0].message,
    },
    { id: 'd1', method: 'confirm', title: 'Sure?', message: 'really' }
  );
  assert.equal(emitted[0].v, 1);
  assert.equal(emitted[0].conversationId, 'c1');
  assert.deepEqual(
    broker.list().map((d) => d.dialogId),
    ['d1']
  );
});

test('exactly one response reaches Pi; duplicates and stale answers are rejected', () => {
  const { broker, emitted, sent } = make();
  broker.handleRequest(req());
  broker.respond('d1', { confirmed: true });
  assert.deepEqual(sent, [
    { type: 'extension_ui_response', id: 'd1', confirmed: true },
  ]);
  assert.equal(emitted.at(-1).type, 'dialog_closed');
  assert.equal(emitted.at(-1).reason, 'answered');
  assert.throws(
    () => broker.respond('d1', { confirmed: false }),
    /already answered|unknown/i
  );
  assert.throws(() => broker.respond('nope', { cancelled: true }), /unknown/i);
  assert.equal(sent.length, 1);
  assert.deepEqual(broker.list(), []);
});

test('responses are validated against the dialog method and leave it pending when invalid', () => {
  const { broker, sent } = make();
  broker.handleRequest(
    req({
      id: 's',
      method: 'select',
      options: ['Allow', 'Block'],
      message: undefined,
    })
  );
  assert.throws(() => broker.respond('s', { value: 'Maybe' }), /option/i);
  assert.throws(() => broker.respond('s', { confirmed: true }), /select/i);
  assert.equal(sent.length, 0);
  assert.equal(broker.list().length, 1);
  broker.respond('s', { value: 'Block' });
  assert.deepEqual(sent, [
    { type: 'extension_ui_response', id: 's', value: 'Block' },
  ]);

  broker.handleRequest(req({ id: 'c' }));
  assert.throws(() => broker.respond('c', { value: 'yes' }), /confirm/i);
  broker.handleRequest(req({ id: 'i', method: 'input' }));
  assert.throws(() => broker.respond('i', { confirmed: true }), /input/i);
  assert.throws(
    () => broker.respond('i', { value: 'x'.repeat(100_001) }),
    /too large/i
  );
  broker.respond('i', { value: 'typed' });
  broker.handleRequest(req({ id: 'e', method: 'editor', prefill: 'a\nb' }));
  broker.respond('e', { value: 'a\nb\nc' });
});

test('cancelling any dialog sends cancelled:true', () => {
  const { broker, sent, emitted } = make();
  broker.handleRequest(req({ id: 'x', method: 'input' }));
  broker.respond('x', { cancelled: true });
  assert.deepEqual(sent, [
    { type: 'extension_ui_response', id: 'x', cancelled: true },
  ]);
  assert.equal(emitted.at(-1).reason, 'cancelled');
});

test('concurrent dialogs are tracked independently and can be answered out of order', () => {
  const { broker, sent } = make();
  broker.handleRequest(req({ id: 'a' }));
  broker.handleRequest(req({ id: 'b', method: 'input' }));
  broker.respond('b', { value: 'second' });
  broker.respond('a', { confirmed: false });
  assert.deepEqual(
    sent.map((s) => s.id),
    ['b', 'a']
  );
});

test('a dialog with no Pi timeout is cancelled (a denial) at the gateway deadline', async () => {
  const { broker, sent, emitted } = make({ timeoutMs: 60 });
  broker.handleRequest(req());
  assert.ok(emitted[0].expiresAt > Date.now());
  await wait(150);
  assert.deepEqual(sent, [
    { type: 'extension_ui_response', id: 'd1', cancelled: true },
  ]);
  assert.equal(emitted.at(-1).reason, 'timeout');
  assert.deepEqual(broker.list(), []);
});

test('a dialog with a Pi timeout is dropped without answering once Pi has auto-resolved it', async () => {
  const { broker, sent, emitted } = make({ piTimeoutGraceMs: 30 });
  broker.handleRequest(req({ timeout: 40 }));
  await wait(200);
  assert.equal(sent.length, 0);
  assert.equal(emitted.at(-1).type, 'dialog_closed');
  assert.equal(emitted.at(-1).reason, 'timeout');
});

test('dialogs are cancelled when no client has been connected for the grace period', async () => {
  const { broker, sent, emitted, state } = make({ graceMs: 60 });
  broker.handleRequest(req());
  state.listeners = false;
  broker.listenersChanged();
  await wait(150);
  assert.deepEqual(sent, [
    { type: 'extension_ui_response', id: 'd1', cancelled: true },
  ]);
  assert.equal(emitted.at(-1).reason, 'disconnected');
});

test('a client that reconnects within the grace period keeps its dialog', async () => {
  const { broker, sent, state } = make({ graceMs: 80 });
  broker.handleRequest(req());
  state.listeners = false;
  broker.listenersChanged();
  await wait(30);
  state.listeners = true;
  broker.listenersChanged();
  await wait(150);
  assert.equal(sent.length, 0);
  assert.equal(broker.list().length, 1);
});

test('a dialog that arrives while nobody is connected also gets the grace deadline', async () => {
  const { broker, sent, state } = make({ graceMs: 60 });
  state.listeners = false;
  broker.handleRequest(req());
  await wait(150);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cancelled, true);
});

test('worker exit clears dialogs without writing to the dead process', () => {
  const { broker, sent, emitted } = make();
  broker.handleRequest(req({ id: 'a' }));
  broker.handleRequest(req({ id: 'b' }));
  broker.workerExited();
  assert.equal(sent.length, 0);
  assert.deepEqual(
    emitted.filter((e) => e.type === 'dialog_closed').map((e) => e.reason),
    ['worker_exited', 'worker_exited']
  );
  assert.deepEqual(broker.list(), []);
});

test('notify becomes a notice; other UI methods are reported once as unsupported', () => {
  const { broker, emitted } = make();
  assert.equal(
    broker.handleRequest({
      type: 'extension_ui_request',
      id: 'n',
      method: 'notify',
      message: 'hi',
      notifyType: 'warning',
    }),
    true
  );
  assert.deepEqual(
    {
      type: emitted[0].type,
      level: emitted[0].level,
      message: emitted[0].message,
    },
    { type: 'notice', level: 'warning', message: 'hi' }
  );
  for (let i = 0; i < 3; i++)
    broker.handleRequest({
      type: 'extension_ui_request',
      id: `s${i}`,
      method: 'setStatus',
      statusKey: 'k',
      statusText: 't',
    });
  broker.handleRequest({
    type: 'extension_ui_request',
    id: 'w',
    method: 'setWidget',
    widgetKey: 'k',
  });
  const unsupported = emitted
    .filter((e) => e.type === 'ui_unsupported')
    .map((e) => e.method);
  assert.deepEqual(unsupported, ['setStatus', 'setWidget']);
});

test('non-UI records and malformed requests are not consumed or registered', () => {
  const { broker, emitted } = make();
  assert.equal(broker.handleRequest({ type: 'agent_start' }), false);
  assert.equal(
    broker.handleRequest({
      type: 'extension_ui_request',
      id: 5,
      method: 'confirm',
    }),
    true
  );
  assert.equal(
    broker.handleRequest({
      type: 'extension_ui_request',
      id: 'z',
      method: 'select',
      title: 't',
      options: 'nope',
    }),
    true
  );
  assert.deepEqual(broker.list(), []);
  assert.ok(emitted.every((e) => e.type !== 'dialog_request'));
});

test('protocol parses dialog_response and rejects malformed ones', () => {
  const ok = (extra) =>
    parseClientCommand({
      v: 1,
      type: 'dialog_response',
      conversationId: 'c1',
      dialogId: 'd1',
      ...extra,
    });
  assert.deepEqual(ok({ value: 'x', evil: 1 }), {
    v: 1,
    type: 'dialog_response',
    conversationId: 'c1',
    dialogId: 'd1',
    value: 'x',
  });
  assert.equal(ok({ confirmed: true }).confirmed, true);
  assert.equal(ok({ cancelled: true }).cancelled, true);
  assert.throws(() => ok({}), /Invalid/);
  assert.throws(() => ok({ value: 'x', confirmed: true }), /Invalid/);
  assert.throws(() => ok({ confirmed: 'yes' }), /Invalid/);
  assert.throws(() => ok({ cancelled: false }), /Invalid/);
  assert.throws(() => ok({ value: 5 }), /Invalid/);
  assert.throws(
    () =>
      parseClientCommand({
        v: 1,
        type: 'dialog_response',
        conversationId: 'c1',
        value: 'x',
      }),
    /Invalid/
  );
});
