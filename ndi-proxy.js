// NDI Discovery Filtering Proxy (JavaScript)
// Intercepts TCP connections, filters NDI <sources> responses, and relays other data unaltered

const net = require('net');
const xml2js = require('xml2js');

// Proxy configuration
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 5958;
const NDI_HOST = process.env.NDI_HOST || '127.0.0.1';
const NDI_PORT = parseInt(process.env.NDI_PORT, 10) || 5959;
const XML_TIMEOUT_MS = 3000;

/**
 * Normalize IPv4 addresses that may be wrapped in an IPv6 notation
 * like ::ffff:192.168.1.10
 * @param {string} ip
 * @returns {string}
 */
function normalizeIPv4(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.substring(7) : ip;
}

/**
 * Compare two IPv4 addresses and check if they belong to the same /24
 * subnet (first three octets match).
 * @param {string} ip1
 * @param {string} ip2
 * @returns {boolean}
 */
function same24(ip1, ip2) {
  const [a1, b1, c1] = normalizeIPv4(ip1).split('.');
  const [a2, b2, c2] = normalizeIPv4(ip2).split('.');
  return a1 === a2 && b1 === b2 && c1 === c2;
}

// Create a TCP server to intercept client connections
const server = net.createServer((clientSocket) => {
  // Connect to the actual NDI server
  const serverSocket = net.createConnection({ host: NDI_HOST, port: NDI_PORT }, () => {
    console.log(`Client connected: proxying to NDI at ${NDI_HOST}:${NDI_PORT}`);
  });

  // Relay client->server traffic unmodified
  clientSocket.pipe(serverSocket);

  // Determine the /24 network prefix of the requesting client
  const clientIP = normalizeIPv4(clientSocket.remoteAddress);

  const showAll = clientIP.startsWith('192.168.44.');

  // Filtering function using the client prefix
  function filterRules(source) {
    const addr = normalizeIPv4(source.address?.[0]);
    if (addr.startsWith('10.64.')) {
      return true; // always show hosts in 10.64.x.x
    }
    if (showAll) {
      return true; // client from 192.168.44.x sees everything
    }
    return same24(clientIP, addr);
  }

  // Buffer for server->client data until full <sources> block
  let buffer = Buffer.alloc(0);
  let xmlTimeout;

  serverSocket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);

    const str = buffer.toString();
    if (str.includes('<sources>') && str.includes('</sources>')) {
      clearTimeout(xmlTimeout);

      // Extract full <sources> XML block
      const start = str.indexOf('<sources>');
      const end = str.indexOf('</sources>') + '</sources>'.length;
      const xmlBlock = str.substring(start, end);

      xml2js.parseString(xmlBlock, { explicitArray: true }, (err, result) => {
        if (err) {
          console.error('XML parse error:', err);
          // Relay original data on parse failure
          clientSocket.write(buffer);
        } else {
          const sources = result.sources?.source || [];
          const filtered = sources
            .filter(filterRules)
            .map((src) => {
              const { groups, ...rest } = src;
              return rest; // drop groups entirely
            });

          // Build new <sources> XML
          const builder = new xml2js.Builder({ rootName: 'sources', headless: true });
          const xmlOut = builder.buildObject({ source: filtered });

          // Send pre-XML, filtered XML, then post-XML
          clientSocket.write(buffer.slice(0, start));
          clientSocket.write(xmlOut);
          clientSocket.write(buffer.slice(end));
        }
        buffer = Buffer.alloc(0);
      });
    } else {
      // If we haven't seen closing tag yet, set a timeout to flush
      clearTimeout(xmlTimeout);
      xmlTimeout = setTimeout(() => {
        clientSocket.write(buffer);
        buffer = Buffer.alloc(0);
      }, XML_TIMEOUT_MS);
    }
  });

  // Error and close handlers
  const cleanup = () => {
    clearTimeout(xmlTimeout);
    clientSocket.destroy();
    serverSocket.destroy();
  };

  serverSocket.on('error', (err) => {
    console.error('Error connecting to NDI server:', err);
    cleanup();
  });

  clientSocket.on('error', (err) => {
    console.error('Client socket error:', err);
    cleanup();
  });

  serverSocket.on('close', () => {
    console.log('Server socket closed');
    cleanup();
  });

  clientSocket.on('close', () => {
    console.log('Client disconnected');
    cleanup();
  });
});

// Start listening for incoming proxy connections
server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`NDI proxy listening on ${PROXY_HOST}:${PROXY_PORT}`);
});

