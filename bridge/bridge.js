// Runs on EACH player's Mac. Spawns the Swift reader, relays motion to the browser.
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const readline = require('readline');
const path = require('path');

const wss = new WebSocketServer({ port: 8787 });
const clients = new Set();
wss.on('connection', ws => { clients.add(ws); ws.on('close', () => clients.delete(ws)); });

const proc = spawn(path.join(__dirname, '..', 'motion', 'motion'));
proc.stderr.on('data', d => process.stderr.write('[motion] ' + d));

let n = 0;
readline.createInterface({ input: proc.stdout }).on('line', line => {
  if (++n % 50 === 0) process.stdout.write(`\r${n} samples   `);
  for (const ws of clients) if (ws.readyState === 1) ws.send(line);
});

console.log('motion bridge on ws://localhost:8787');
