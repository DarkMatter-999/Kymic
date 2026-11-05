// Test extension: tools that raise Pi extension UI requests.
export default function (pi) {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    description: 'Ask the user a question through an extension dialog.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['method'],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const opts = params.timeout ? { timeout: params.timeout } : undefined;
      let answer;
      if (params.method === 'select')
        answer = await ctx.ui.select('Pick one', ['Allow', 'Block'], opts);
      else if (params.method === 'confirm')
        answer = await ctx.ui.confirm('Proceed?', 'Really proceed?', opts);
      else if (params.method === 'input')
        answer = await ctx.ui.input('Name?', 'type here', opts);
      else answer = await ctx.ui.editor('Edit text', 'line1\nline2');
      return {
        content: [{ type: 'text', text: `ANSWER:${JSON.stringify(answer)}` }],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: 'ui_noise',
    label: 'UI noise',
    description: 'Call fire-and-forget extension UI methods.',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      ctx.ui.setStatus('k', 'status text');
      ctx.ui.setWidget('w', ['widget line']);
      ctx.ui.notify('hello notice', 'warning');
      return { content: [{ type: 'text', text: 'noise done' }], details: {} };
    },
  });
}
