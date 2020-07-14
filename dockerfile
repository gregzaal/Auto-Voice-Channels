# Pull Python 3 image
FROM python:3
# Set up ENVs for config.json
ENV admin_id admin_id
ENV client_id client_id
ENV log_timezone log_timezone
ENV token token
# Copy source code
COPY . /Auto-voice-channels
# Change working directory
WORKDIR /Auto-voice-channels
# Install pre prerequisites
RUN mkdir guilds \
    && pip3 install virtualenv \
    && python3 -m virtualenv bot-env \
    && . bot-env/bin/activate \
    && python3 -m pip install -r requirements.txt \
# Create json file based off ENV
    && ./docker/scripts/create-config.sh

CMD python3 auto-voice-channels.py
    