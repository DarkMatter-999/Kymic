import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanvasDocument,
  CANVAS_CSP,
  CANVAS_PRINT_MESSAGE,
  CANVAS_SANDBOX,
} from '../src/chat/canvasDocument.ts';
import { latestCanvas, parseCanvas } from '../server/gateway/canvas.ts';
import { projectPiEvent } from '../server/gateway/protocol.ts';

test('the sandbox never combines allow-scripts with allow-same-origin', () => {
  const flags = CANVAS_SANDBOX.split(/\s+/);
  assert.ok(flags.includes('allow-scripts'));
  for (const bad of [
    'allow-same-origin',
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-popups-to-escape-sandbox',
    'allow-downloads',
  ])
    assert.ok(!flags.includes(bad), bad);
});

test('the canvas document carries a CSP that blocks all network access', () => {
  const doc = buildCanvasDocument({ html: '<p>x</p>', css: '', js: '' });
  assert.ok(doc.includes(`content="${CANVAS_CSP}"`));
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<p>x</p>'));
  for (const directive of [
    "default-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ])
    assert.ok(CANVAS_CSP.includes(directive), directive);
  assert.ok(!/connect-src|frame-src|https?:/.test(CANVAS_CSP));
});

test('closing tags in css/js cannot end the wrapper element early', () => {
  const doc = buildCanvasDocument({
    html: '',
    css: 'a{} </style><img src=x onerror=1>',
    js: 'var s="</script><img src=x>";',
  });
  assert.equal(doc.match(/<\/style>/gi).length, 1);
  assert.equal(doc.match(/<\/script>/gi).length, 1);
});

test('print is only honored from the parent window', () => {
  const doc = buildCanvasDocument({ html: '', css: '', js: '' });
  assert.ok(doc.includes('event.source === window.parent'));
  assert.ok(doc.includes(CANVAS_PRINT_MESSAGE));
});

test('only the exact canvas shape is accepted from tool results', () => {
  assert.deepEqual(parseCanvas({ canvas: { html: 'a', css: '', js: '' } }), {
    html: 'a',
    css: '',
    js: '',
  });
  for (const bad of [
    null,
    {},
    { canvas: null },
    { canvas: { html: 1, css: '', js: '' } },
    { canvas: { html: 'a' } },
    { canvas: { html: 'x'.repeat(200_001), css: '', js: '' } },
  ])
    assert.equal(parseCanvas(bad), null);
});

test('only the canvas tool produces canvas events, and only on success', () => {
  const end = (toolName, isError, details) =>
    projectPiEvent('c1', {
      type: 'tool_execution_end',
      toolCallId: 't',
      toolName,
      isError,
      result: { details },
    });
  const details = { canvas: { html: 'a', css: '', js: '' } };
  assert.equal(
    end('update_canvas', false, details)
      .map((e) => e.type)
      .join(),
    'tool_end,canvas'
  );
  assert.equal(end('update_canvas', true, details).length, 1);
  assert.equal(end('bash', false, details).length, 1);
  assert.equal(end('update_canvas', false, { canvas: { html: 5 } }).length, 1);
});

test('latestCanvas picks the newest successful canvas result', () => {
  const result = (html, isError = false) => ({
    role: 'toolResult',
    toolName: 'update_canvas',
    isError,
    details: { canvas: { html, css: '', js: '' } },
  });
  assert.equal(latestCanvas([result('a'), result('b')]).html, 'b');
  assert.equal(latestCanvas([result('a'), result('b', true)]).html, 'a');
  assert.equal(
    latestCanvas([
      {
        role: 'toolResult',
        toolName: 'bash',
        details: { canvas: { html: 'x', css: '', js: '' } },
      },
    ]),
    null
  );
  assert.equal(latestCanvas([]), null);
});
