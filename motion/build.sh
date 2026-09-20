#!/bin/bash
# The Info.plist MUST be embedded or macOS silently denies motion access.
cd "$(dirname "$0")"
swiftc main.swift -o motion \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
echo "built: $(pwd)/motion"
