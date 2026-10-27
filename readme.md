# DiscoBee2

DiscoBee2 is a free and non-commercial NDI discovery server developed by NSI2 Consulting SAS and based on DiscoBee by ByteHive. It is intended as a drop-in replacement for the discovery server distributed with the official NDI SDK. DiscoBee2 adds explicit domain filters that limit which NDI sources are visible to listeners and exports Prometheus metrics for monitoring.

## Features

- Web interface showing all NDI sources registered on the discovery server
- Source grouping and access control defined in `config.yml`
- Configuration menu to add and edit subnets without restarting
- Prometheus metrics endpoint at `/metrics` exposing source status
- Simple REST API for querying sources

## Requirements

To run DiscoBee2 from source you need:

- **Node.js**
- **npm**
- **git**
- **curl**

## Usage

```bash
npm install
npm start
```

`start.sh` is intended for use with an external configuration repository; adapt it to your own workflow if needed.

### Configuration

Open **Configuration** in the web interface to add a subnet or choose **Modifier**
to edit an existing subnet. Set its name, IPv4 CIDR, default sharing policy and
optional authorized networks (one CIDR per line). **Enregistrer** saves the changes
to `config.yml` (or the file selected by `CONFIG`) and applies them immediately,
including visibility updates for connected listeners. The server needs write access
to the configuration directory. Equivalent CIDRs are normalized and duplicates rejected.

The configuration API uses the existing unauthenticated web interface. Restrict access
to the web port to trusted administrators, or protect it with an authenticated reverse proxy.

You can also edit `config.yml` manually and restart the server. Define filters with:

- `range`: subnet of the source (CIDR notation)
- `name`: label shown on the web page
- `default`: `share` or `block` to control the default visibility
- `authorized`: list of subnets permitted to see the source

### Systemd service

Create a `startup.sh` script that launches `start.sh`, then add a systemd unit:

```
[Unit]
Description=NDI Discovery Server
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash /home/user/startup.sh
Restart=always
User=user
Group=user
WorkingDirectory=/home/user

[Install]
WantedBy=multi-user.target
```

## API

- `GET /api/sources` – list all available sources
- `GET /api/subnets` – list configured subnet filters in configuration order
- `POST /api/subnets` – add a filter
- `PUT /api/subnets/:index` – update a filter by its zero-based configuration index

Write requests use JSON with `range`, `name`, `default` (`share` or `block`),
and `authorized` (an array of IPv4 CIDRs, possibly empty). Invalid input returns
400, an unknown index returns 404, and a persistence failure returns 500 without
changing active rules. Other configuration keys are preserved when saving.

## Tests

Run `npm test` for validation and API handler tests. API tests stub the external
server dependencies and YAML codec; they do not start a real discovery server.

## Contact and license

Contact `web-entry --at-- nsi2.sturmel.com` for any question. Code is under the MIT license and intended for non-commercial use. For commercial usage, refer to NDI SDK licensing.

This software comes with no support and no guarantee that it will remain functional as the NDI protocol may change at any time.

