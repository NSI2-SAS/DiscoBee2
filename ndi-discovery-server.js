const net = require('net');
const fs = require('fs');
const xml2js = require('xml2js');

// Simple YAML parser for config files without external deps
function parseConfig(path) {
  try {
    const text = fs.readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/);
    const filters = [];
    let current = null;
    let inAuthorized = false;
    for (let line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.search(/\S|$/);
      line = line.trim();
      if (line === 'filters:') continue;
      if (line.startsWith('- ')) {
        current = {};
        filters.push(current);
        inAuthorized = false;
        const parts = line.slice(2).split(':');
        if (parts.length > 1) current[parts[0].trim()] = parts.slice(1).join(':').trim();
      } else if (current) {
        if (line.startsWith('authorized:')) {
          current.authorized = [];
          inAuthorized = true;
          const val = line.split(':')[1].trim();
          if (val) current.authorized.push(val);
        } else if (inAuthorized && line.startsWith('- ')) {
          current.authorized.push(line.slice(2).trim());
        } else {
          const idx = line.indexOf(':');
          if (idx > -1) {
            const key = line.slice(0, idx).trim();
            const val = line.slice(idx + 1).trim();
            current[key] = val;
            inAuthorized = false;
          }
        }
      }
    }
    return { filters };
  } catch (e) {
    return { filters: [] };
  }
}

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

function findFilter(filters, sourceIp) {
  let best = null;
  let bestMask = -1;
  for (const f of filters) {
    if (f.range && cidrMatch(sourceIp, f.range)) {
      const mask = parseInt(f.range.split('/')[1] || '32', 10);
      if (mask > bestMask) {
        best = f;
        bestMask = mask;
      }
    }
  }
  return best;
}

function canShare(filters, sourceIp, hostIp) {
  const f = findFilter(filters, sourceIp);
  if (!f) return true;
  const def = (f.default || 'share').toLowerCase();
  if (def === 'share') return true;
  if (!Array.isArray(f.authorized)) return false;
  return f.authorized.some((cidr) => cidrMatch(hostIp, cidr));
}

function buildSourceXml(src) {
  const builder = new xml2js.Builder({ headless: true, rootName: 'source' });
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
  const builder = new xml2js.Builder({ headless: true, rootName: 'sources' });
  const srcs = list.map((s) => ({
    name: s.name,
    metadata: s.metadata || '',
    address: s.address,
    port: s.port,
    groups: { group: s.groups }
  }));
  return builder.buildObject({ source: srcs });
}

const CONFIG = parseConfig(process.env.CONFIG || 'config.yml');
const PORT = parseInt(process.env.PORT || '5959', 10);

const hosts = new Map(); // socket -> ip
let sources = [];

const server = net.createServer((socket) => {
  const ip = socket.remoteAddress.replace(/^::ffff:/, '');
  hosts.set(socket, ip);

  socket.on('data', async (data) => {
    const str = data.toString();
    if (str.includes('<query/>')) {
      const allowed = sources.filter((s) => canShare(CONFIG.filters, s.address, ip));
      const xml = buildSources(allowed);
      socket.write(xml);
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
          if (canShare(CONFIG.filters, newSrc.address, hIp)) {
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
        if (canShare(CONFIG.filters, src.address, hIp)) {
          sock.write(buildRemoveSource(src));
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`NDI Discovery server listening on ${PORT}`);
});
