#!/bin/sh
# pause / resume the staged L8 super-resolution run (the GPU job of the world workstream), e.g. for a GPU-quiet window:
#   sh tools/metro_world/sr_pause.sh pause | resume | status
P=$(pgrep -f "^python3 tools/sr_l8.py" | head -1)          # (anchored: a shell whose command line mentions it must not match)
[ -n "$P" ] || { echo "no sr_l8 process running"; exit 0; }
case "${1:-status}" in
  pause)  kill -STOP "$P" && echo "sr_l8 $P paused" ;;
  resume) kill -CONT "$P" && echo "sr_l8 $P resumed" ;;
  *)      ps -o pid,stat,etime,command -p "$P" | cut -c1-80 ;;
esac
