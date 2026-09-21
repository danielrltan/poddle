#!/bin/bash
# Deploy Poddle to fly.io, safely.
#   ./deploy.sh          run the quick tests, deploy, then make sure exactly ONE machine is running
#   ./deploy.sh --now    skip the tests
# Why one machine: every court lives in the memory of one process. A second machine (another region, "just in case") splits
# players between two servers that cannot see each other's courts, and fly's proxy autostops whichever one looks idle.
# A deploy restarts the server. Open tabs are told ("Updating"), reconnect, and bring their courts back with seats and score
# (server/game.js revive(), test/revive.test.mjs); only the point in play is lost.
set -e
cd "$(dirname "$0")"
if [ "$1" != "--now" ]; then
  for t in revive.test.mjs rooms.test.mjs seo.test.mjs; do printf "%-18s " "$t"; node "test/$t" 2>&1 | tail -1 | grep -E "PASS" || { echo "FAILED: not deploying"; exit 1; }; done
fi
echo "online right now: $(curl -s -m 5 https://poddleball.com/status.json || echo unknown)"
fly deploy --ha=false 2>&1 | grep -E "Visit|rror|✖" || true
extra=$(fly machines list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s||"[]");const keep=m.find(x=>x.region==="yyz")||m[0];console.log(m.filter(x=>x!==keep).map(x=>x.id).join(" "))})')
for id in $extra; do echo "removing extra machine $id (courts cannot span machines)"; fly machine destroy "$id" --force; done
echo "machines: $(fly machines list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(x=>x.region+":"+x.state).join(", ")))')"
curl -s -o /dev/null -m 10 -w "https://poddleball.com -> %{http_code}\n" https://poddleball.com/
