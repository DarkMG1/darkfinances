#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildStateInventory, INVENTORY_PATH } = require('./backup-bundle-inventory');

const inventory = buildStateInventory();
fs.writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
process.stdout.write(`${path.relative(process.cwd(), INVENTORY_PATH)}\n`);
