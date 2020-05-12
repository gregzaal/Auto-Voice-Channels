#!/bin/bash

cd ~/Auto-Voice-Channels
. bot-env/bin/activate
python3 backup.py >> log$1.txt
