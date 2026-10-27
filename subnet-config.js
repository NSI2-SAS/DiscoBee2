const net = require('net');

function normalizeCidr(value) {
  if (typeof value !== 'string') throw new Error('Un réseau IPv4 CIDR est requis.');
  const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(value.trim());
  if (!match || net.isIP(match[1]) !== 4 || Number(match[2]) > 32) {
    throw new Error('Réseau IPv4 CIDR invalide (exemple : 192.168.1.0/24).');
  }
  const prefix = Number(match[2]);
  const ip = match[1].split('.').reduce((n, octet) => (n << 8) | Number(octet), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  return [24, 16, 8, 0].map(shift => (network >>> shift) & 255).join('.') + '/' + prefix;
}

function validateSubnet(body, filters, editIndex = -1) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Configuration invalide.');
  const range = normalizeCidr(body.range);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 ||
      /[\x00-\x1f\x7f]/.test(body.name)) throw new Error('Un nom de 1 à 100 caractères est requis.');
  if (!['share', 'block'].includes(body.default)) throw new Error('Politique de partage invalide.');
  if (!Array.isArray(body.authorized)) throw new Error('La liste des réseaux autorisés est requise.');
  if (filters.some((filter, index) => {
    if (index === editIndex) return false;
    try { return normalizeCidr(filter.range) === range; } catch { return filter.range === range; }
  })) throw new Error('Ce sous-réseau existe déjà.');
  return { range, name: body.name.trim(), default: body.default,
    authorized: [...new Set(body.authorized.map(normalizeCidr))] };
}

module.exports = { normalizeCidr, validateSubnet };
