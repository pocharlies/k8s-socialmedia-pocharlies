#!/bin/bash
# Set proper ownership and permissions for PostgreSQL SSL certificates
cp /var/lib/postgresql/server.crt /var/lib/postgresql/data/server.crt
cp /var/lib/postgresql/server.key /var/lib/postgresql/data/server.key
cp /var/lib/postgresql/ca.crt /var/lib/postgresql/data/ca.crt

chown postgres:postgres /var/lib/postgresql/data/server.*
chown postgres:postgres /var/lib/postgresql/data/ca.crt
chmod 600 /var/lib/postgresql/data/server.key
chmod 644 /var/lib/postgresql/data/server.crt
chmod 644 /var/lib/postgresql/data/ca.crt
