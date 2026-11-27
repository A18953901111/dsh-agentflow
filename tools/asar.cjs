// Minimal asar reader used during development to inspect the DSH installation.
const fs = require('fs');

const ASAR = 'D:\\soft app\\deepseekharness\\resources\\app.asar';

function open() {
  const fd = fs.openSync(ASAR, 'r');
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  const headerLen = buf.readUInt32LE(12);
  const hb = Buffer.alloc(headerLen);
  fs.readSync(fd, hb, 0, headerLen, 16);
  return { fd, header: JSON.parse(hb.toString('utf8')), base: 16 + headerLen };
}

function findEntry(header, target) {
  let node = header;
  for (const part of target.split('/').filter(Boolean)) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

const [cmd, target] = process.argv.slice(2);
const { fd, header, base } = open();

if (cmd === 'cat') {
  const entry = findEntry(header, target);
  if (!entry || entry.files) {
    console.error(`not found: ${target}`);
    process.exit(2);
  }
  const data = Buffer.alloc(entry.size);
  fs.readSync(fd, data, 0, entry.size, base + Number(entry.offset));
  process.stdout.write(data.toString('utf8'));
} else {
  const re = new RegExp(target, 'i');
  (function walk(node, prefix) {
    for (const [key, value] of Object.entries(node.files || {})) {
      const path = `${prefix}/${key}`;
      if (value.files) walk(value, path);
      else if (re.test(path)) console.log(path);
    }
  })(header, '');
}
