// Pi extension: lets the agent show an HTML/CSS/JS canvas to the user.
// The tool returns the canvas as structured result details. The gateway routes
// it to the conversation that ran the tool, so the model never names a target.
const MAX_FIELD = 200_000;

export default function (pi) {
  pi.registerTool({
    name: 'update_canvas',
    label: 'Update canvas',
    description:
      'Show an interactive HTML/CSS/JS canvas to the user in a sandboxed pane. ' +
      'It runs in an isolated frame with no network access: inline all scripts, styles, ' +
      'images (data: URLs) and data; external libraries, fetch and CDNs are blocked. ' +
      'Provide only body markup in html (no <html> or <body> tags).',
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Body markup.' },
        css: { type: 'string', description: 'Stylesheet.' },
        js: { type: 'string', description: 'Script.' },
      },
      required: ['html'],
    },
    async execute(_id, params) {
      const canvas = {};
      for (const key of ['html', 'css', 'js']) {
        const value = params[key] ?? '';
        if (typeof value !== 'string')
          throw new Error(`${key} must be a string`);
        if (value.length > MAX_FIELD)
          throw new Error(`${key} is larger than ${MAX_FIELD} characters`);
        canvas[key] = value;
      }
      return {
        content: [{ type: 'text', text: 'Canvas updated.' }],
        details: { canvas },
      };
    },
  });
}
