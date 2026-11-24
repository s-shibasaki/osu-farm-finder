#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`osu-farm-finder needs Node.js 18 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const args = process.argv.slice(2);

// Experimental: measure random-id sampling (see src/probe.js).
const probe2Arg = args.find((a) => a.startsWith('--probe2='));
if (probe2Arg) {
  const { runProbe2 } = await import('../src/probe2.js');
  try {
    await runProbe2({ username: probe2Arg.split('=')[1] });
    process.exit(0);
  } catch (e) {
    console.error(`\nエラー: ${e.message}`);
    process.exit(1);
  }
}
const probeArg = args.find((a) => a.startsWith('--probe='));
if (probeArg) {
  const { runProbe } = await import('../src/probe.js');
  const callsArg = args.find((a) => a.startsWith('--calls='));
  try {
    await runProbe({ username: probeArg.split('=')[1], calls: callsArg ? Number(callsArg.split("=")[1]) : 100 });
    process.exit(0);
  } catch (e) {
    console.error(`\nエラー: ${e.message}`);
    process.exit(1);
  }
}
const portArg = args.find((a) => a.startsWith('--port='));
let port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT) || 3000;
const noOpen = args.includes('--no-open');

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* user can open the URL manually */
  }
}

const server = createServer();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !portArg) {
    port += 1; // try the next port
    server.listen(port, '127.0.0.1');
  } else {
    console.error(e.message);
    process.exit(1);
  }
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${server.address().port}`;
  console.log(`osu-farm-finder is running: ${url}`);
  console.log('Press Ctrl+C to stop.');
  if (!noOpen) openBrowser(url);
});
