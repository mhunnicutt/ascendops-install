#!/usr/bin/env bash
node /home/ascend/ascendops/scripts/dashboard-vault-sync.mjs || true
cd /home/ascend/ascendops/dashboard
exec npm start
