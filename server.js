const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const xml2js = require('xml2js');

// Ports for the two services
const WEB_PORT = parseInt(process.env.WEB_PORT || '80', 10);
const DISCOVERY_PORT = parseInt(process.env.PORT || '5959', 10);
const CONFIG_FILE = process.env.CONFIG || 'config.yml';

const app = express();

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------
function loadFilters(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const cfg = yaml.load(content);
    return Array.isArray(cfg?.filters) ? cfg.filters : [];
  } catch (e) {
    console.error('Failed to load config:', e.message);
    return [];
  }
}
const FILTERS = loadFilters(CONFIG_FILE);

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function cidrMatch(ip, cidr) {
  const [range, maskStr] = cidr.split('/');
  const mask = maskStr ? parseInt(maskStr, 10) : 32;
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  const maskInt = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
  return (ipInt & maskInt) === (rangeInt & maskInt);
}

function findFilter(filters, ip) {
  let best = null;
  let bestMask = -1;
  for (const f of filters) {
    if (f.range && cidrMatch(ip, f.range)) {
      const mask = parseInt(f.range.split('/')[1] || '32', 10);
      if (mask > bestMask) {
        best = f;
        bestMask = mask;
      }
    }
  }
  return best;
}

function getGroupName(ip) {
  const f = findFilter(FILTERS, ip);
  return f?.name || 'unknown';
}

function canShare(filters, sourceIp, hostIp) {
  const f = findFilter(filters, sourceIp);
  if (!f) return true;
  const def = (f.default || 'share').toLowerCase();
  if (def === 'share') return true;
  if (!Array.isArray(f.authorized)) return false;
  return f.authorized.some((cidr) => cidrMatch(hostIp, cidr)) || cidrMatch(hostIp, f.range);
}

function buildSourceXml(src) {
  const builder = new xml2js.Builder({ headless: true, rootName: 'source', renderOpts: { pretty: false } });
  return builder.buildObject({
    name: src.name,
    metadata: src.metadata || '',
    address: src.address,
    port: src.port,
    groups: { group: src.groups }
  });
}

function buildAddSource(src) {
  return `<add_source>${buildSourceXml(src)}</add_source>`;
}

function buildRemoveSource(src) {
  return `<remove_source>${buildSourceXml(src)}</remove_source>`;
}

function buildSources(list) {
  const builder = new xml2js.Builder({ headless: true, rootName: 'sources', renderOpts: { pretty: false } });
  const srcs = list.map((s) => ({
    name: s.name,
    metadata: s.metadata || '',
    address: s.address,
    port: s.port,
    groups: { group: s.groups }
  }));
  return builder.buildObject({ source: srcs });
}

// ---------------------------------------------------------------------------
// NDI Discovery server logic
// ---------------------------------------------------------------------------
const hosts = new Map(); // socket -> ip
let sources = [];

const discoveryServer = net.createServer((socket) => {
  const ip = socket.remoteAddress.replace(/^::ffff:/, '');
  hosts.set(socket, ip);

  socket.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
      hosts.delete(socket);
    } else {
      console.error('Socket error', err);
    }
  });

  socket.on('data', async (data) => {
    const str = data.toString();
    if (str.includes('<query/>')) {
      const allowed = sources.filter((s) => canShare(FILTERS, s.address, ip));
      const xml = buildSources(allowed);
      socket.write(`${xml}\0`);
      return;
    }

    if (str.includes('<source>')) {
      try {
        const result = await xml2js.parseStringPromise(str);
        const src = result.source;
        const newSrc = {
          name: src.name?.[0] || '',
          metadata: '',
          address: (src.address?.[0] === '0.0.0.0' ? ip : src.address?.[0]) || ip,
          port: src.port?.[0] || '5961',
          groups: src.groups?.[0]?.group || ['public'],
          owner: ip
        };
        sources.push(newSrc);
        for (const [sock, hIp] of hosts.entries()) {
          if (sock === socket) continue;
          if (canShare(FILTERS, newSrc.address, hIp)) {
            sock.write(buildAddSource(newSrc));
          }
        }
      } catch (e) {
        console.error('Parse error', e);
      }
      return;
    }
  });

  socket.on('close', () => {
    hosts.delete(socket);
    const removed = sources.filter((s) => s.owner === ip);
    sources = sources.filter((s) => s.owner !== ip);
    for (const src of removed) {
      for (const [sock, hIp] of hosts.entries()) {
        if (canShare(FILTERS, src.address, hIp)) {
          sock.write(buildRemoveSource(src));
        }
      }
    }
  });
});

discoveryServer.listen(DISCOVERY_PORT, () => {
  console.log(`NDI Discovery server listening on ${DISCOVERY_PORT}`);
});

// ---------------------------------------------------------------------------
// Express API
// ---------------------------------------------------------------------------
app.get('/api/sources', (req, res) => {
  const data = sources.map((s) => ({
    name: s.name,
    address: s.address,
    port: s.port,
    groups: s.groups,
    groupName: getGroupName(s.address)
  }));
  res.json(data);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(WEB_PORT, () => {
  console.log(`Web server running at http://localhost:${WEB_PORT}`);
});
