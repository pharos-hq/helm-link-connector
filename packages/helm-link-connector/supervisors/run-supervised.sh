#!/bin/sh
# Map terminal owner revocation (75) to a successful supervisor exit.
# launchd and Docker then remain stopped; transient non-zero failures
# retain their original code and follow the supervisor's bounded policy.
"$@"
status=$?
if [ "$status" -eq 75 ]; then
  exit 0
fi
exit "$status"
