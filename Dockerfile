FROM python:3

ADD . /

RUN pip install discord.py
RUN pip install pytz
RUN pip install psutil
RUN pip install requests
RUN pip3 install virtualenv
RUN python3 -m virtualenv bot-env
RUN . bot-env/bin/activate
CMD [ "python", "./auto-voice-channels.py" ]
