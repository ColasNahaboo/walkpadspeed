#!/bin/sh

# the git clone of the gist where I publish my routines
# I made it by a:
# git clone git@gist.github.com:$GIST_ID.git $LOCAL_GIST
# Its URL being https://gist.github.com/ColasNahaboo/$GIST_ID 
LOCAL_GIST="$HOME/git/walkpadspeed-colas-routines"

GR="$PWD"
cd "$LOCAL_GIST" || exit 1
cp "$GR"/docs/colas-routines.txt gistfile1.txt

git commit -am "Updated routines $(date -Is)"
git push
