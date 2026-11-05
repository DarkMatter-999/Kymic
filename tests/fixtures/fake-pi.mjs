// Fake Pi RPC process: reports its environment so launcher tests can assert on it.
import { readdirSync, readlinkSync } from 'node:fs';
let buf = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const cmd = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    let fds = [];
    try {
      fds = readdirSync('/proc/self/fd')
        .map(Number)
        .filter((n) => n > 2);
    } catch {}
    const data = {
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: process.env,
      uid: process.getuid(),
      gid: process.getgid(),
      pid: process.pid,
      fds,
      fdTargets: fds.map((n) => {
        try {
          return readlinkSync(`/proc/self/fd/${n}`);
        } catch {
          return '';
        }
      }),
    };
    process.stdout.write(
      JSON.stringify({
        type: 'response',
        id: cmd.id,
        command: cmd.type,
        success: true,
        data,
      }) + '\n'
    );
  }
});
process.stdin.on('end', () => process.exit(0));
