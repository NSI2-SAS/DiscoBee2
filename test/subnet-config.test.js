const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCidr, validateSubnet } = require('../subnet-config');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('CIDR validation and canonical network addresses', () => {
  assert.equal(normalizeCidr('192.168.1.123/24'), '192.168.1.0/24');
  assert.equal(normalizeCidr('255.255.255.255/0'), '0.0.0.0/0');
  assert.equal(normalizeCidr('192.168.1.123/32'), '192.168.1.123/32');
  for (const value of ['1.2.3.999/24', '1.2.3.4/33', '1.2.3.4/-1', '1.2.3.4', '::1/32', null]) {
    assert.throws(() => normalizeCidr(value));
  }
});

const filter = { range: '10.0.0.0/24', name: 'Studio', default: 'share', authorized: [] };
test('subnets reject duplicates and invalid fields, and allow editing themselves', () => {
  assert.throws(() => validateSubnet({ ...filter, range: '10.0.0.4/24' }, [filter]));
  assert.deepEqual(validateSubnet(filter, [filter], 0), filter);
  for (const body of [null, { ...filter, name: '' }, { ...filter, default: 'invalid' },
    { ...filter, authorized: 'all' }, { ...filter, authorized: ['invalid'] }]) {
    assert.throws(() => validateSubnet(body, []));
  }
});

// Exercise the actual API handlers without opening discovery ports or requiring
// external dependencies. YAML parsing is stubbed; persistence uses the same API.
function serverHarness() {
  const routes = {};
  const app = { use() {}, get(route, fn) { routes['GET ' + route] = fn; },
    post(route, fn) { routes['POST ' + route] = fn; },
    put(route, fn) { routes['PUT ' + route] = fn; }, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  express.static = () => () => {};
  let disk = JSON.stringify({ custom: 'preserved', filters: [filter] });
  let temporary;
  let failWrite = false;
  const fakeFs = {
    readFileSync: () => disk,
    writeFileSync(file, data) { if (failWrite) throw new Error('read only'); temporary = data; },
    renameSync() { disk = temporary; },
    unlinkSync() {}
  };
  const fakeNet = { createServer: () => ({ listen() {} }) };
  const requireMock = name => ({
    express, net: fakeNet, fs: fakeFs, path,
    'js-yaml': { load: JSON.parse, dump: JSON.stringify },
    xml2js: {}, './subnet-config': { validateSubnet }
  })[name];
  const context = vm.createContext({ require: requireMock, process: { env: {} },
    console: { log() {}, error() {} }, __dirname: path.resolve(__dirname, '..'),
    setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), context);
  function request(method, body, index, headers = {}) {
    const req = { method, body, params: { index }, protocol: 'http',
      get: name => headers[name] || (name === 'host' ? 'localhost:8080' : undefined) };
    const res = { code: 200, status(code) { this.code = code; return this; },
      json(data) { this.body = data; return this; } };
    routes[method + ' /api/subnets' + (method === 'PUT' ? '/:index' : '')](req, res);
    return res;
  }
  return { request, context, disk: () => JSON.parse(disk), fail: () => { failWrite = true; } };
}

test('API creates, updates and persists filters while preserving other settings', () => {
  const h = serverHarness();
  assert.equal(h.request('GET').body.length, 1);
  assert.equal(h.request('POST', { ...filter, range: '10.1.0.0/16' }).code, 201);
  assert.equal(h.disk().custom, 'preserved');
  assert.equal(h.disk().filters.length, 2);
  assert.equal(h.request('PUT', { ...filter, name: 'Renamed', default: 'block' }, '0').code, 200);
  assert.equal(h.disk().filters[0].name, 'Renamed');
  assert.equal(h.request('PUT', filter, '99').code, 404);
  assert.equal(h.request('PUT', filter, '-1').code, 404);
  assert.equal(h.request('POST', filter).code, 400);
  assert.equal(h.request('POST', filter, null, { Origin: 'https://other.example' }).code, 403);
});

test('write failure leaves active rules and persisted config untouched', () => {
  const h = serverHarness();
  h.fail();
  assert.equal(h.request('PUT', { ...filter, name: 'Not saved' }, '0').code, 500);
  assert.equal(h.request('GET').body[0].name, 'Studio');
  assert.equal(h.disk().filters[0].name, 'Studio');
});

test('sharing changes notify connected listeners and refresh metric labels', () => {
  const h = serverHarness();
  vm.runInContext(
    "globalThis.messages = []; const listener = { writable: true, write: message => messages.push(message) };" +
    "hosts.set(listener, '192.168.1.2');" +
    "sources.push({ address: '10.0.0.2', owners: new Set() });" +
    "sourceStates.set('10.0.0.2', { host: '10.0.0.2' });" +
    "buildRemoveSource = () => 'remove'; buildAddSource = () => 'add';", h.context);
  assert.equal(h.request('PUT', { ...filter, default: 'block', name: 'Restricted' }, '0').code, 200);
  assert.equal(h.context.messages[0], 'remove');
  assert.equal(vm.runInContext("sourceStates.get('10.0.0.2').name", h.context), 'Restricted');
  assert.equal(h.request('PUT', filter, '0').code, 200);
  assert.equal(h.context.messages[1], 'add');
});
