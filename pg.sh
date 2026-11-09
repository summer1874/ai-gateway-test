#!/bin/bash
exec psql -h localhost -p 55432 -U postgres "$@"
