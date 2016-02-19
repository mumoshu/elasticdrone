FROM node:5.4.0

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package.json /usr/src/app/
RUN npm install --production
COPY dist/cleanup.js /usr/src/app/cleanup.js
COPY dist/cleanup.js.map /usr/src/app/cleanup.js.map

CMD [ "npm", "start", "cleanup.js" ]
