import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const path = process.argv[2];
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio: 'ignore'});
process.on('SIGTERM', () => {});
writeFileSync(path, JSON.stringify({parent: process.pid, child: child.pid}));
setInterval(() => {}, 1000);
