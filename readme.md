# DiscoBee2 - non commercial improved NDI discovery server

DiscoBee2 is a free tool developed by NSI2 Consuting SAS and based on DiscoBee by ByteHive 
It is an improved NDI Discovery Server trying to provide explicit domain features to limit discovery of sources from listener with one discovery server.

## Features

- Display all NDI sources registered on a Discovery server
- Groups sources declared in config.yaml

## Requirements

To run DiscoBee from source you will need the following tools installed:

- **npm**
- **Node.js**
- **git**
- **curl**

## Use

`node server.js`

### Configuration

A yaml table is in config.yml, with
- range : the source subnet ip
- name: the range name to be dispayed on the webpage
- default : default bahaviour: share or block for everyone
- authorized: list of subnets authorized to view the source

### NDI Discovery Server Service

Create a startup.sh file launching the start.sh script of the repository

Create a systemd unit to launch the Discovery Server on boot:
```
[Unit]
Description=NDI Discovery Server
After=network.target

[Service]
Type=simple
ExecStart=bash /home/user/startup.sh
Restart=always
User=user
Group=user
WorkingDirectory=/home/user

[Install]
WantedBy=multi-user.target
```

## API
/api/sources 
list all the available sources


## Contact and license

Contact web-entry --at-- nsi2.sturmel.com for any question, code is under MIT license and is aimed at non commercial uses. If you want to do any commercial use, see with the NDI SDK licensing. 

This software comes with no support no garantees that it ill remain functionnal as it is based on the current NDI protocol subject to change anty time.

