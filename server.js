const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const xml2js = require('xml2js');

// Ports for the two services
const WEB_PORT = parseInt(process.env.WEB_PORT || '8080', 10);
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

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------
// Map of host ip to metric info. Each entry keeps the last few state
// transitions with their event time so Prometheus can scrape them even if it
// doesn't poll fast enough. Accesses are protected by a simple mutex to avoid
// race conditions when metrics are scraped while updates happen.
const sourceStates = new Map();

class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }
  lock() {
    return new Promise((resolve) => {
      if (this._locked) {
        this._queue.push(resolve);
      } else {
        this._locked = true;
        resolve();
      }
    });
  }
  unlock() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

const metricsMutex = new Mutex();

async function updateSourceMetric(src, state) {
  await metricsMutex.lock();
  try {
    const f = findFilter(FILTERS, src.address);
    const info = sourceStates.get(src.address) || {
      range: f?.range || 'unknown',
      name: f?.name || 'unknown',
      host: src.address,
      events: [],
    };

    info.events.push({ state, time: Date.now() });
    // Keep only the last 300 events to avoid unbounded growth
    if (info.events.length > 300) {
      info.events.shift();
    }

    sourceStates.set(src.address, info);
  } finally {
    metricsMutex.unlock();
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

function getWatchersForIp(ip) {
  const f = findFilter(FILTERS, ip);
  if (!f) return ['0.0.0.0/0'];
  const def = (f.default || 'share').toLowerCase();
  if (def === 'share') return ['0.0.0.0/0'];
  const auth = Array.isArray(f.authorized) ? f.authorized : [];
  return [f.range, ...auth];
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
  return `<add_source>${buildSourceXml(src)}</add_source>\0`;
}

function buildRemoveSource(src) {
  return `<remove_source>${buildSourceXml(src)}</remove_source>\0`;
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
const pendingRemovals = new Map(); // ip -> timeout

const discoveryServer = net.createServer((socket) => {
  const ip = socket.remoteAddress.replace(/^::ffff:/, '');
  hosts.set(socket, ip);
  console.log("Hote connecte : ",ip)
  socket.setKeepAlive(true, 1000);
  if (pendingRemovals.has(ip)) {
    console.log("stopping timeout for :",ip)
    clearTimeout(pendingRemovals.get(ip));
    pendingRemovals.delete(ip);
  }

  socket.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
      console.log("Host disconnected : ",ip)
      hosts.delete(socket);
    } else {
      console.error('Socket error', err);
    }
  });

  socket.on('data', async (data) => {
    const str = data.toString();
    console.log("Data",str)
    if (str.includes('<query/>')) {
      const allowed = sources.filter((s) => canShare(FILTERS, s.address, ip));
      const xml = buildSources(allowed);
      console.log("Sending XML to ",ip)
      console.log(xml)
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
        updateSourceMetric(newSrc, 1);
        console.log("new source",newSrc)
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
    console.log("Connection closed ",ip)
    if ([...hosts.values()].includes(ip)) {
      return; // another connection from this IP is still active
    }
    console.log("starting timeout for ",ip)
    const timeout = setTimeout(() => {
      if ([...hosts.values()].includes(ip)) {
        return; // reconnected during delay
      }
      console.log("removing for",ip)
      const removed = sources.filter((s) => s.owner === ip);
      sources = sources.filter((s) => s.owner !== ip);
      for (const src of removed) {
        updateSourceMetric(src, 0);
        for (const [sock, hIp] of hosts.entries()) {
          if (canShare(FILTERS, src.address, hIp)) {
            sock.write(buildRemoveSource(src));
          }
        }
      }
      pendingRemovals.delete(ip);
    }, 60000);
    pendingRemovals.set(ip, timeout);
  });
});

discoveryServer.listen(DISCOVERY_PORT, () => {
  console.log(`NDI Discovery server listening on ${DISCOVERY_PORT}`);
});

// ---------------------------------------------------------------------------
// Express API
// ---------------------------------------------------------------------------
app.get('/api/sources', (req, res) => {
  const data = sources.map((s) => {
    const f = findFilter(FILTERS, s.address);
    return {
      name: s.name,
      address: s.address,
      port: s.port,
      groups: s.groups,
      groupName: f?.name || 'unknown',
      range: f?.range || 'unknown',
      watchers: getWatchersForIp(s.address)
    };
  });
  res.json(data);
});

app.get('/api/test', (req, res) => {
  const ip = req.query.ip;
  if (!ip) return res.json([]);
  const allowed = sources.filter((s) => canShare(FILTERS, s.address, ip));
  const data = allowed.map((s) => {
    const f = findFilter(FILTERS, s.address);
    return {
      name: s.name,
      address: s.address,
      port: s.port,
      groups: s.groups,
      groupName: f?.name || 'unknown',
      range: f?.range || 'unknown',
      watchers: getWatchersForIp(s.address)
    };
  });
  res.json(data);
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  let lines = '';
  await metricsMutex.lock();
  try {
    for (const info of sourceStates.values()) {
      for (const evt of info.events) {
        lines +=
          `ndi_source_state{range_subnet="${info.range}",range_name="${info.name}",host_ip="${info.host}"} ${evt.state} ${evt.time}\n`;
      }
      // Clear events once they have been exposed so they are sent only once
      info.events = [];
    }
  } finally {
    metricsMutex.unlock();
  }
  res.send(lines);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(WEB_PORT, () => {
  console.log(`Web server running at http://localhost:${WEB_PORT}`);
});
