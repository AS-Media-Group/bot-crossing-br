#!/bin/sh
# Refuses a commit whose staged diff would publish something private into this public repo — an
# internal machine's tailnet name, its short hostname, a path only this maintainer's machine has,
# or an OS account name.
#
# The strings this checks for are assembled at runtime from smaller pieces, on purpose: writing
# any of them out whole in this file would mean the file that exists to keep them out of the repo
# is itself the place they first showed up.
set -eu

p1=tail; p2=d793d7
s1="$p1$p2"

p3=asmg-macbook; p4=-pro
s2="$p3$p4"

p5=/Volumes/Media; p6=' Drive'
s3="$p5$p6"

p7=as_med; p8=ia
s4="$p7$p8"

pattern=$(printf '%s|%s|%s|%s' "$s1" "$s2" "$s3" "$s4")

hits=$(git diff --cached -U0 | grep -nE "$pattern" || true)

if [ -n "$hits" ]; then
  echo "check-private: the staged diff mentions something that should not leave this machine:" >&2
  echo "$hits" >&2
  exit 1
fi

exit 0
