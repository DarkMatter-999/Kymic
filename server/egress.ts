import { createEgressProxy } from './egress-proxy';

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const allow = list(process.env.EGRESS_ALLOW);
if (allow.length === 0)
  console.warn('EGRESS_ALLOW is empty: every destination will be refused.');

const server = createEgressProxy({
  allow,
  allowPrivate: list(process.env.EGRESS_ALLOW_PRIVATE),
  log: (message) => console.warn(`egress: ${message}`),
});
const port = Number(process.env.PORT ?? 3128);
server.listen(port, process.env.HOST ?? '0.0.0.0', () =>
  console.log(
    `Egress proxy on :${port}, allowing ${allow.join(', ') || 'nothing'}`
  )
);
