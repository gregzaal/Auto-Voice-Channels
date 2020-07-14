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
    && python3 -m pip install -r requirements.txt

#create config file based on ENVs and run bot
CMD ./docker/scripts/create-config.sh && python3 auto-voice-channels.py
    