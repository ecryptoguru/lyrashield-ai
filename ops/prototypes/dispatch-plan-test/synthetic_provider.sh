#!/bin/sh
# Fixed nonbilling response; the fixture has no provider credentials or egress.
printf 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 45\r\nConnection: close\r\n\r\n{"fixture":"lyrashield-synthetic-provider/1"}'
